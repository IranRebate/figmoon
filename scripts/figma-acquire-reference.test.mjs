import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  FIGMA_ACQUISITION_PLUGIN,
  FIGMA_ACQUISITION_PROTOCOL,
} from './lib/figma-readonly-bridge.mjs';
import {
  MANIFEST_PATH,
  REFERENCE_RUNS_ROOT,
  findManifestEntry,
  readJson,
  resolveManifestArtifact,
  sha256,
} from './lib/figma-reference-run.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(scriptDir, '..');
const acquireScript = join(scriptDir, 'figma-acquire-reference.mjs');

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to allocate acquisition test port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

function waitForLine(child, pattern, timeoutMs = 5_000) {
  return new Promise((resolveLine, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${pattern}.\n${output}`)),
      timeoutMs
    );
    const onData = (chunk) => {
      output += chunk.toString();
      if (!pattern.test(output)) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      resolveLine(output);
    };
    child.stdout.on('data', onData);
  });
}

function waitForExit(child) {
  return new Promise((resolveExit, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal, stdout, stderr }));
  });
}

test('stages a current-source protocol acquisition without mutating the manifest or canonical asset', async (t) => {
  const id = 'comp-message-actions';
  const runId = `reference-acquire-test-${process.pid}`;
  const runRoot = join(REFERENCE_RUNS_ROOT, runId);
  rmSync(runRoot, { recursive: true, force: true });
  t.after(() => rmSync(runRoot, { recursive: true, force: true }));

  const manifest = readJson(MANIFEST_PATH);
  const { entry } = findManifestEntry(manifest, id);
  const canonicalPath = resolveManifestArtifact(entry);
  const manifestBefore = sha256(readFileSync(MANIFEST_PATH));
  const canonicalBefore = sha256(readFileSync(canonicalPath));
  const port = await availablePort();
  const child = spawn(
    process.execPath,
    [
      acquireScript,
      '--id',
      id,
      '--file-key',
      manifest.figmaFile.key,
      '--port',
      String(port),
      '--timeout-ms',
      '5000',
      '--run-id',
      runId,
    ],
    { cwd: clientRoot, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  const exitPromise = waitForExit(child);
  const startup = await waitForLine(child, /one-time nonce:/);
  const nonce = /one-time nonce: ([A-Za-z0-9_-]{43,128})/.exec(startup)?.[1];
  assert.ok(nonce, startup);

  const plugin = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://www.figma.com' });
  t.after(() => plugin.terminate());
  await new Promise((resolveOpen, reject) => {
    plugin.once('open', resolveOpen);
    plugin.once('error', reject);
  });
  plugin.send(
    JSON.stringify({
      type: 'hello',
      protocol: FIGMA_ACQUISITION_PROTOCOL,
      plugin: FIGMA_ACQUISITION_PLUGIN,
      sessionNonce: nonce,
      file: { key: manifest.figmaFile.key, name: manifest.figmaFile.name },
    })
  );

  const canonicalBase64 = readFileSync(canonicalPath).toString('base64');
  plugin.on('message', (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.type === 'hello_ack') return;
    assert.equal(request.type, 'acquire_reference');
    const snapshot = {
      metadata: {
        fileKey: manifest.figmaFile.key,
        fileName: manifest.figmaFile.name,
        currentPageId: entry.figma.pageId,
        currentPageName: entry.figma.pageName,
        targetPageId: entry.figma.pageId,
        targetPageName: entry.figma.pageName,
        pageCount: 1,
        pages: [{ id: entry.figma.pageId, name: entry.figma.pageName }],
      },
      node: {
        id: entry.figma.nodeId,
        name: entry.figma.nodeName,
        type: entry.figma.nodeType,
        bounds: {
          x: 0,
          y: 0,
          width: entry.figma.liveBounds?.width ?? entry.exportBounds.width,
          height: entry.figma.liveBounds?.height ?? entry.exportBounds.height,
        },
      },
      variables: { collections: [] },
      revision: { start: 0, end: 0 },
    };
    plugin.send(
      JSON.stringify({
        type: 'acquisition_result',
        protocol: FIGMA_ACQUISITION_PROTOCOL,
        requestId: request.requestId,
        data: {
          before: snapshot,
          after: snapshot,
          ancestry: {
            before: { id: entry.figma.pageId, name: entry.figma.pageName },
            after: { id: entry.figma.pageId, name: entry.figma.pageName },
          },
          changeTracking: {
            supported: true,
            beforeReadStart: 0,
            beforeReadEnd: 0,
            afterReadStart: 0,
            afterReadEnd: 0,
          },
          export: {
            nodeId: entry.figma.nodeId,
            nodeName: entry.figma.nodeName,
            format: 'PNG',
            scale: 1,
            clip: entry.exportSpec?.clip === true,
            base64: canonicalBase64,
            width: entry.exportBounds.width,
            height: entry.exportBounds.height,
          },
        },
      })
    );
  });

  const result = await exitPromise;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(existsSync(join(runRoot, 'evidence.json')), true);
  const evidence = readJson(join(runRoot, 'evidence.json'));
  assert.equal(evidence.result, 'staged');
  assert.equal(evidence.validation.status, 'ready');
  assert.equal(evidence.validation.fileBindingCandidate, false);
  assert.equal(evidence.validation.sourceRemapCandidate, false);
  assert.deepEqual(evidence.validation.reviewRequired, []);
  assert.deepEqual(evidence.acquisition.operations, ['acquire_reference']);
  assert.deepEqual(evidence.acquisition.plugin, FIGMA_ACQUISITION_PLUGIN);
  assert.equal(evidence.source.stability.beforeSha256, evidence.source.stability.afterSha256);
  assert.equal(sha256(readFileSync(MANIFEST_PATH)), manifestBefore);
  assert.equal(sha256(readFileSync(canonicalPath)), canonicalBefore);
});

test('rejects a conflicting source key before opening a broker', () => {
  const result = spawnSync(
    process.execPath,
    [
      acquireScript,
      '--id',
      'comp-message-actions',
      '--file-key',
      'ConflictingSource123',
      '--run-id',
      `conflicting-source-${process.pid}`,
    ],
    { cwd: clientRoot, encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /contradicts/);
  assert.match(result.stderr, /--source-remap-candidate/);
});
