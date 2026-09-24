import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { REPO_ROOT, digestNamedFiles } from './lib/figma-reference-run.mjs';
import {
  assertFreshAcquisition,
  assertReferenceRunNotReplayed,
  demoteReferenceDependents,
  referencePromotionImpact,
  sealReviewedBundle,
  withContractPromotionMutex,
} from './lib/figma-promotion.mjs';

test('promotion mutex is exclusive, owner-bound, and recoverable after owner death', async (t) => {
  const lockRoot = mkdtempSync(join(tmpdir(), 'figma-promotion-lock-'));
  t.after(() => rmSync(lockRoot, { recursive: true, force: true }));

  assert.equal(
    await withContractPromotionMutex(async () => 'acquired', {
      lockRoot,
      attempts: 1,
      waitMs: 0,
    }),
    'acquired'
  );

  const lockName = 'figmoon-contract-promotion.lock';
  const token = '11111111-1111-4111-8111-111111111111';
  const pid = 999_999;
  const ownerName = `${lockName}.${pid}.${token}.owner`;
  const ownerPath = join(lockRoot, ownerName);
  const lockPath = join(lockRoot, lockName);
  writeFileSync(
    ownerPath,
    `${JSON.stringify({
      schemaVersion: 1,
      pid,
      token,
      ownerName,
      createdAt: '2026-08-02T00:00:00.000Z',
    })}\n`,
    { flag: 'wx', mode: 0o600 }
  );
  chmodSync(ownerPath, 0o400);
  linkSync(ownerPath, lockPath);

  let ran = false;
  await assert.rejects(
    withContractPromotionMutex(
      async () => {
        ran = true;
      },
      { lockRoot, attempts: 1, waitMs: 0, isProcessAlive: () => true }
    ),
    /Timed out waiting/
  );
  assert.equal(ran, false);

  await withContractPromotionMutex(
    async () => {
      ran = true;
    },
    { lockRoot, attempts: 2, waitMs: 0, isProcessAlive: () => false }
  );
  assert.equal(ran, true);
});

test('reference invalidation demotes only owning targets and removes dependent claims', () => {
  const registry = {
    items: [
      {
        id: 'owner-a',
        status: 'figma_parity',
        parityStatus: 'parity',
        lastVerifiedAt: '2026-08-02',
        signoff: { receipt: {} },
        baselineUpdate: { receipt: {} },
      },
      {
        id: 'owner-b',
        status: 'regression_locked',
        parityStatus: 'locked',
        lastVerifiedAt: '2026-08-02',
      },
      { id: 'unrelated', status: 'figma_parity', parityStatus: 'parity' },
    ],
  };

  assert.deepEqual(demoteReferenceDependents(registry, ['owner-a', 'owner-b']), [
    'owner-a',
    'owner-b',
  ]);
  assert.deepEqual(
    registry.items.slice(0, 2).map((item) => ({
      id: item.id,
      status: item.status,
      parityStatus: item.parityStatus,
      lastVerifiedAt: item.lastVerifiedAt,
      signoff: item.signoff,
      baselineUpdate: item.baselineUpdate,
    })),
    [
      {
        id: 'owner-a',
        status: 'mapped',
        parityStatus: 'drifting',
        lastVerifiedAt: null,
        signoff: undefined,
        baselineUpdate: undefined,
      },
      {
        id: 'owner-b',
        status: 'mapped',
        parityStatus: 'drifting',
        lastVerifiedAt: null,
        signoff: undefined,
        baselineUpdate: undefined,
      },
    ]
  );
  assert.equal(registry.items[2].status, 'figma_parity');
});

