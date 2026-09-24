import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const FIGMA_CAPTURE_RUNTIME_PATH = '/.well-known/figma-capture-runtime';
export const FIGMA_CAPTURE_RUNTIME_KIND = 'figmoon-capture-runtime';
export const FIGMA_CAPTURE_RUNTIME_SCHEMA_VERSION = 1;
export const FIGMA_CAPTURE_RUNTIME_NONCE_ENV = 'FIGMA_CAPTURE_RUNTIME_NONCE';
export const FIGMA_CAPTURE_SOURCE_FINGERPRINT_ENV = 'FIGMA_CAPTURE_SOURCE_FINGERPRINT';

const SHA256_RE = /^[a-f0-9]{64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validateSourceFingerprint(value) {
  if (!SHA256_RE.test(value ?? '')) {
    throw new Error('Figma capture runtime requires a valid workspace source fingerprint.');
  }
  return value;
}

function validateNonce(value) {
  if (!NONCE_RE.test(value ?? '')) {
    throw new Error('Figma capture runtime requires a fresh 256-bit nonce.');
  }
  return value;
}

function headerValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left ?? '');
  const rightBuffer = Buffer.from(right ?? '');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createCaptureRuntimeIdentity(sourceFingerprint) {
  return {
    nonce: randomBytes(32).toString('base64url'),
    sourceFingerprint: validateSourceFingerprint(sourceFingerprint),
  };
}

export function captureRuntimeEnvironment(identity) {
  return {
    [FIGMA_CAPTURE_RUNTIME_NONCE_ENV]: validateNonce(identity?.nonce),
    [FIGMA_CAPTURE_SOURCE_FINGERPRINT_ENV]: validateSourceFingerprint(identity?.sourceFingerprint),
  };
}

export function captureRuntimeIdentityFromEnvironment(environment = process.env) {
  const nonce = environment[FIGMA_CAPTURE_RUNTIME_NONCE_ENV];
  const sourceFingerprint = environment[FIGMA_CAPTURE_SOURCE_FINGERPRINT_ENV];
  if (!nonce && !sourceFingerprint) return null;
  if (!nonce || !sourceFingerprint) {
    throw new Error(
      `Both ${FIGMA_CAPTURE_RUNTIME_NONCE_ENV} and ${FIGMA_CAPTURE_SOURCE_FINGERPRINT_ENV} are required for a shared capture runtime.`
    );
  }
  return {
    nonce: validateNonce(nonce),
    sourceFingerprint: validateSourceFingerprint(sourceFingerprint),
  };
}

export function captureRuntimeUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('PLAYWRIGHT_BASE_URL must be a valid HTTP(S) origin.');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !['', '/'].includes(parsed.pathname)
  ) {
    throw new Error(
      'PLAYWRIGHT_BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment.'
    );
  }
  return new URL(FIGMA_CAPTURE_RUNTIME_PATH, parsed.origin);
}

export async function verifyCaptureRuntime({
  baseUrl,
  identity,
  currentSourceFingerprint,
  timeoutMilliseconds = 15_000,
}) {
  const expected = {
    nonce: validateNonce(identity?.nonce),
    sourceFingerprint: validateSourceFingerprint(identity?.sourceFingerprint),
  };
  if (expected.sourceFingerprint !== validateSourceFingerprint(currentSourceFingerprint)) {
    throw new Error(
      'The shared visual runtime was started from a different workspace state. Restart it before capture.'
    );
  }

  const endpoint = captureRuntimeUrl(baseUrl);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'x-figma-capture-runtime-nonce': expected.nonce,
      },
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch (error) {
    throw new Error(
      `Unable to attest the visual capture runtime: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!response.ok) {
    throw new Error(`Visual capture runtime attestation failed with HTTP ${response.status}.`);
  }
  if (!response.headers.get('cache-control')?.toLowerCase().includes('no-store')) {
    throw new Error('Visual capture runtime attestation response was cacheable.');
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Visual capture runtime returned invalid attestation JSON.');
  }
  const expectedNonceHash = sha256(expected.nonce);
  if (
    payload?.schemaVersion !== FIGMA_CAPTURE_RUNTIME_SCHEMA_VERSION ||
    payload?.kind !== FIGMA_CAPTURE_RUNTIME_KIND ||
    payload?.sourceFingerprint !== expected.sourceFingerprint ||
    payload?.nonceSha256 !== expectedNonceHash
  ) {
    throw new Error('Visual capture runtime attestation did not match this capture request.');
  }

  return {
    endpoint: endpoint.toString(),
    sourceFingerprint: expected.sourceFingerprint,
    nonceSha256: expectedNonceHash,
  };
}

export function createCaptureRuntimeVitePlugin(environment = process.env) {
  const identity = captureRuntimeIdentityFromEnvironment(environment);
  return {
    name: 'figma-capture-runtime-attestation',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(FIGMA_CAPTURE_RUNTIME_PATH, (request, response, next) => {
        if (!identity) {
          next();
          return;
        }
        if (request.method !== 'GET') {
          response.statusCode = 405;
          response.setHeader('Allow', 'GET');
          response.end();
          return;
        }
        const suppliedNonce = headerValue(request.headers['x-figma-capture-runtime-nonce']);
        if (!constantTimeEqual(suppliedNonce, identity.nonce)) {
          response.statusCode = 403;
          response.setHeader('Cache-Control', 'no-store, max-age=0');
          response.setHeader('Pragma', 'no-cache');
          response.end();
          return;
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store, max-age=0');
        response.setHeader('Pragma', 'no-cache');
        response.setHeader('Expires', '0');
        response.end(
          JSON.stringify({
            schemaVersion: FIGMA_CAPTURE_RUNTIME_SCHEMA_VERSION,
            kind: FIGMA_CAPTURE_RUNTIME_KIND,
            sourceFingerprint: identity.sourceFingerprint,
            nonceSha256: sha256(identity.nonce),
          })
        );
      });
    },
  };
}
