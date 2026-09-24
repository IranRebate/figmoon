import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFocusedStrictAudit } from './lib/figma-strict-evidence.mjs';

function fixture() {
  return {
    filters: {
      id: 'target-a',
      crop: null,
      grep: null,
      mode: 'signoff',
      snapshotRoot: '/run/snapshots',
      outDir: '/run/strict-audit',
      referencePath: null,
    },
    focused: true,
    counts: {
      registryItems: 1,
      rawDiffs: 1,
      rawAboveBase: 0,
      acceptanceAboveBase: 0,
      structuralAboveBase: 0,
      dimensionMismatches: 0,
      targetMaskingFiles: 2,
      targetOwnedMasking: 0,
      exceptionPolicyErrors: 0,
    },
    rawDiffs: [
      {
        id: 'target-a',
        snapshotPath: 'client/e2e/figma-audit-results/runs/run/snapshots/target-a.png',
        dimensionMismatch: false,
        acceptanceRatio: 0.001,
        acceptanceMetric: 'pixelmatch-aa-excluded-v1',
        structuralRatio: 0,
        structuralMetric: 'pixelmatch-raw-masked-sobel-jaccard-v3',
        structuralThreshold: 0,
        baseThreshold: 0.002,
        aboveStructuralBase: false,
        aboveBase: false,
      },
    ],
    targetMaskingAudit: { inspectedFiles: ['client/a.tsx', 'client/b.ts'] },
    targetOwnedMasking: [],
    exceptionPolicyErrors: [],
  };
}

const expected = {
  id: 'target-a',
  evidenceMode: 'signoff',
  capturedSnapshotPath: 'client/e2e/figma-audit-results/runs/run/snapshots/target-a.png',
};

test('accepts one exact focused signoff audit with a complete masking ledger', () => {
  assert.doesNotThrow(() => assertFocusedStrictAudit({ audit: fixture(), ...expected }));
});

test('signoff keeps raw renderer drift diagnostic while accepting AA-only differences', () => {
  const audit = fixture();
  audit.counts.rawAboveBase = 1;
  audit.rawDiffs[0].ratio = 0.02;
  audit.rawDiffs[0].aboveRawBase = true;

  assert.doesNotThrow(() => assertFocusedStrictAudit({ audit, ...expected }));
});

test('rejects a geometry edge shift even when the AA-excluded ratio is within threshold', () => {
  const audit = fixture();
  audit.counts.structuralAboveBase = 1;
  audit.rawDiffs[0].structuralRatio = 0.02;
  audit.rawDiffs[0].aboveStructuralBase = true;
  audit.rawDiffs[0].aboveBase = true;

  assert.throws(() => assertFocusedStrictAudit({ audit, ...expected }), /structuralAboveBase=0/);
});

test('recomputes structural threshold validity instead of trusting stored flags', () => {
  const audit = fixture();
  audit.rawDiffs[0].structuralRatio = 0.02;

  assert.throws(
    () => assertFocusedStrictAudit({ audit, ...expected }),
    /exceeds the structural edge threshold/
  );
});

test('rejects a digest-valid audit for another target or mode', () => {
  const audit = fixture();
  audit.filters.id = 'target-b';
  assert.throws(
    () => assertFocusedStrictAudit({ audit, ...expected }),
    /not the exact focused target\/mode contract/
  );
});

test('rejects target masking even when raw pixels are within threshold', () => {
  const audit = fixture();
  audit.counts.targetOwnedMasking = 1;
  audit.targetOwnedMasking.push({ file: 'client/a.tsx' });
  assert.throws(() => assertFocusedStrictAudit({ audit, ...expected }), /targetOwnedMasking=0/);
});

test('measurement permits drift but still requires exact target and masking semantics', () => {
  const audit = fixture();
  audit.filters.mode = 'report';
  audit.counts.rawAboveBase = 1;
  audit.counts.acceptanceAboveBase = 1;
  audit.rawDiffs[0].acceptanceRatio = 0.02;
  audit.rawDiffs[0].aboveBase = true;
  assert.doesNotThrow(() =>
    assertFocusedStrictAudit({ audit, ...expected, evidenceMode: 'measure' })
  );
});
