import assert from 'node:assert/strict';
import test from 'node:test';
import {
  baselinePromotionReceiptIssues,
  parityAttestationReceiptIssues,
  referencePromotionReceiptIssues,
} from './lib/figma-receipt-contract.mjs';
import { sha256, stableJson } from './lib/figma-reference-run.mjs';

const hash = (character) => character.repeat(64);
const pointer = (name, digest, extension = 'json') => ({
  path: `docs/design/evidence/sha256/${digest.slice(0, 2)}/${digest}.${extension}`,
  sha256: digest,
  name,
});

function referenceFixture() {
  const source = {
    file: { key: 'FigmaFileKey', name: 'Example Design File' },
    page: { id: '1:2', name: 'Components' },
    node: {
      id: '3:4',
      name: 'Message actions',
      type: 'FRAME',
      bounds: { x: 10, y: 20, width: 300, height: 120 },
      path: 'client/e2e/figma-reference-runs/run/node.json',
      sha256: hash('n'),
    },
    variables: {
      collectionCount: 2,
      path: 'client/e2e/figma-reference-runs/run/variables.json',
      sha256: hash('v'),
    },
    export: {
      path: 'client/e2e/figma-reference-runs/run/reference.png',
      sha256: hash('r'),
      bounds: { width: 300, height: 120 },
      spec: { format: 'PNG', scale: 1, clip: true },
    },
    stability: { beforeSha256: hash('s'), afterSha256: hash('s') },
  };
  const canonicalBefore = {
    path: 'docs/design/figma/legacy.png',
    sha256: hash('p'),
    manifestSha256: hash('p'),
    bounds: { width: 300, height: 120 },
  };
  const acquisition = {
    schemaVersion: 1,
    runId: 'reference-run',
    adapter: 'figmoon-reference-broker',
    adapterVersion: '1.0.0',
    protocol: 'figmoon-reference-acquisition/v1',
    plugin: { id: 'figmoon', version: '1.0.0', build: 'build' },
    operations: ['acquire_reference'],
    fileKey: source.file.key,
    fileName: source.file.name,
    pageId: source.page.id,
    pageName: source.page.name,
    nodeId: source.node.id,
    nodeSha256: source.node.sha256,
    variablesSha256: source.variables.sha256,
    exportSha256: source.export.sha256,
    exportSpec: source.export.spec,
    acquiredAt: '2026-08-02T10:00:00.000Z',
    promotedAt: '2026-08-02T11:00:00.000Z',
    previousAssetSha256: canonicalBefore.sha256,
    reviewSha256: hash('q'),
    evidence: pointer('evidence', hash('e')),
    node: pointer('node', hash('n')),
    variables: pointer('variables', hash('v')),
    approvedBy: 'Emad',
    leaseOwner: 'receipt-test',
    reason: 'Reviewed exact reference evidence',
  };
  const manifestEntry = {
    registryIds: ['target-a', 'target-b'],
    referencePath: 'docs/design/figma/message-actions.png',
    artifactPath: `docs/design/figma/artifacts/sha256/rr/${hash('r')}.png`,
    assetSha256: hash('r'),
    exportBounds: source.export.bounds,
    figma: {
      pageId: source.page.id,
      pageName: source.page.name,
      nodeId: source.node.id,
      nodeName: source.node.name,
      nodeType: source.node.type,
      liveBounds: { width: 300, height: 120 },
    },
    acquisition,
  };
  acquisition.receipt = pointer('receipt', hash('t'));
  const receipt = {
    schemaVersion: 1,
    kind: 'figma-reference-promotion',
    target: { manifestKey: 'message-actions', registryIds: ['target-a', 'target-b'] },
    runId: acquisition.runId,
    reviewSha256: acquisition.reviewSha256,
    acquiredAt: acquisition.acquiredAt,
    promotedAt: acquisition.promotedAt,
    approval: {
      approvedBy: acquisition.approvedBy,
      leaseOwner: acquisition.leaseOwner,
      reason: acquisition.reason,
    },
    source,
    canonicalBefore,
    artifacts: {
      acquisitionEvidence: acquisition.evidence,
      reference: { path: manifestEntry.artifactPath, sha256: manifestEntry.assetSha256 },
      node: acquisition.node,
      variables: acquisition.variables,
    },
  };
  const acquisitionEvidence = {
    schemaVersion: 1,
    kind: 'figma-reference-acquisition',
    runId: acquisition.runId,
    target: {
      registryId: 'target-a',
      manifestKey: 'message-actions',
      logicalReferencePath: manifestEntry.referencePath,
    },
    acquisition: {
      adapter: acquisition.adapter,
      adapterVersion: acquisition.adapterVersion,
      protocol: acquisition.protocol,
      plugin: acquisition.plugin,
      operations: acquisition.operations,
    },
    source,
    canonicalBefore,
    acquiredAt: acquisition.acquiredAt,
    result: 'staged',
  };
  return {
    receipt,
    manifest: { figmaFile: source.file, items: { 'message-actions': manifestEntry } },
    manifestKey: 'message-actions',
    manifestEntry,
    acquisitionEvidence,
  };
}

