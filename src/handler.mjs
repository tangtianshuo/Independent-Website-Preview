import { createHash } from 'node:crypto';
import { readFile, realpath, stat, lstat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { readPreviewRegistry, resolvePreviewRecord, publicPreviewDescriptor, validBundleManifest } from './registry.mjs';

const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

function origin(value, label) {
    let parsed;
    try { parsed = new URL(value); }
    catch { throw new Error(`${label} must be an origin`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value ||
        parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error(`${label} must be a canonical HTTP(S) origin`);
    }
    return value;
}

function headers(config) {
    return {
        'Content-Security-Policy': [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https:",
            "font-src 'self' data:",
            "connect-src 'none'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            `frame-ancestors ${config.adminOrigin}`,
        ].join('; '),
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
    };
}

function json(value, status = 200, extra = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
    });
}

async function bundleFile(config, record, relative) {
    if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) return null;
    const root = await realpath(resolve(config.bundlesRoot)).catch(() => null);
    if (!root) return null;
    const file = resolve(root, record.id, record.version, relative);
    if (!file.startsWith(`${root}${sep}`)) return null;
    try {
        let current = root;
        for (const part of [record.id, record.version, ...relative.split('/')]) {
            current = resolve(current, part);
            if ((await lstat(current)).isSymbolicLink()) return null;
        }
        if ((await lstat(resolve(root,record.id,record.version,'preview-bundle.json'))).isSymbolicLink()) return null;
        const physical = await realpath(file);
        if (!physical.startsWith(`${root}${sep}`)) return null;
        const metadata = await stat(file);
        if (!metadata.isFile() || metadata.nlink !== 1) return null;
        const bytes = await readFile(file);
        const manifestPath = await realpath(resolve(root, record.id, record.version, 'preview-bundle.json')).catch(() => null);
        if (!manifestPath || !manifestPath.startsWith(`${root}${sep}`)) return null;
        const manifestBytes = await readFile(manifestPath);
        if (!manifestBytes) return null;
        let manifest;
        try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
        catch { return null; }
        if (!validBundleManifest(manifest, record)) return null;
        if (relative !== 'preview-bundle.json') {
            const expected = manifest.files.find(entry => entry?.path === relative);
            const checksum = createHash('sha256').update(bytes).digest('hex');
            if (!expected || expected.checksum !== checksum || expected.size !== bytes.byteLength) return null;
        }
        return { bytes, file };
    } catch { return null; }
}

export function createPreviewHandler(options) {
    const config = {
        registryPath: resolve(options.registryPath),
        bundlesRoot: resolve(options.bundlesRoot),
        publicOrigin: origin(options.publicOrigin, 'PREVIEW_PUBLIC_ORIGIN'),
        adminOrigin: origin(options.adminOrigin, 'PREVIEW_ADMIN_ORIGIN'),
    };
    const security = headers(config);
    return async function handle(request) {
        const url = new URL(request.url);
        if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method_not_allowed' }, 405);
        try {
            if (url.pathname === '/health-check') {
                const registry = await readPreviewRegistry(config.registryPath);
                return json({ ok: true, renderers: registry.records.length }, 200, security);
            }
            if (url.pathname === '/api/v1/renderers') {
                const registry = await readPreviewRegistry(config.registryPath);
                return json({ items: registry.records.map(record => publicPreviewDescriptor(record, config.publicOrigin)) }, 200, security);
            }
            const resolver = url.pathname.match(/^\/api\/v1\/renderers\/([^/]+)\/([^/]+)$/);
            if (resolver) {
                const registry = await readPreviewRegistry(config.registryPath);
                const record = resolvePreviewRecord(registry, decodeURIComponent(resolver[1]), decodeURIComponent(resolver[2]));
                return record ? json(publicPreviewDescriptor(record, config.publicOrigin), 200, security)
                    : json({ error: 'renderer_not_found' }, 404, security);
            }
            const asset = url.pathname.match(/^\/preview\/([^/]+)\/([^/]+)\/(.*)$/);
            if (!asset) return json({ error: 'not_found' }, 404, security);
            const registry = await readPreviewRegistry(config.registryPath);
            const record = resolvePreviewRecord(registry, decodeURIComponent(asset[1]), decodeURIComponent(asset[2]));
            if (!record) return json({ error: 'renderer_not_found' }, 404, security);
            const requested = asset[3] || 'index.html';
            const relative = requested.endsWith('/') || !extname(requested) ? `${requested.replace(/\/$/, '')}/index.html`.replace(/^\//, '') : requested;
            const found = await bundleFile(config, record, relative);
            if (!found) return json({ error: 'asset_not_found' }, 404, security);
            const isHtml = extname(found.file) === '.html';
            const responseHeaders = {
                ...security,
                'content-type': mimeTypes[extname(found.file)] || 'application/octet-stream',
                'cache-control': isHtml ? 'no-store' : 'public, max-age=31536000, immutable',
            };
            return new Response(request.method === 'HEAD' ? null : found.bytes, { status: 200, headers: responseHeaders });
        } catch (cause) {
            return json({ error: 'preview_service_unavailable', message: cause instanceof Error ? cause.message : 'Unknown preview service error' }, 503, security);
        }
    };
}
