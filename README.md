# Independent Website Preview

One private-preview host for all immutable template versions.

## Runtime contract

- `GET /api/v1/renderers` lists registered template versions.
- `GET /api/v1/renderers/{id}/{version}` resolves the registered iframe URL.
- `GET /preview/{id}/{version}/` serves the immutable preview bundle.
- `GET /health-check` reports registry health.

The service only serves approved registry records. HTML is never cached, cannot be indexed,
and can only be framed by `PREVIEW_ADMIN_ORIGIN`. Hashed static files are cached immutably.

Preview payloads never reach this service. Templates receive CMS snapshots through the
existing origin-checked `postMessage` protocol and keep them in memory only.

## Local run

```sh
npm test
PREVIEW_REGISTRY_PATH=/path/to/preview/index.json \
PREVIEW_BUNDLES_ROOT=/path/to/bundles \
PREVIEW_PUBLIC_ORIGIN=https://preview.example.com \
PREVIEW_ADMIN_ORIGIN=https://cms.example.com \
npm start
```

Bundle directories are content-addressed by the registry record. `artifactDigest` selects
the immutable OCI artifact; `bundleDigest` validates the unpacked files. Registry updates must be
atomic, and a bundle must contain `preview-bundle.json` with matching template identity and
digest before it can be served.

Use `ops/sync-bundle.sh TEMPLATE_ID VERSION OCI_DIGEST` on the deployment host to pull and
install one approved artifact. It refuses to overwrite an existing template version.