function visualFixture(mode) {
  const reference = referenceFixture();
  const snapshotPath = 'client/e2e/visual-snapshots/desktop/message-actions.png';
  const item = {
    id: 'target-a',
    kind: 'component',
    referencePath: reference.manifestEntry.referencePath,
    visualTest: { file: 'client/e2e/visual/components.spec.ts', name: 'target-a' },
  };
  const rendererState = {
    schemaVersion: 2,
    browser: 'chromium',
    chromium: { runtimeVersion: '1.2.3.4' },
    fonts: hash('f'),
  };
  const rendererFingerprint = sha256(stableJson(rendererState));
  const artifacts = {
    evidence: pointer('evidence', hash('e')),
    capture: pointer('capture', hash('c'), 'png'),
    strictAudit: pointer('strict', hash('a')),
    designDiagnosis: pointer('design-diagnosis', hash('j')),
    designDiagnosisHtml: pointer('design-diagnosis', hash('h'), 'html'),
    diffReport: pointer('diff', hash('d'), 'html'),
  };
  const commonRecord = {
    evidenceSha256: hash('g'),
    approvedBy: 'Emad',
    leaseOwner: 'receipt-test',
    approvedAt: '2026-08-02T12:00:00.000Z',
    reason: 'Reviewed exact visual evidence',
    targetSourceFingerprint: hash('i'),
    rendererFingerprint,
    referenceSha256: reference.manifestEntry.assetSha256,
    referenceAcquisitionReceiptSha256: reference.manifestEntry.acquisition.receipt.sha256,
    captureSha256: artifacts.capture.sha256,
  };
  const baselineUpdate = {
    ...commonRecord,
    measurementRunId: 'measure-run',
    receipt: pointer('baseline-receipt', hash('b')),
    beforeSha256: hash('o'),
    afterSha256: artifacts.capture.sha256,
  };
  const signoff = {
    ...commonRecord,
    runId: 'signoff-run',
    receipt: pointer('parity-receipt', hash('y')),
    baselinePromotionReceiptSha256: baselineUpdate.receipt.sha256,
    snapshotSha256: hash('s'),
    rawDiffPixelRatio: 0.001,
    acceptanceDiffPixelRatio: 0.0005,
    acceptanceMetric: 'pixelmatch-aa-excluded-v1',
    baselineReproducibilityRatio: 0.0001,
    maxDiffPixelRatio: 0.003,
  };
  const record = mode === 'measure' ? baselineUpdate : signoff;
  const contract = {
    targetSourceFingerprint: record.targetSourceFingerprint,
    rendererFingerprint: record.rendererFingerprint,
    referenceSha256: record.referenceSha256,
    referenceAcquisitionReceiptSha256: record.referenceAcquisitionReceiptSha256,
    ...(mode === 'measure'
      ? {
          beforeSha256: baselineUpdate.beforeSha256,
          afterSha256: baselineUpdate.afterSha256,
        }
      : {
          baselinePromotionReceiptSha256: signoff.baselinePromotionReceiptSha256,
          snapshotSha256: signoff.snapshotSha256,
          rawDiffPixelRatio: signoff.rawDiffPixelRatio,
          acceptanceDiffPixelRatio: signoff.acceptanceDiffPixelRatio,
          acceptanceMetric: signoff.acceptanceMetric,
          baselineReproducibilityRatio: signoff.baselineReproducibilityRatio,
          maxDiffPixelRatio: signoff.maxDiffPixelRatio,
        }),
    captureSha256: record.captureSha256,
  };
  const receipt = {
    schemaVersion: 1,
    kind: mode === 'measure' ? 'figma-baseline-promotion' : 'figma-parity-attestation',
    target: {
      id: item.id,
      manifestKey: reference.manifestKey,
      ...(mode === 'measure' ? { snapshotPath } : {}),
    },
    runId: mode === 'measure' ? baselineUpdate.measurementRunId : signoff.runId,
    reviewSha256: record.evidenceSha256,
    approvedAt: record.approvedAt,
    approval: {
      approvedBy: record.approvedBy,
      leaseOwner: record.leaseOwner,
      reason: record.reason,
    },
    contract,
    artifacts,
  };
  const evidence = {
    schemaVersion: 1,
    kind: 'figma-parity-evidence',
    id: item.id,
    mode,
    runId: receipt.runId,
    visualTest: item.visualTest,
    result: mode === 'measure' ? 'completed' : 'passed',
    canonicalSnapshotPath: snapshotPath,
    capturedSnapshotPath:
      'client/e2e/figma-audit-results/runs/reviewed-run/snapshots/desktop/message-actions.png',
    referenceSource: { kind: 'canonical-manifest', manifestKey: reference.manifestKey },
    referencePath: reference.manifestEntry.artifactPath,
    before: {
      referenceSha256: contract.referenceSha256,
      snapshotSha256: mode === 'measure' ? contract.beforeSha256 : contract.snapshotSha256,
    },
    capture: {
      referenceSha256: contract.referenceSha256,
      snapshotSha256: contract.captureSha256,
      acceptedBaselinesChanged: [],
      ...(mode === 'signoff'
        ? {
            baselineReproducibility: {
              metric: 'pixelmatch-aa-excluded-v1',
              ratio: signoff.baselineReproducibilityRatio,
              maxRatio: 0.0005,
              dimensionMismatch: false,
              baselineSha256: contract.snapshotSha256,
              captureSha256: contract.captureSha256,
            },
          }
        : {}),
    },
    rendererState,
    rendererRuntime: {
      schemaVersion: 2,
      browser: 'chromium',
      runtimeVersion: '1.2.3.4',
      executableMatchesContract: true,
      headless: true,
      effectiveColorProfile: 'srgb',
      locale: 'fa-IR',
      timezoneId: 'UTC',
      deviceScaleFactor: 1,
      colorScheme: 'light',
      reducedMotion: 'reduce',
    },
    rendererMutationGuard: {
      beforeFingerprint: rendererFingerprint,
      afterFingerprint: rendererFingerprint,
      changed: false,
    },
    targetSourceState: { fingerprint: contract.targetSourceFingerprint },
    targetSourceMutationGuard: {
      beforeFingerprint: contract.targetSourceFingerprint,
      afterFingerprint: contract.targetSourceFingerprint,
      changed: false,
    },
    referenceMutationGuard: { changed: false },
    acceptedBaselineChanges: [],
    inspections: {
      strictAuditSha256: artifacts.strictAudit.sha256,
      diffReportSha256: artifacts.diffReport.sha256,
      designDiagnosisSha256: artifacts.designDiagnosis.sha256,
      designDiagnosisHtmlSha256: artifacts.designDiagnosisHtml.sha256,
    },
    ...(mode === 'signoff'
      ? {
          parity: {
            outcome: 'within-threshold',
            rawAboveBase: 0,
            acceptanceAboveBase: 0,
            acceptanceMetric: 'pixelmatch-aa-excluded-v1',
            structuralMetric: 'pixelmatch-raw-masked-sobel-jaccard-v3',
            structuralThreshold: 0,
            rawDiffs: 1,
          },
        }
      : {}),
  };
  const strictAudit = {
    filters: {
      id: item.id,
      crop: null,
      grep: null,
      mode: mode === 'signoff' ? 'signoff' : 'report',
      snapshotRoot: '/reviewed-run/snapshots',
      outDir: '/reviewed-run/strict-audit',
      referencePath: null,
    },
    focused: true,
    counts: {
      registryItems: 1,
      rawDiffs: 1,
      rawAboveBase: mode === 'signoff' ? 0 : 1,
      acceptanceAboveBase: mode === 'signoff' ? 0 : 1,
      structuralAboveBase: mode === 'signoff' ? 0 : 1,
      dimensionMismatches: 0,
      targetMaskingFiles: 1,
      targetOwnedMasking: 0,
      exceptionPolicyErrors: 0,
    },
    rawDiffs: [
      {
        id: item.id,
        kind: item.kind,
        referencePath: item.referencePath,
        snapshotPath: evidence.capturedSnapshotPath,
        dimensionMismatch: false,
        ratio: mode === 'signoff' ? contract.rawDiffPixelRatio : 0.02,
        acceptanceRatio: mode === 'signoff' ? contract.acceptanceDiffPixelRatio : 0.02,
        acceptanceMetric: 'pixelmatch-aa-excluded-v1',
        structuralRatio: mode === 'signoff' ? 0 : 0.02,
        structuralMetric: 'pixelmatch-raw-masked-sobel-jaccard-v3',
        structuralThreshold: 0,
        aboveStructuralBase: mode !== 'signoff',
        baseThreshold: mode === 'signoff' ? contract.maxDiffPixelRatio : 0.003,
        aboveBase: mode !== 'signoff',
      },
    ],
    targetMaskingAudit: { inspectedFiles: ['client/src/Target.tsx'] },
    targetOwnedMasking: [],
    exceptionPolicyErrors: [],
  };
  return {
    receipt,
    update: baselineUpdate,
    signoff,
    baselineUpdate,
    item,
    manifestKey: reference.manifestKey,
    manifestEntry: reference.manifestEntry,
    snapshotPath,
    maxDiffPixelRatio: signoff.maxDiffPixelRatio,
    maxBaselineReproducibilityRatio: 0.0005,
    evidence,
    strictAudit,
  };
}

