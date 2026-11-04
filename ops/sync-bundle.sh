#!/usr/bin/env bash
set -euo pipefail

template_id=${1:?template id is required}
template_version=${2:?template version is required}
artifact_digest=${3:?OCI artifact digest is required}
bundles_root=${PREVIEW_BUNDLES_ROOT:?PREVIEW_BUNDLES_ROOT is required}

[[ "$template_id" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]
[[ "$template_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$artifact_digest" =~ ^sha256:[a-f0-9]{64}$ ]]

directory=$(mktemp -d)
trap 'rm -rf "$directory"' EXIT
repository="ghcr.io/tangtianshuo/independent-website-preview-bundles/${template_id}"
oras pull "${repository}@${artifact_digest}" --output "$directory"
mkdir "$directory/bundle"
tar -xzf "$directory/preview-bundle.tar.gz" -C "$directory/bundle"

node --input-type=module - "$directory/bundle/preview-bundle.json" "$template_id" "$template_version" <<'NODE'
import { readFile } from 'node:fs/promises';
const [path, id, version] = process.argv.slice(2);
const value = JSON.parse(await readFile(path, 'utf8'));
if (value.templateId !== id || value.templateVersion !== version || value.protocolVersion !== 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(value.bundleDigest || '')) {
  throw new Error('Preview bundle identity is invalid');
}
NODE

target="${bundles_root}/${template_id}/${template_version}"
if [[ -e "$target" ]]; then
  echo "Preview bundle target already exists: $target" >&2
  exit 1
fi
mkdir -p "$(dirname "$target")"
mv "$directory/bundle" "$target"
