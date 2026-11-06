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

On the deployment host, provide one approved registry record as a JSON object from the
trusted release checkout, separately from the downloaded artifact:

```sh
PREVIEW_REGISTRY_PATH=/path/to/local/preview/index.json \
PREVIEW_BUNDLES_ROOT=/path/to/bundles \
ops/sync-bundle.sh /path/to/approved-record.json
```

The command pulls the exact `artifactDigest`, rejects unsafe archives and links, verifies
all file sizes/checksums plus the bundle digest and source/manifest identity, and installs
into the target filesystem. Existing identical state is unchanged; conflicting versions
are never replaced. The installer serializes directory installation and registry updates.
It renames a complete verified directory first, then atomically renames the registry file.
A process interruption between those phases may leave an unreferenced verified directory;
a retry validates it again before registering it. This is recoverable two-phase visibility,
not a single atomic rename spanning the bundle directory and registry.

New installations require `sourceCommit` and `manifestChecksum` inside the bundle manifest.
Already approved original schema-1 bundles remain readable with their exact trusted registry
identity, canonical file-list digest and per-file verification. A partially supplied or
mismatching provenance pair is rejected; old immutable bundles are never rewritten.

## Deployment within the existing TLS host

Use `ops/preview.compose.yml` with the approved immutable `PREVIEW_IMAGE=image@sha256:…`,
`PREVIEW_APPROVED_ROOT` (containing `registry/preview/index.json` and `bundles/`),
`PREVIEW_PUBLIC_ORIGIN` and `PREVIEW_ADMIN_ORIGIN`. Both origins must match the approved
registry/bundle configuration. The service binds only `127.0.0.1:4300`, drops Linux
capabilities and mounts approved content read-only. Validate without printing secrets:

```sh
docker compose --env-file /private/preview.env -f ops/preview.compose.yml config --quiet
```

Include `ops/preview.nginx.conf` inside the existing approved HTTPS server block. It
proxies health, resolver and immutable preview routes to the local service while
preserving the service's CSP, no-store/noindex HTML and immutable asset policies.
Use the existing DNS/certificate workflow; this file does not provision either.
Configure CMS `STOREFRONT_PREVIEW_SERVICE_URL` and
`STOREFRONT_PREVIEW_PUBLIC_ORIGIN` together. Unconfigured CMS preview keeps only
`frame-src 'self'`; a configured service requires a valid explicit public origin.

`B3_EDGE_DOCKER=1 node --test test/deployment.test.mjs` exercises the actual stock-nginx
TLS edge and Preview source against approved B2 bundles when the controller-provided
fixture directory is present. It verifies both exact template identities, bundle
hashes, HTML CSP/cache and hashed asset bytes. TLS uses an explicitly trusted throwaway
certificate in the test client, without modifying global trust. Ordinary `npm test`
reports the environment-dependent edge check as skipped. This local test does not
claim production DNS, publication or a complete PlatformLock acceptance result.