test('reference receipt is bound to its exact manifest, targets, approval and acquisition evidence', () => {
  const fixture = referenceFixture();
  assert.deepEqual(referencePromotionReceiptIssues(fixture), []);

  for (const [label, mutate, pattern] of [
    ['manifest', (value) => (value.receipt.target.manifestKey = 'another-target'), /manifest key/],
    ['targets', (value) => (value.receipt.target.registryIds = ['target-a']), /registry targets/],
    ['approval', (value) => (value.receipt.approval.approvedBy = 'Someone else'), /approver/],
    [
      'evidence',
      (value) => (value.acquisitionEvidence.target.registryId = 'unowned-target'),
      /not owned/,
    ],
  ]) {
    const changed = structuredClone(fixture);
    mutate(changed);
    assert.match(referencePromotionReceiptIssues(changed).join(' '), pattern, label);
  }
});

test('baseline receipt cannot be reused for another target, snapshot, approval, renderer or evidence', () => {
  const fixture = visualFixture('measure');
  assert.deepEqual(baselinePromotionReceiptIssues(fixture), []);

  for (const [label, mutate, pattern] of [
    ['target', (value) => (value.receipt.target.id = 'target-b'), /target/],
    ['snapshot', (value) => (value.receipt.target.snapshotPath = 'other.png'), /snapshot path/],
    [
      'approval',
      (value) => (value.receipt.approval.reason = 'Different approval'),
      /approval reason/,
    ],
    ['renderer', (value) => (value.receipt.contract.rendererFingerprint = hash('z')), /renderer/],
    ['evidence', (value) => (value.evidence.id = 'target-b'), /Evidence target/],
  ]) {
    const changed = structuredClone(fixture);
    mutate(changed);
    assert.match(baselinePromotionReceiptIssues(changed).join(' '), pattern, label);
  }
});

