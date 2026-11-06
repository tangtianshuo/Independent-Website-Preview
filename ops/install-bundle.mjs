import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { validPreviewRecord, validatePreviewRegistry } from '../src/registry.mjs';

const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = path => typeof path === 'string' && path.length > 0 && !path.includes('\\') && !path.includes('\0') && !path.split('/').some(part => !part || part === '.' || part === '..');
async function regularDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Bundle directory must be a real directory');
}
async function inventory(root, prefix = '') {
  const paths = [];
  await regularDirectory(join(root, prefix));
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (!safePath(path)) throw new Error('Unsafe bundle path');
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error('Bundle links are forbidden');
    if (info.isDirectory()) paths.push(...await inventory(root, path));
    else if (info.isFile() && info.nlink === 1) paths.push(path);
    else throw new Error('Bundle special files and hard links are forbidden');
  }
  return paths.sort();
}

export async function verifyBundle(stagingDir, record) {
  if (!validPreviewRecord(record)) throw new Error('Invalid preview record');
  const actual = await inventory(stagingDir);
  const manifest = JSON.parse(await readFile(join(stagingDir, 'preview-bundle.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.templateId !== record.id || manifest.templateVersion !== record.version || manifest.protocolVersion !== record.protocolVersion ||
      manifest.manifestChecksum !== record.manifestChecksum || manifest.sourceCommit !== record.sourceCommit || manifest.bundleDigest !== record.bundleDigest || !Array.isArray(manifest.files)) throw new Error('Bundle identity mismatch');
  const expected = manifest.files.map(entry => entry.path);
  if (!expected.includes('index.html') || expected.some(path => !safePath(path) || path === 'preview-bundle.json') ||
      new Set(expected).size !== expected.length || !isDeepStrictEqual(expected, [...expected].sort()) ||
      !isDeepStrictEqual(actual, [...expected, 'preview-bundle.json'].sort())) throw new Error('Bundle file inventory mismatch');
  if (`sha256:${checksum(JSON.stringify(manifest.files))}` !== record.bundleDigest) throw new Error('Bundle digest mismatch');
  for (const entry of manifest.files) {
    if (Object.keys(entry).length !== 3 || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.checksum)) throw new Error('Invalid bundle file entry');
    const bytes = await readFile(join(stagingDir, entry.path));
    if (bytes.length !== entry.size || checksum(bytes) !== entry.checksum) throw new Error(`Bundle file checksum mismatch: ${entry.path}`);
  }
  return manifest;
}

// Only the ustar files/directories produced by our release workflow are accepted.
// Validate the entire archive before writing anything; never delegate unsafe extraction to tar.
export async function extractBundleArchive({ archivePath, stagingDir }) {
  const compressed = await readFile(archivePath);
  if (compressed.length > 128 * 1024 * 1024) throw new Error('Preview archive is too large');
  const bytes = gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 });
  const entries = [], names = new Set();
  const field = (header, start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  const octal = value => { if (!/^[0-7]+$/.test(value.trim())) throw new Error('Invalid tar number'); return Number.parseInt(value.trim(), 8); };
  let offset = 0, ended = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) { ended = true; break; }
    const sum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (octal(field(header, 148, 8)) !== sum || field(header, 257, 6) !== 'ustar') throw new Error('Invalid ustar header');
    const type = field(header, 156, 1);
    if (!['', '0', '5'].includes(type) || field(header, 157, 100)) throw new Error('Archive links and special entries are forbidden');
    let path = [field(header, 345, 155), field(header, 0, 100)].filter(Boolean).join('/');
    if (path.startsWith('./')) path = path.slice(2);
    if (type === '5') path = path.replace(/\/$/, '');
    const size = octal(field(header, 124, 12));
    if (!Number.isSafeInteger(size) || (type === '5' && size !== 0) || offset + 512 + size > bytes.length) throw new Error('Invalid archive size');
    if (path && path !== '.') {
      if (!safePath(path) || names.has(path)) throw new Error('Unsafe or duplicate archive path');
      if (entries.length >= 10000) throw new Error('Archive has too many entries');
      names.add(path); entries.push({ path, directory: type === '5', bytes: bytes.subarray(offset + 512, offset + 512 + size) });
    } else if (type !== '5') throw new Error('Invalid archive root');
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended || bytes.subarray(offset).some(byte => byte !== 0)) throw new Error('Truncated or trailing archive data');
  const filePaths = new Set(entries.filter(entry => !entry.directory).map(entry => entry.path));
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      if (filePaths.has(parts.slice(0, depth).join('/'))) throw new Error('Archive file/directory collision');
    }
  }
  await regularDirectory(stagingDir);
  if ((await readdir(stagingDir)).length) throw new Error('Extraction staging directory is not empty');
  for (const entry of entries) {
    if (entry.directory) await mkdir(join(stagingDir, entry.path), { recursive: true });
    else { await mkdir(dirname(join(stagingDir, entry.path)), { recursive: true }); await writeFile(join(stagingDir, entry.path), entry.bytes, { flag: 'wx' }); }
  }
}

