import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { getFigmoonConfig } from '../lib/config.mjs';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const __figmoonConfig = getFigmoonConfig();
const repoRoot = __figmoonConfig.consumerRoot;
const visionScript = join(scriptDir, 'figma-vision-inspect.mjs');
const testApiKey = 'test-only-key-not-a-real-secret';

function visionEnv(baseUrl, extra = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('FIGMA_VISION_')) delete environment[key];
  }
  return {
    ...environment,
    FIGMA_VISION_ENABLED: '1',
    FIGMA_VISION_API_KEY: testApiKey,
    FIGMA_VISION_BASE_URL: baseUrl,
    FIGMA_VISION_MODEL: 'gpt-5.6-luna',
    ...extra,
  };
}

function runVision(args, environment) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [visionScript, ...args], {
      cwd: repoRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'figmoon-vision-test-'));
  const imagePath = join(root, 'reference.png');
  const outputPath = join(root, 'vision.json');
  await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: '#ffffff',
    },
  })
    .png()
    .toFile(imagePath);
  return {
    imagePath,
    outputPath,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function startVisionServer(handleRequest) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const captured = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body,
    };
    requests.push(captured);
    await handleRequest({ request: captured, response, index: requests.length - 1 });
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock server did not expose a TCP port.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      await new Promise((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

function visionArgs(fixture, extra = []) {
  return [
    '--input',
    `reference=${fixture.imagePath}`,
    '--out',
    fixture.outputPath,
    '--max-parallel',
    '1',
    ...extra,
  ];
}

test('figma vision rejects HTTP before sending a request unless explicitly opted in', async () => {
  const fixture = await makeFixture();
  const mock = await startVisionServer(async ({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'unexpected' } }] }));
  });

  try {
    const result = await runVision(visionArgs(fixture), visionEnv(mock.baseUrl));

    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /Refusing plaintext vision transport/);
    assert.equal(mock.requests.length, 0);
    await assert.rejects(readFile(fixture.outputPath));
    assert.equal(result.stdout.includes(testApiKey), false);
    assert.equal(result.stderr.includes(testApiKey), false);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test('figma vision sends a Luna image request and retries a compatible token parameter', async () => {
  const fixture = await makeFixture();
  const mock = await startVisionServer(async ({ response, index }) => {
    if (index === 0) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { message: 'omitted output token parameter is unsupported by this local mock' },
        })
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'local mock evidence' } }] }));
  });

  try {
    const result = await runVision(
      visionArgs(fixture),
      visionEnv(mock.baseUrl, { FIGMA_VISION_ALLOW_INSECURE_HTTP: '1' })
    );
    const artifactText = await readFile(fixture.outputPath, 'utf8');
    const artifact = JSON.parse(artifactText);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(mock.requests.length, 2);
    assert.deepEqual(
      mock.requests.map((request) => request.url),
      ['/v1/chat/completions', '/v1/chat/completions']
    );
    assert.equal(mock.requests[0].method, 'POST');
    assert.equal(mock.requests[0].authorization, `Bearer ${testApiKey}`);
    assert.equal(mock.requests[0].body.model, 'gpt-5.6-luna');
    assert.equal('max_completion_tokens' in mock.requests[0].body, false);
    assert.equal('max_tokens' in mock.requests[0].body, false);
    assert.equal(mock.requests[1].body.max_tokens, 450);
    assert.equal('max_completion_tokens' in mock.requests[1].body, false);
    assert.deepEqual(
      mock.requests[0].body.messages[0].content.map((part) => part.type),
      ['text', 'image_url']
    );
    assert.match(mock.requests[0].body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(artifact.results[0].status, 'ok');
    assert.equal(artifact.results[0].tokenParam, 'max_tokens');
    assert.equal(artifact.results[0].attempts, 2);
    assert.equal(artifact.claim.includes('cannot establish Figma parity'), true);
    assert.equal(artifactText.includes(testApiKey), false);
    assert.equal(result.stdout.includes(testApiKey), false);
    assert.equal(result.stderr.includes(testApiKey), false);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test('figma vision redacts the configured key from provider errors and the evidence artifact', async () => {
  const fixture = await makeFixture();
  const mock = await startVisionServer(async ({ response }) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ error: { message: `Mock provider rejected ${testApiKey}` } })
    );
  });

  try {
    const result = await runVision(
      visionArgs(fixture, ['--allow-partial']),
      visionEnv(mock.baseUrl, {
        FIGMA_VISION_ALLOW_INSECURE_HTTP: '1',
        FIGMA_VISION_TOKEN_PARAM: 'omit',
      })
    );
    const artifactText = await readFile(fixture.outputPath, 'utf8');
    const artifact = JSON.parse(artifactText);

    assert.equal(result.code, 1);
    assert.equal(mock.requests.length, 2);
    assert.equal(artifact.results[0].status, 'error');
    assert.match(artifact.results[0].error, /\[redacted\]/);
    assert.equal(artifactText.includes(testApiKey), false);
    assert.equal(result.stdout.includes(testApiKey), false);
    assert.equal(result.stderr.includes(testApiKey), false);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});
