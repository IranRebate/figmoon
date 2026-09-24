import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveCanonicalSnapshotPath } from './lib/figma-snapshot-contract.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'figma-snapshot-contract-'));
  const snapshotRoot = join(root, 'snapshots');
  mkdirSync(join(snapshotRoot, 'desktop'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, snapshotRoot };
}

test('resolves exactly one declared regular snapshot under the canonical root', (t) => {
  const { snapshotRoot } = fixture(t);
  const expected = join(snapshotRoot, 'desktop', 'target.png');
  writeFileSync(expected, 'png');
  assert.equal(
    resolveCanonicalSnapshotPath({
      item: { id: 'target', snapshot: 'desktop/target.png' },
      snapshotRoot,
    }),
    expected
  );
});

test('rejects ambiguous repository paths and symlink snapshots', (t) => {
  const { root, snapshotRoot } = fixture(t);
  const outside = join(root, 'outside.png');
  writeFileSync(outside, 'outside');
  symlinkSync(outside, join(snapshotRoot, 'desktop', 'target.png'));

  assert.throws(
    () =>
      resolveCanonicalSnapshotPath({
        item: { id: 'target', snapshot: 'docs/target.png' },
        snapshotRoot,
      }),
    /unsupported or ambiguous path/
  );
  assert.throws(
    () =>
      resolveCanonicalSnapshotPath({
        item: { id: 'target', snapshot: 'desktop/target.png' },
        snapshotRoot,
      }),
    /regular non-symlink file/
  );
});
