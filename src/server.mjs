import http from 'node:http';
import { createPreviewHandler } from './handler.mjs';

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

const host = process.env.PREVIEW_HOST || '127.0.0.1';
const port = Number(process.env.PREVIEW_PORT || 4300);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PREVIEW_PORT is invalid');

const handler = createPreviewHandler({
    registryPath: required('PREVIEW_REGISTRY_PATH'),
    bundlesRoot: required('PREVIEW_BUNDLES_ROOT'),
    publicOrigin: required('PREVIEW_PUBLIC_ORIGIN'),
    adminOrigin: required('PREVIEW_ADMIN_ORIGIN'),
});

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`);
    const webRequest = new Request(url, { method: request.method, headers: request.headers });
    const result = await handler(webRequest);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (request.method === 'HEAD') response.end();
    else response.end(Buffer.from(await result.arrayBuffer()));
});

server.listen(port, host, () => console.log(`Preview service listening on http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
