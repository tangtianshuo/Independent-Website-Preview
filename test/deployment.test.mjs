import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { installBundle } from "../ops/install-bundle.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));

test(
  "actual TLS edge preserves approved identities, framing, no-store/noindex and immutable hash bytes",
  { skip: process.env.B3_EDGE_DOCKER !== "1", timeout: 60000 },
  async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "b3-preview-edge-"));
    const owned = [];
    const docker = (args) =>
      execFileSync("docker", args, { encoding: "utf8" }).trim();
    const name = "b3-edge-" + randomUUID().slice(0, 10);
    const origin = "https://127.0.0.1:18093";
    try {
      const source = process.env.B3_APPROVED_ARTIFACTS;
      if (!source) throw new Error("Approved B2 artifact directory required");
      const identities = JSON.parse(
        await readFile(path.join(source, "local-identities.json"), "utf8"),
      );
      const registryPath = path.join(fixture, "registry/preview/index.json"),
        bundlesRoot = path.join(fixture, "bundles");
      for (const item of identities) {
        const record = {
          id: item.id,
          version: item.version,
          manifestChecksum: item.manifestChecksum,
          sourceCommit: item.sourceCommit,
          bundleDigest: item.bundleDigest,
          artifactDigest: item.localOciManifestDigest,
          bundlePath: `templates/${item.id}/${item.version}`,
          adapterVersion: "1",
          protocolVersion: 1,
          status: "available",
        };
        await installBundle({
          stagingDir: path.join(source, `${item.id}-${item.version}/bundle`),
          registryPath,
          bundlesRoot,
          record,
        });
      }
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          path.join(fixture, "edge.key"),
          "-out",
          path.join(fixture, "edge.crt"),
          "-days",
          "1",
          "-subj",
          "/CN=127.0.0.1",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
        ],
        { stdio: "ignore" },
      );
      await writeFile(
        path.join(fixture, "nginx.conf"),
        `events {}\nhttp { server { listen 18093 ssl; ssl_certificate /data/edge.crt; ssl_certificate_key /data/edge.key; include /data/edge.locations.conf; } }\n`,
      );
      await writeFile(
        path.join(fixture, "edge.locations.conf"),
        await readFile(path.join(root, "ops/preview.nginx.conf")),
      );
      const service = docker([
        "run",
        "--pull=never",
        "-d",
        "--name",
        name,
        "-p",
        "127.0.0.1:18093:18093",
        "-v",
        fixture + ":/data:ro",
        "-v",
        path.join(root, "src") + ":/app/src:ro",
        "-e",
        "PREVIEW_HOST=0.0.0.0",
        "-e",
        "PREVIEW_PUBLIC_ORIGIN=" + origin,
        "-e",
        "PREVIEW_ADMIN_ORIGIN=https://cms.example.com",
        "-e",
        "PREVIEW_REGISTRY_PATH=/data/registry/preview/index.json",
        "-e",
        "PREVIEW_BUNDLES_ROOT=/data/bundles",
        "node:22-bookworm",
        "node",
        "/app/src/server.mjs",
      ]);
      owned.push(service);
      const edge = docker([
        "run",
        "--pull=never",
        "-d",
        "--name",
        name + "-nginx",
        "--network",
        "container:" + service,
        "-v",
        fixture + ":/data:ro",
        "nginx:latest",
        "nginx",
        "-c",
        "/data/nginx.conf",
        "-g",
        "daemon off;",
      ]);
      owned.push(edge);
      docker(["exec", edge, "nginx", "-t", "-c", "/data/nginx.conf"]);
      const ca = await readFile(path.join(fixture, "edge.crt"));
      const request = (pathname) =>
        new Promise((resolve, reject) => {
          https
            .get(
              origin + pathname,
              {
                ca,
                headers: {
                  Origin: "https://untrusted.invalid",
                  "X-Forwarded-Host": "untrusted.invalid",
                },
              },
              (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () =>
                  resolve({
                    status: response.statusCode,
                    headers: response.headers,
                    bytes: Buffer.concat(chunks),
                  }),
                );
              },
            )
            .on("error", reject);
        });
      let ready = false;
      for (let i = 0; i < 50; i++) {
        try {
          ready = (await request("/health-check")).status === 200;
          if (ready) break;
        } catch {}
        await delay(100);
      }
      assert.equal(ready, true);
      const proof = [];
      for (const item of identities) {
        const resolver = await request(
          `/api/v1/renderers/${item.id}/${item.version}`,
        );
        assert.equal(resolver.status, 200);
        const descriptor = JSON.parse(resolver.bytes);
        assert.equal(descriptor.templateId, item.id);
        assert.equal(descriptor.templateVersion, item.version);
        assert.equal(descriptor.digest, item.bundleDigest);
        assert.equal(
          descriptor.url,
          origin + `/preview/${item.id}/${item.version}/`,
        );
        const html = await request(new URL(descriptor.url).pathname);
        assert.equal(html.status, 200);
        assert.equal(html.headers["cache-control"], "no-store");
        assert.match(html.headers["x-robots-tag"], /noindex/);
        assert.match(
          html.headers["content-security-policy"],
          /frame-ancestors https:\/\/cms\.example\.com/,
        );
        assert.equal(
          html.headers["content-security-policy"].includes("untrusted.invalid"),
          false,
        );
        assert.match(
          html.headers["content-security-policy"],
          /connect-src 'none'/,
        );
        const record = JSON.parse(
          await readFile(
            path.join(
              bundlesRoot,
              item.id,
              item.version,
              "preview-bundle.json",
            ),
            "utf8",
          ),
        );
        const hashed = record.files.find((file) =>
          /^_nuxt\/.+\.(js|css)$/.test(file.path),
        );
        const asset = await request(
          `/preview/${item.id}/${item.version}/${hashed.path}`,
        );
        assert.equal(asset.status, 200);
        assert.match(asset.headers["cache-control"], /immutable/);
        assert.deepEqual(
          asset.bytes,
          await readFile(
            path.join(bundlesRoot, item.id, item.version, hashed.path),
          ),
        );
        proof.push({
          id: item.id,
          version: item.version,
          bundleDigest: item.bundleDigest,
          artifactDigest: item.localOciManifestDigest,
          scope: "approved-B2-local-OCI-bytes-through-isolated-TLS-edge",
          tlsVerifiedWithExplicitThrowawayCA: true,
          htmlNoStoreNoindex: true,
          exactFrameAncestor: true,
          hashAssetImmutableAndByteIdentical: true,
        });
      }
      assert.equal(
        (await request("/api/v1/renderers/missing/9.9.9")).status,
        404,
      );
      const summary = {
        scope: "local-edge-not-production-or-authoritative-DNS",
        proof,
        images: owned.map((id) => JSON.parse(docker(["inspect", id]))[0].Image),
      };
      if (process.env.B3_EDGE_EVIDENCE)
        await writeFile(
          process.env.B3_EDGE_EVIDENCE,
          JSON.stringify(summary, null, 2),
        );
    } finally {
      for (const id of owned.reverse()) docker(["rm", "-f", id]);
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