test('durable sealing accepts only the exact human-reviewed artifact bundle', (t) => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'figma-reviewed-bundle-'));
  const durableRoot = join(
    REPO_ROOT,
    'client',
    'e2e',
    `.figma-reviewed-bundle-${process.pid}-${Date.now()}`
  );
  mkdirSync(durableRoot, { recursive: true });
  t.after(() => {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(durableRoot, { recursive: true, force: true });
  });
  const evidencePath = join(sourceRoot, 'evidence.json');
  const capturePath = join(sourceRoot, 'capture.png');
  writeFileSync(evidencePath, '{"reviewed":true}\n');
  writeFileSync(capturePath, Buffer.from([1, 2, 3, 4]));
  const expectedDigest = digestNamedFiles([
    { name: 'capture.png', path: capturePath },
    { name: 'evidence.json', path: evidencePath },
  ]);

  const sealed = sealReviewedBundle({
    expectedDigest,
    entries: [
      {
        key: 'evidence',
        name: 'evidence.json',
        sourcePath: evidencePath,
        root: durableRoot,
        extension: 'json',
      },
      {
        key: 'capture',
        name: 'capture.png',
        sourcePath: capturePath,
        root: durableRoot,
        extension: 'png',
      },
    ],
  });
  assert.match(sealed.evidence.sha256, /^[a-f0-9]{64}$/);
  assert.match(sealed.capture.sha256, /^[a-f0-9]{64}$/);

  writeFileSync(capturePath, Buffer.from([9, 9, 9, 9]));
  assert.throws(
    () =>
      sealReviewedBundle({
        expectedDigest,
        entries: [
          {
            key: 'evidence',
            name: 'evidence.json',
            sourcePath: evidencePath,
            root: durableRoot,
            extension: 'json',
          },
          {
            key: 'capture',
            name: 'capture.png',
            sourcePath: capturePath,
            root: durableRoot,
            extension: 'png',
          },
        ],
      }),
    /Reviewed bundle changed before durable sealing/
  );
});

test('reference freshness is based on acquisition time with bounded clock skew', () => {
  const now = new Date('2026-08-02T12:00:00.000Z');
  assert.doesNotThrow(() =>
    assertFreshAcquisition({
      acquiredAt: '2026-08-01T12:00:00.000Z',
      maxAgeDays: 14,
      now,
    })
  );
  assert.throws(
    () =>
      assertFreshAcquisition({
        acquiredAt: '2026-07-01T12:00:00.000Z',
        maxAgeDays: 14,
        now,
      }),
    /Reference acquisition is stale/
  );
  assert.throws(
    () =>
      assertFreshAcquisition({
        acquiredAt: '2026-08-02T12:06:00.000Z',
        maxAgeDays: 14,
        now,
      }),
    /timestamp is in the future/
  );
});

test('an already-promoted reference run cannot rotate provenance without invalidation', () => {
  const reviewSha256 = 'a'.repeat(64);
  assert.throws(
    () =>
      assertReferenceRunNotReplayed(
        { acquisition: { runId: 'reference-run-1', reviewSha256 } },
        { runId: 'reference-run-1', reviewSha256 }
      ),
    /already canonical/
  );
  assert.doesNotThrow(() =>
    assertReferenceRunNotReplayed(
      { acquisition: { runId: 'reference-run-1', reviewSha256 } },
      { runId: 'reference-run-2', reviewSha256: 'b'.repeat(64) }
    )
  );
});

test('a global Figma source binding invalidates every manifest owner', () => {
  const impact = referencePromotionImpact({
    manifest: {
      figmaFile: { name: 'Legacy file' },
      items: {
        target: { registryIds: ['target-a', 'target-b'] },
        other: { registryIds: ['target-c'] },
      },
    },
    manifestKey: 'target',
    sourceFile: { key: 'FileKey123', name: 'Example Design File (Copy)' },
  });
  assert.equal(impact.sourceContractChanged, true);
  assert.deepEqual(impact.registryIds, ['target-a', 'target-b', 'target-c']);
});

test('a one-target source remap cannot strand acquisitions from another Figma file', () => {
  assert.throws(
    () =>
      referencePromotionImpact({
        manifest: {
          figmaFile: { key: 'OldKey', name: 'Old source' },
          items: {
            target: { registryIds: ['target'] },
            other: { registryIds: ['other'], acquisition: { fileKey: 'OldKey' } },
          },
        },
        manifestKey: 'target',
        sourceFile: { key: 'NewKey', name: 'New source' },
      }),
    /whole-source migration/
  );
});
