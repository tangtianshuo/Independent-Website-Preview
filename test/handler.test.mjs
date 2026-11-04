import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createPreviewHandler } from '../src/handler.mjs';

const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const entry = (path, value) => ({ path, size: Buffer.byteLength(value), checksum: createHash('sha256').update(value).digest('hex') });
const record = {
    id: 'fireguard', version: '1.0.0',
    manifestChecksum: `sha256:${'a'.repeat(64)}`, sourceCommit: 'b'.repeat(40),
    bundleDigest: `sha256:${'c'.repeat(64)}`,
    artifactDigest: `sha256:${'e'.repeat(64)}`,
    bundlePath: 'templates/fireguard/1.0.0', adapterVersion: '1', protocolVersion: 1, status: 'available',
};

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'preview-service-'));
    const registryPath = join(root, 'preview.json');
    const bundlesRoot = join(root, 'bundles');
    await mkdir(join(bundlesRoot, 'fireguard', '1.0.0', '_nuxt'), { recursive: true });
    await writeFile(registryPath, JSON.stringify({ schemaVersion: 1, records: [record] }));
    const html = '<!doctype html><div id="preview"></div>';
    const script = 'console.log("preview")';
    const manifest = { templateId: 'fireguard', templateVersion: '1.0.0', bundleDigest: record.bundleDigest, protocolVersion: 1,
        files: [entry('index.html', html), entry('_nuxt/app.js', script)] };
    await writeFile(join(bundlesRoot, 'fireguard', '1.0.0', 'preview-bundle.json'), JSON.stringify(manifest));
    await writeFile(join(bundlesRoot, 'fireguard', '1.0.0', 'index.html'), html);
    await writeFile(join(bundlesRoot, 'fireguard', '1.0.0', '_nuxt', 'app.js'), script);
    const handler = createPreviewHandler({
        registryPath, bundlesRoot,
        publicOrigin: 'https://preview.example.com',
        adminOrigin: 'https://cms.example.com',
    });
    return { root, handler };
}

test('resolves a versioned renderer and serves its immutable static bundle', async t => {
    const { root, handler } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const resolved = await handler(new Request('https://preview.example.com/api/v1/renderers/fireguard/1.0.0'));
    assert.equal(resolved.status, 200);
    assert.deepEqual(await resolved.json(), {
        templateId: 'fireguard', templateVersion: '1.0.0', protocolVersion: 1,
        digest: record.bundleDigest,
        url: 'https://preview.example.com/preview/fireguard/1.0.0/',
    });
    const html = await handler(new Request('https://preview.example.com/preview/fireguard/1.0.0/'));
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-security-policy'), /frame-ancestors https:\/\/cms\.example\.com/);
    assert.equal(html.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    assert.equal(html.headers.get('cache-control'), 'no-store');
    assert.match(await html.text(), /id="preview"/);
    const asset = await handler(new Request('https://preview.example.com/preview/fireguard/1.0.0/_nuxt/app.js'));
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control'), /immutable/);
    await writeFile(join(root, 'bundles', 'fireguard', '1.0.0', '_nuxt', 'app.js'), 'tampered');
    assert.equal((await handler(new Request('https://preview.example.com/preview/fireguard/1.0.0/_nuxt/app.js'))).status, 404);
});

test('fails closed for unknown versions, traversal, bad registry and unexpected methods', async t => {
    const { root, handler } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    assert.equal((await handler(new Request('https://preview.example.com/api/v1/renderers/fireguard/1.0.1'))).status, 404);
    for (const path of [
        '/preview/fireguard/1.0.0/../secret',
        '/preview/fireguard/1.0.0/%2e%2e/secret',
        '/preview/missing/1.0.0/',
    ]) assert.equal((await handler(new Request(`https://preview.example.com${path}`))).status, 404);
    assert.equal((await handler(new Request('https://preview.example.com/api/v1/renderers/fireguard/1.0.0', { method: 'POST' }))).status, 405);
    await writeFile(join(root, 'preview.json'), JSON.stringify({ schemaVersion: 1, records: [{ ...record, bundlePath: '../escape' }] }));
    assert.equal((await handler(new Request('https://preview.example.com/api/v1/renderers'))).status, 503);
});
