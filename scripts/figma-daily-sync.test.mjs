import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import {
  claimDailyAttempt,
  compareVisualPng,
  describeSourceConnectionMismatch,
  publishTrackedInbox,
  resolveDailyTargets,
  selectDailySource,
  tehranDay,
} from './figma-daily-sync.mjs';
import { REPO_ROOT } from './lib/figma-reference-run.mjs';

function png(width, height, rgba) {
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) image.data.set(rgba, offset);
  return PNG.sync.write(image);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function trackedObservation(candidateBytes, candidatePath = '001-target.png') {
  return {
    key: 'target',
    nodeId: '1:10',
    expectedNodeName: 'Target',
    receivedNodeName: 'Target',
    pageId: '0:1',
    pageName: 'Final',
    canonicalPath: 'docs/design/figma/artifacts/sha256/aa/canonical.png',
    canonicalSha256: 'a'.repeat(64),
    manifestSha256: 'a'.repeat(64),
    candidateSha256: digest(candidateBytes),
    changed: true,
    dimensionsMatch: true,
    candidate: { width: 2, height: 2 },
    canonical: { width: 2, height: 2 },
    exactMismatchedPixels: 4,
    thresholdedMismatchedPixels: 4,
    totalPixels: 4,
    diffPixelRatio: 1,
    candidatePath,
    evidencePath: `${candidatePath}.json`,
  };
}

function contentFileCount(root) {
  if (!existsSync(root)) return 0;
  return readdirSync(root).reduce((total, name) => total + readdirSync(join(root, name)).length, 0);
}

test('uses the Tehran calendar day across the UTC midnight boundary', () => {
  assert.equal(tehranDay(new Date('2026-08-08T20:29:59.000Z')), '2026-08-08');
  assert.equal(tehranDay(new Date('2026-08-08T20:30:00.000Z')), '2026-08-09');
});

test('atomically permits only one ordinary attempt per day', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'figma-daily-state-'));
  const first = claimDailyAttempt({ stateRoot, day: '2026-08-09', attemptId: 'first' });
  const second = claimDailyAttempt({ stateRoot, day: '2026-08-09', attemptId: 'second' });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(second.state.attemptId, 'first');
  assert.equal(JSON.parse(readFileSync(first.statePath, 'utf8')).status, 'claimed');
});

test('explicit force replaces the daily claim', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'figma-daily-force-'));
  claimDailyAttempt({ stateRoot, day: '2026-08-09', attemptId: 'first' });
  const forced = claimDailyAttempt({
    stateRoot,
    day: '2026-08-09',
    attemptId: 'forced',
    force: true,
  });
  assert.equal(forced.claimed, true);
  assert.equal(JSON.parse(readFileSync(forced.statePath, 'utf8')).attemptId, 'forced');
});

test('daily claim rejects path-like day and attempt identifiers', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'figma-daily-invalid-'));
  assert.throws(
    () => claimDailyAttempt({ stateRoot, day: '../../outside', attemptId: 'safe' }),
    /YYYY-MM-DD/
  );
  assert.throws(
    () => claimDailyAttempt({ stateRoot, day: '2026-08-09', attemptId: '../outside' }),
    /attempt id/
  );
});

test('daily source accepts one same-named recreated Figma file without rotating canonical provenance', () => {
  const source = selectDailySource(
    { figmaFile: { key: 'canonical-key', name: 'Example Design File (Copy)' } },
    [{ fileKey: 'recreated-key', fileName: 'Example Design File (Copy)', pluginBuild: 'build' }]
  );

  assert.equal(source.fileKey, 'recreated-key');
  assert.equal(source.selection, 'unique-connected-file-name');
  assert.equal(source.canonicalReferenceFileKey, 'canonical-key');
});

test('daily source diagnosis blocks only absent or ambiguous same-named connections', () => {
  const message = describeSourceConnectionMismatch({
    expectedFileKey: 'canonical-key',
    expectedFileName: 'Example Design File (Copy)',
    files: [
      { fileKey: 'different-copy-key', fileName: 'Example Design File (Copy)', pluginBuild: 'build' },
      { fileKey: 'second-copy-key', fileName: 'Example Design File (Copy)', pluginBuild: 'build' },
      { fileKey: 'unrelated-key', fileName: 'Other design', pluginBuild: 'build' },
    ],
  });

  assert.match(message, /canonical-key/);
  assert.match(message, /different-copy-key/);
  assert.match(message, /second-copy-key/);
  assert.match(message, /unique connected file by name/);
  assert.doesNotMatch(message, /unrelated-key/);
  assert.throws(
    () =>
      selectDailySource(
        { figmaFile: { key: 'canonical-key', name: 'Example Design File (Copy)' } },
        [
          { fileKey: 'different-copy-key', fileName: 'Example Design File (Copy)' },
          { fileKey: 'second-copy-key', fileName: 'Example Design File (Copy)' },
        ]
      ),
    /Multiple connected Figma files/
  );
});

test('visual comparison ignores byte-only PNG encoding differences', () => {
  const canonical = png(2, 2, [10, 20, 30, 255]);
  const candidate = PNG.sync.write(PNG.sync.read(canonical), { colorType: 6, inputColorType: 6 });
  const result = compareVisualPng(candidate, canonical);
  assert.equal(result.changed, false);
  assert.equal(result.diffPixelRatio, 0);
  assert.equal(result.exactMismatchedPixels, 0);
});

