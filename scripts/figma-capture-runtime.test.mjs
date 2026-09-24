import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  FIGMA_CAPTURE_RUNTIME_PATH,
  captureRuntimeEnvironment,
  captureRuntimeUrl,
  createCaptureRuntimeIdentity,
  createCaptureRuntimeVitePlugin,
  verifyCaptureRuntime,
} from './lib/figma-capture-runtime.mjs';

async function runtimeServer(t, identity) {
  let middleware = null;
  createCaptureRuntimeVitePlugin(captureRuntimeEnvironment(identity)).configureServer({
    middlewares: {
      use(path, handler) {
        assert.equal(path, FIGMA_CAPTURE_RUNTIME_PATH);
        middleware = handler;
      },
    },
  });
  const server = createServer((request, response) => {
    if (request.url !== FIGMA_CAPTURE_RUNTIME_PATH) {
      response.statusCode = 404;
      response.end();
      return;
    }
    middleware(request, response, () => {
      response.statusCode = 404;
      response.end();
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test('attests one nonce-bound capture runtime for the exact source fingerprint', async (t) => {
  const sourceFingerprint = 'a'.repeat(64);
  const identity = createCaptureRuntimeIdentity(sourceFingerprint);
  const baseUrl = await runtimeServer(t, identity);
  const evidence = await verifyCaptureRuntime({
    baseUrl,
    identity,
    currentSourceFingerprint: sourceFingerprint,
  });
  assert.equal(evidence.sourceFingerprint, sourceFingerprint);
  assert.equal(evidence.endpoint, `${baseUrl}${FIGMA_CAPTURE_RUNTIME_PATH}`);
  assert.match(evidence.nonceSha256, /^[a-f0-9]{64}$/);
});

test('rejects stale source state and an unrelated runtime nonce', async (t) => {
  const sourceFingerprint = 'b'.repeat(64);
  const identity = createCaptureRuntimeIdentity(sourceFingerprint);
  const baseUrl = await runtimeServer(t, identity);
  await assert.rejects(
    verifyCaptureRuntime({
      baseUrl,
      identity,
      currentSourceFingerprint: 'c'.repeat(64),
    }),
    /different workspace state/
  );
  await assert.rejects(
    verifyCaptureRuntime({
      baseUrl,
      identity: createCaptureRuntimeIdentity(sourceFingerprint),
      currentSourceFingerprint: sourceFingerprint,
    }),
    /HTTP 403/
  );
});

test('capture runtime URL must be an origin, not an arbitrary application path', () => {
  assert.throws(
    () => captureRuntimeUrl('http://127.0.0.1:4173/unrelated'),
    /must be an HTTP\(S\) origin/
  );
  assert.equal(
    captureRuntimeUrl('http://127.0.0.1:4173').toString(),
    `http://127.0.0.1:4173${FIGMA_CAPTURE_RUNTIME_PATH}`
  );
});
