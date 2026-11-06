#!/usr/bin/env bash
set -euo pipefail

# The approved record is supplied separately from the OCI download. Do not derive
# trust from the downloaded archive or expose registry visibility before install.
record_path=${1:?approved preview registry record JSON path is required}
bundles_root=${PREVIEW_BUNDLES_ROOT:?PREVIEW_BUNDLES_ROOT is required}
: "${PREVIEW_REGISTRY_PATH:?PREVIEW_REGISTRY_PATH is required}"
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
identity=$(node --input-type=module - "$record_path" "$script_directory" <<'NODE'
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [path, directory] = process.argv.slice(2);
const { validPreviewRecord } = await import(pathToFileURL(`${directory}/../src/registry.mjs`));
const record = JSON.parse(await readFile(path, 'utf8'));
if (!validPreviewRecord(record)) throw new Error('Invalid approved preview record');
console.log(`${record.id}@${record.artifactDigest}`);
NODE
)
mkdir -p "$bundles_root"
directory=$(mktemp -d "$bundles_root/.download-XXXXXX")
trap 'rm -rf -- "$directory"' EXIT
mkdir "$directory/archive" "$directory/bundle"
repository="ghcr.io/tangtianshuo/independent-website-preview-bundles/${identity%%@*}"
oras pull "${repository}@${identity#*@}" --output "$directory/archive"
node "$script_directory/install-bundle.mjs" "$directory/archive/preview-bundle.tar.gz" "$directory/bundle" "$record_path"