test('visual comparison reports pixel and dimension changes', () => {
  const canonical = png(2, 2, [10, 20, 30, 255]);
  const changed = compareVisualPng(png(2, 2, [200, 20, 30, 255]), canonical);
  assert.equal(changed.changed, true);
  assert.equal(changed.exactMismatchedPixels, 4);
  const resized = compareVisualPng(png(3, 2, [10, 20, 30, 255]), canonical);
  assert.equal(resized.changed, true);
  assert.equal(resized.dimensionsMatch, false);
});

test('target resolution includes only canonical mapped PNG entries', () => {
  const manifest = {
    items: {
      mapped: {
        referencePath: 'docs/design/figma/pages/actions.png',
        assetSha256: 'abc',
        lifecycle: { status: 'canonical-product' },
        figma: { nodeId: '1:1423', nodeName: 'actions', pageId: '0:1', pageName: 'Final ' },
        dailySyncFigma: {
          nodeId: '2:1423',
          nodeName: 'actions-v2',
          pageId: '0:2',
          pageName: 'Final v2',
        },
      },
      sourceOnly: {
        referencePath: 'docs/design/figma/foundation/Blue.svg',
        lifecycle: { status: 'source-only' },
        figma: { nodeId: '2:100' },
      },
    },
  };
  const targets = resolveDailyTargets(manifest);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].key, 'mapped');
  assert.equal(targets[0].nodeId, '2:1423');
  assert.equal(targets[0].canonicalNodeId, '1:1423');
  assert.equal(targets[0].mappingSource, 'daily-sync-override');
});

test('tracked inbox is durable, content-addressed, and idempotent across days', () => {
  const testBase = join(REPO_ROOT, '.cache', 'figma-daily-sync-tests');
  mkdirSync(testBase, { recursive: true });
  const root = mkdtempSync(join(testBase, 'tracked-inbox-'));
  const inboxRoot = join(root, 'inbox');
  const runRoot = join(root, 'run');
  mkdirSync(runRoot);
  const source = {
    fileKey: 'file-key',
    fileName: 'Design file',
    pluginBuild: 'build-1',
    revisionBefore: 10,
    revisionAfter: 10,
  };
  try {
    const firstBytes = png(2, 2, [200, 20, 30, 255]);
    writeFileSync(join(runRoot, '001-target.png'), firstBytes);
    const first = publishTrackedInbox({
      inboxRoot,
      runRoot,
      changed: [trackedObservation(firstBytes)],
      source,
      day: '2026-08-09',
    });
    assert.equal(first.indexChanged, true);
    assert.equal(first.activeCandidates, 1);
    const firstIndexBytes = readFileSync(join(inboxRoot, 'index.json'), 'utf8');
    const firstIndex = JSON.parse(firstIndexBytes);
    assert.equal(firstIndex.entries[0].key, 'target');
    assert.equal(firstIndex.entries[0].candidateSha256, digest(firstBytes));
    assert.equal(existsSync(join(inboxRoot, firstIndex.entries[0].candidatePath)), true);
    assert.equal(existsSync(join(inboxRoot, firstIndex.entries[0].evidencePath)), true);
    assert.equal(contentFileCount(join(inboxRoot, 'artifacts', 'sha256')), 1);
    assert.equal(contentFileCount(join(inboxRoot, 'evidence', 'sha256')), 1);

    const second = publishTrackedInbox({
      inboxRoot,
      runRoot,
      changed: [trackedObservation(firstBytes)],
      source: { ...source, revisionBefore: 11, revisionAfter: 11 },
      day: '2026-08-10',
    });
    assert.equal(second.indexChanged, false);
    assert.equal(readFileSync(join(inboxRoot, 'index.json'), 'utf8'), firstIndexBytes);
    assert.equal(contentFileCount(join(inboxRoot, 'artifacts', 'sha256')), 1);
    assert.equal(contentFileCount(join(inboxRoot, 'evidence', 'sha256')), 1);

    assert.throws(
      () =>
        publishTrackedInbox({
          inboxRoot,
          runRoot,
          changed: [],
          source,
          day: '2026-08-10',
          errors: [{ key: 'broken' }],
        }),
      /complete, revision-stable/
    );
    assert.equal(readFileSync(join(inboxRoot, 'index.json'), 'utf8'), firstIndexBytes);

    const secondBytes = png(2, 2, [20, 200, 30, 255]);
    writeFileSync(join(runRoot, '001-target.png'), secondBytes);
    const updated = publishTrackedInbox({
      inboxRoot,
      runRoot,
      changed: [trackedObservation(secondBytes)],
      source,
      day: '2026-08-11',
    });
    assert.equal(updated.indexChanged, true);
    assert.equal(contentFileCount(join(inboxRoot, 'artifacts', 'sha256')), 2);
    assert.equal(contentFileCount(join(inboxRoot, 'evidence', 'sha256')), 2);

    const current = publishTrackedInbox({
      inboxRoot,
      runRoot,
      changed: [],
      source,
      day: '2026-08-12',
    });
    assert.equal(current.activeCandidates, 0);
    assert.equal(JSON.parse(readFileSync(join(inboxRoot, 'index.json'))).entries.length, 0);
    assert.equal(contentFileCount(join(inboxRoot, 'artifacts', 'sha256')), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
