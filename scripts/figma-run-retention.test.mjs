import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { planRetention, pruneRetention, retentionPlanSha256 } from './figma-run-retention.mjs';

const DAY = 86_400_000;

function withTempRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'figma-retention-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createRun(root, { runId, id = 'target-a', mode = 'measure', modifiedAt }) {
  const path = join(root, runId);
  mkdirSync(path, { recursive: true });
  const evidencePath = join(path, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify({ runId, id, mode }));
  const date = new Date(modifiedAt);
  utimesSync(evidencePath, date, date);
  utimesSync(path, date, date);
  return path;
}

test('retains the newest runs per target and never selects a protected run', () =>
  withTempRoot((root) => {
    const now = Date.UTC(2026, 7, 9);
    const oldest = createRun(root, { runId: 'oldest', modifiedAt: now - 10 * DAY });
    createRun(root, { runId: 'protected', modifiedAt: now - 9 * DAY });
    createRun(root, { runId: 'newer', modifiedAt: now - 8 * DAY });
    createRun(root, { runId: 'newest', modifiedAt: now - 7 * DAY });

    const plan = planRetention({
      runRoots: [root],
      protectedIds: new Set(['protected']),
      keepPerGroup: 2,
      olderThanDays: 3,
      now,
    });

    assert.deepEqual(
      plan.candidates.map((candidate) => candidate.path),
      [oldest]
    );
  }));

test('uses the newest descendant timestamp instead of only the run directory timestamp', () =>
  withTempRoot((root) => {
    const now = Date.UTC(2026, 7, 9);
    const path = createRun(root, { runId: 'active-run', modifiedAt: now - 10 * DAY });
    const recentArtifact = join(path, 'capture.png');
    writeFileSync(recentArtifact, 'new evidence');
    const recent = new Date(now - DAY);
    utimesSync(recentArtifact, recent, recent);
    utimesSync(path, new Date(now - 10 * DAY), new Date(now - 10 * DAY));

    const plan = planRetention({
      runRoots: [root],
      protectedIds: new Set(),
      keepPerGroup: 0,
      olderThanDays: 3,
      now,
    });

    assert.equal(plan.candidates.length, 0);
  }));

test('refuses top-level and nested symbolic links', () => {
  withTempRoot((root) => {
    const outside = mkdtempSync(join(tmpdir(), 'figma-retention-outside-'));
    try {
      symlinkSync(outside, join(root, 'linked-run'));
      assert.throws(
        () => planRetention({ runRoots: [root], protectedIds: new Set() }),
        /refuses symbolic links/
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  withTempRoot((root) => {
    const now = Date.UTC(2026, 7, 9);
    const path = createRun(root, { runId: 'nested-link', modifiedAt: now - 10 * DAY });
    symlinkSync(tmpdir(), join(path, 'escape'));
    assert.throws(
      () => planRetention({ runRoots: [root], protectedIds: new Set(), now }),
      /refuses symbolic links/
    );
  });
});

test('refuses a symbolic link used as an allowed run root', () =>
  withTempRoot((root) => {
    const outside = mkdtempSync(join(tmpdir(), 'figma-retention-root-outside-'));
    const linkedRoot = join(root, 'linked-root');
    try {
      symlinkSync(outside, linkedRoot);
      assert.throws(
        () => planRetention({ runRoots: [linkedRoot], protectedIds: new Set() }),
        /root must be a regular directory/
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));

test('prunes only unchanged reviewed candidates inside an allowed root', () =>
  withTempRoot((root) => {
    const now = Date.UTC(2026, 7, 9);
    const path = createRun(root, { runId: 'old-run', modifiedAt: now - 10 * DAY });
    const plan = planRetention({
      runRoots: [root],
      protectedIds: new Set(),
      keepPerGroup: 0,
      olderThanDays: 3,
      now,
    });

    pruneRetention(plan, { allowedRoots: [root] });
    assert.equal(existsSync(path), false);
  }));

test('refuses deletion when a candidate changes after the dry-run plan', () =>
  withTempRoot((root) => {
    const now = Date.UTC(2026, 7, 9);
    const path = createRun(root, { runId: 'changed-run', modifiedAt: now - 10 * DAY });
    const plan = planRetention({
      runRoots: [root],
      protectedIds: new Set(),
      keepPerGroup: 0,
      olderThanDays: 3,
      now,
    });
    writeFileSync(join(path, 'late-artifact.json'), '{}');

    assert.throws(() => pruneRetention(plan, { allowedRoots: [root] }), /changed after review/);
    assert.equal(existsSync(path), true);
  }));

test('preflights every candidate before deleting any reviewed run', () =>
  withTempRoot((root) => {
    const now = Date.UTC(2026, 7, 9);
    const first = createRun(root, { runId: 'first-run', modifiedAt: now - 11 * DAY });
    const second = createRun(root, { runId: 'second-run', modifiedAt: now - 10 * DAY });
    const plan = planRetention({
      runRoots: [root],
      protectedIds: new Set(),
      keepPerGroup: 0,
      olderThanDays: 3,
      now,
    });
    writeFileSync(join(second, 'late-artifact.json'), '{}');

    assert.throws(() => pruneRetention(plan, { allowedRoots: [root] }), /changed after review/);
    assert.equal(existsSync(first), true);
    assert.equal(existsSync(second), true);
  }));

test('plan digest binds the exact reviewed candidate metadata', () =>
  withTempRoot((root) => {
    const now = Date.UTC(2026, 7, 9);
    createRun(root, { runId: 'old-run', modifiedAt: now - 10 * DAY });
    const plan = planRetention({
      runRoots: [root],
      protectedIds: new Set(),
      keepPerGroup: 0,
      olderThanDays: 3,
      now,
    });
    const first = retentionPlanSha256(plan);
    const second = retentionPlanSha256(structuredClone(plan));
    const changed = structuredClone(plan);
    changed.candidates[0].bytes += 1;

    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(second, first);
    assert.notEqual(retentionPlanSha256(changed), first);
  }));
