import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { itemForStructuralComparison, parseInspectArguments } from './figma-inspect.mjs';
import {
  loadFigmaStructure,
  selectConnectedFigmaFile,
} from './lib/figma-structural-source.mjs';
import { sha256, stableJson } from './lib/figma-reference-run.mjs';

function canonicalFixture(t, nodeOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'figmoon-structural-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const node = {
    id: '1:2',
    name: 'Target',
    type: 'FRAME',
    bounds: { x: 0, y: 0, width: 390, height: 844 },
    ...nodeOverrides,
  };
  const bytes = stableJson(node);
  const digest = sha256(bytes);
  const durablePath = join(root, digest.slice(0, 2), `${digest}.json`);
  mkdirSync(join(root, digest.slice(0, 2)), { recursive: true });
  writeFileSync(durablePath, bytes);
  const registry = {
    items: [
      {
        id: 'target',
        referenceStatus: 'mapped',
        implementationStatus: 'implemented',
        parityStatus: 'drifting',
      },
    ],
  };
  const manifest = {
    figmaFile: { name: 'Final', dailySync: { fileName: 'Final' } },
    items: {
      target: {
        registryIds: ['target'],
        exportBounds: { width: 390, height: 844 },
        figma: {
          nodeId: '1:2',
          nodeName: 'Target',
          nodeType: 'FRAME',
        },
        acquisition: {
          runId: 'canonical-run',
          nodeSha256: digest,
          node: { path: durablePath, sha256: digest },
        },
      },
    },
  };
  return { root, registry, manifest, durablePath, digest };
}

async function unavailableRpc(t) {
  const server = createServer((_request, response) => {
    response.statusCode = 503;
    response.end('unavailable');
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}/rpc`;
}

test('parses one exact structural inspection target and rejects ambiguous CLI input', () => {
  assert.deepEqual(parseInspectArguments(['--id', 'target', '--figma-source=canonical', '--json']), {
    id: 'target',
    runId: null,
    figmaSource: 'canonical',
    referenceRun: null,
    json: true,
  });
  assert.throws(() => parseInspectArguments(['--id', 'a', '--id=b']), /provided only once/);
  assert.throws(() => parseInspectArguments(['--id', 'a', '--typo']), /Unsupported/);
  assert.throws(
    () => parseInspectArguments(['--id', 'a', '--figma-source', 'live', '--reference-run', 'candidate']),
    /cannot be combined/
  );
});

test('CLI reports the structured workflow action and reserves blocker wording for terminal authority', () => {
  const source = readFileSync(join(import.meta.dirname, 'figma-inspect.mjs'), 'utf8');
  assert.match(source, /Workflow lane:/);
  assert.match(source, /Raster measurement:/);
  assert.match(source, /Required action:/);
  assert.match(source, /if \(workflow\.terminalBlocker\)/);
  assert.match(source, /EXTERNAL DECISION BLOCKER:/);
  assert.doesNotMatch(source, /BLOCKED before CSS/);
});

test('a validated staged reference qualifies remap state for structural measurement', () => {
  const item = {
    referenceStatus: 'requires-remap',
    parityStatus: 'not-comparable',
    designDecision: null,
  };
  assert.equal(itemForStructuralComparison(item, null), item);
  assert.deepEqual(itemForStructuralComparison(item, 'staged-run'), {
    ...item,
    referenceStatus: 'mapped',
    parityStatus: 'drifting',
  });
});

test('falls back from unavailable live RPC to hash-verified canonical structure', async (t) => {
  const fixture = canonicalFixture(t);
  const endpoint = await unavailableRpc(t);
  const result = await loadFigmaStructure({
    id: 'target',
    registry: fixture.registry,
    manifest: fixture.manifest,
    source: 'auto',
    endpoint,
    durableEvidenceRoot: fixture.root,
  });
  assert.equal(result.source.kind, 'canonical-acquisition');
  assert.match(result.source.liveFallbackReason, /HTTP 503/);
  assert.equal(result.node.id, '1:2');
});

test('fails closed when canonical bytes or mapped identity change', async (t) => {
  const hashFixture = canonicalFixture(t);
  writeFileSync(hashFixture.durablePath, stableJson({ changed: true }));
  await assert.rejects(
    loadFigmaStructure({
      id: 'target',
      registry: hashFixture.registry,
      manifest: hashFixture.manifest,
      source: 'canonical',
      durableEvidenceRoot: hashFixture.root,
    }),
    /SHA-256|content-addressed|digest|hash/i
  );

  const identityFixture = canonicalFixture(t, { name: 'Different target' });
  await assert.rejects(
    loadFigmaStructure({
      id: 'target',
      registry: identityFixture.registry,
      manifest: identityFixture.manifest,
      source: 'canonical',
      durableEvidenceRoot: identityFixture.root,
    }),
    /identity changed.*name expected Target, observed Different target/
  );
});

test('requires one uniquely named connected Figma file', () => {
  const manifest = { figmaFile: { dailySync: { fileName: 'Final' } } };
  assert.throws(() => selectConnectedFigmaFile(manifest, []), /no connected file/);
  assert.throws(
    () =>
      selectConnectedFigmaFile(manifest, [
        { fileName: 'Final', fileKey: 'a' },
        { fileName: 'Final', fileKey: 'b' },
      ]),
    /connect exactly one/
  );
});