// Populate before rename so the shared lock directory is never born empty.
// To reap a dead owner, claim its exact filename first. A competing reaper cannot
// remove a subsequent live owner. Empty remnants are safely replaceable by rename.
async function acquireLock(root) {
  const lock = join(root, '.install.lock'), candidate = await mkdtemp(join(root, '.lock-candidate-'));
  const owner = `${process.pid}-${randomUUID()}`;
  await writeFile(join(candidate, owner), '');
  const deadline = Date.now() + 5000;
  try {
    while (true) {
      try { await rename(candidate, lock); break; }
      catch (cause) { if (!['EEXIST', 'ENOTEMPTY'].includes(cause.code)) throw cause; }
      for (const entry of await readdir(lock).catch(() => [])) {
        const pid = Number(entry.split('-')[0]);
        if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid install lock owner');
        try { process.kill(pid, 0); }
        catch (cause) {
          if (cause.code !== 'ESRCH') throw cause;
          try { await rename(join(lock, entry), join(candidate, `dead-${entry}`)); await rmdir(lock).catch(cause => { if (!['ENOENT','ENOTEMPTY'].includes(cause.code)) throw cause; }); await rm(join(candidate, `dead-${entry}`), { force: true }); }
          catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
        }
      }
      if (Date.now() >= deadline) throw new Error('Preview installation lock timeout');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } catch (cause) { await rm(candidate, { recursive: true, force: true }); throw cause; }
  return async () => {
    await rm(join(lock, owner), { force: true });
    await rmdir(lock).catch(cause => { if (!['ENOENT', 'ENOTEMPTY'].includes(cause.code)) throw cause; });
  };
}

export async function installBundle({ stagingDir, bundlesRoot, record, registryPath }) {
  if (!validPreviewRecord(record)) throw new Error('Invalid preview record');
  const root = resolve(bundlesRoot);
  await mkdir(root, { recursive: true }); await regularDirectory(root);
  const release = await acquireLock(root);
  let temporary, created = false;
  const target = join(root, record.id, record.version);
  try {
    await verifyBundle(stagingDir, record);
    let registry = { schemaVersion: 1, records: [] }, next = registry;
    if (registryPath) {
      try { registry = validatePreviewRegistry(JSON.parse(await readFile(registryPath, 'utf8'))); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      const old = registry.records.find(entry => entry.id === record.id && entry.version === record.version);
      if (old && !isDeepStrictEqual(old, record)) throw new Error('Published preview version conflict');
      next = old ? registry : { schemaVersion: 1, records: [...registry.records, record] };
    }
    await mkdir(join(root, record.id), { recursive: true }); await regularDirectory(join(root, record.id));
    let exists = false;
    try { await lstat(target); exists = true; } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    if (exists) {
      try { await verifyBundle(target, record); }
      catch (cause) { throw new Error('Installed preview version conflict', { cause }); }
      if (!isDeepStrictEqual(JSON.parse(await readFile(join(target,'preview-bundle.json'),'utf8')), JSON.parse(await readFile(join(stagingDir,'preview-bundle.json'),'utf8')))) throw new Error('Installed preview version conflict');
    } else {
      temporary = await mkdtemp(join(root, '.install-'));
      await cp(stagingDir, temporary, { recursive: true });
      await verifyBundle(temporary, record);
      await rename(temporary, target); temporary = undefined; created = true;
    }
    // Visibility is two-phase: an interrupted rename may leave a verified orphan.
    // Retrying revalidates that orphan, then publishes the registry atomically.
    if (registryPath && next !== registry) {
      await mkdir(dirname(registryPath), { recursive: true });
      const path = `${registryPath}.${randomUUID()}.tmp`;
      try { await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' }); await rename(path, registryPath); }
      finally { await rm(path, { force: true }); }
    }
    return created || next !== registry ? 'installed' : 'unchanged';
  } catch (cause) { if (created) await rm(target, { recursive: true, force: true }); throw cause; }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }); await release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archivePath, stagingDir, recordPath] = process.argv.slice(2);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  await extractBundleArchive({ archivePath, stagingDir });
  console.log(await installBundle({ stagingDir, bundlesRoot: process.env.PREVIEW_BUNDLES_ROOT, registryPath: process.env.PREVIEW_REGISTRY_PATH, record }));
}