test('parity receipt is bound to baseline receipt, current threshold and exact strict evidence', () => {
  const fixture = visualFixture('signoff');
  assert.notEqual(fixture.signoff.snapshotSha256, fixture.signoff.captureSha256);
  assert.deepEqual(parityAttestationReceiptIssues(fixture), []);

  for (const [label, mutate, pattern] of [
    [
      'baseline receipt',
      (value) => (value.receipt.contract.baselinePromotionReceiptSha256 = hash('x')),
      /baseline promotion receipt/,
    ],
    [
      'threshold',
      (value) => (value.receipt.contract.maxDiffPixelRatio = 0.01),
      /threshold|maximum diff ratio/,
    ],
    [
      'strict ratio',
      (value) => (value.strictAudit.rawDiffs[0].ratio = 0.002),
      /strict-audit ratio/,
    ],
    [
      'forged structural threshold flags',
      (value) => (value.strictAudit.rawDiffs[0].structuralRatio = 0.02),
      /structural edge threshold/,
    ],
    [
      'baseline reproducibility ratio',
      (value) => (value.evidence.capture.baselineReproducibility.ratio = 0.0002),
      /baseline reproducibility ratio/,
    ],
    [
      'current baseline reproducibility threshold',
      (value) => (value.evidence.capture.baselineReproducibility.maxRatio = 0.0004),
      /baseline reproducibility threshold/,
    ],
    [
      'diagnosis pair',
      (value) => delete value.receipt.artifacts.designDiagnosisHtml,
      /artifact names|diagnosis HTML hash/,
    ],
    [
      'diagnosis inspection hash',
      (value) => (value.evidence.inspections.designDiagnosisSha256 = hash('x')),
      /diagnosis JSON hash/,
    ],
    [
      'capture evidence',
      (value) => (value.evidence.capture.snapshotSha256 = hash('x')),
      /capture hash/,
    ],
  ]) {
    const changed = structuredClone(fixture);
    mutate(changed);
    assert.match(parityAttestationReceiptIssues(changed).join(' '), pattern, label);
  }
});
