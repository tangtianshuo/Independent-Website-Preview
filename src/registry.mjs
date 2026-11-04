import { readFile } from 'node:fs/promises';

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;

const recordKeys = [
    'id', 'version', 'manifestChecksum', 'sourceCommit', 'bundleDigest',
    'artifactDigest', 'bundlePath', 'adapterVersion', 'protocolVersion', 'status',
];

function object(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validPreviewRecord(value) {
    if (!object(value) || Object.keys(value).some(key => !recordKeys.includes(key)) ||
        Object.keys(value).length !== recordKeys.length) return false;
    return idPattern.test(String(value.id || '')) &&
        versionPattern.test(String(value.version || '')) &&
        digestPattern.test(String(value.manifestChecksum || '')) &&
        commitPattern.test(String(value.sourceCommit || '')) &&
        digestPattern.test(String(value.bundleDigest || '')) &&
        digestPattern.test(String(value.artifactDigest || '')) &&
        typeof value.bundlePath === 'string' &&
        value.bundlePath === `templates/${value.id}/${value.version}` &&
        typeof value.adapterVersion === 'string' && /^[1-9]\d*$/.test(value.adapterVersion) &&
        value.protocolVersion === 1 &&
        value.status === 'available';
}

export function validatePreviewRegistry(value) {
    if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.records) ||
        Object.keys(value).some(key => !['schemaVersion', 'records'].includes(key))) {
        throw new Error('Invalid preview registry');
    }
    const identities = new Set();
    for (const record of value.records) {
        if (!validPreviewRecord(record)) throw new Error('Invalid preview registry record');
        const identity = `${record.id}@${record.version}`;
        if (identities.has(identity)) throw new Error(`Duplicate preview renderer: ${identity}`);
        identities.add(identity);
    }
    return value;
}

export function resolvePreviewRecord(registry, id, version) {
    validatePreviewRegistry(registry);
    if (!idPattern.test(id) || !versionPattern.test(version)) return null;
    return registry.records.find(record => record.id === id && record.version === version) || null;
}

export async function readPreviewRegistry(path) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (cause) {
        throw new Error(`Cannot read preview registry: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return validatePreviewRegistry(parsed);
}

export function publicPreviewDescriptor(record, publicOrigin) {
    if (!validPreviewRecord(record)) throw new Error('Invalid preview renderer record');
    return {
        templateId: record.id,
        templateVersion: record.version,
        protocolVersion: record.protocolVersion,
        digest: record.bundleDigest,
        url: `${publicOrigin}/preview/${record.id}/${record.version}/`,
    };
}
