import { sha256, stableJson } from './figma-reference-run.mjs';
import { validateRendererRuntimeAttestation } from './figma-renderer-contract.mjs';
import { assertFocusedStrictAudit } from './figma-strict-evidence.mjs';

function same(left, right) {
  return stableJson(left) === stableJson(right);
}

function expectEqual(issues, label, actual, expected) {
  if (!same(actual, expected)) issues.push(`${label} does not match the current contract.`);
}

function expectStringSet(issues, label, actual, expected) {
  const actualValues = Array.isArray(actual) ? [...actual].sort() : actual;
  const expectedValues = Array.isArray(expected) ? [...expected].sort() : expected;
  expectEqual(issues, label, actualValues, expectedValues);
}

function approvalIssues(receipt, record) {
  const issues = [];
  expectEqual(issues, 'Receipt approval time', receipt?.approvedAt, record?.approvedAt);
  expectEqual(issues, 'Receipt approver', receipt?.approval?.approvedBy, record?.approvedBy);
  expectEqual(issues, 'Receipt lease owner', receipt?.approval?.leaseOwner, record?.leaseOwner);
  expectEqual(issues, 'Receipt approval reason', receipt?.approval?.reason, record?.reason);
  return issues;
}

function artifactPointerIssues(receipt, expectedPointers) {
  const issues = [];
  expectStringSet(
    issues,
    'Receipt artifact names',
    Object.keys(receipt?.artifacts ?? {}),
    Object.keys(expectedPointers)
  );
  for (const [name, pointer] of Object.entries(expectedPointers)) {
    expectEqual(issues, `Receipt ${name} artifact`, receipt?.artifacts?.[name], pointer);
  }
  return issues;
}

function visualEvidenceIssues({
  receipt,
  evidence,
  strictAudit,
  item,
  manifestKey,
  manifestEntry,
  snapshotPath,
  mode,
}) {
  const issues = [];
  const expectedArtifacts = [
    'capture',
    'designDiagnosis',
    'designDiagnosisHtml',
    'diffReport',
    'evidence',
    'strictAudit',
  ];
  expectStringSet(
    issues,
    'Visual receipt artifact names',
    Object.keys(receipt?.artifacts ?? {}),
    expectedArtifacts
  );
  if (!evidence || typeof evidence !== 'object') {
    return ['Receipt evidence artifact is not valid JSON evidence.'];
  }
  if (![1, 2].includes(evidence.schemaVersion)) {
    issues.push('Evidence schema version does not match the current contract.');
  }
  expectEqual(issues, 'Evidence kind', evidence.kind, 'figma-parity-evidence');
  expectEqual(issues, 'Evidence target', evidence.id, item?.id);
  expectEqual(issues, 'Evidence mode', evidence.mode, mode);
  expectEqual(issues, 'Evidence run id', evidence.runId, receipt?.runId);
  expectEqual(issues, 'Evidence visual test', evidence.visualTest, item?.visualTest);
  expectEqual(
    issues,
    'Evidence result',
    evidence.result,
    mode === 'signoff' ? 'passed' : 'completed'
  );
  expectEqual(
    issues,
    'Evidence canonical snapshot path',
    evidence.canonicalSnapshotPath,
    snapshotPath
  );
  expectEqual(
    issues,
    'Evidence reference source kind',
    evidence.referenceSource?.kind,
    'canonical-manifest'
  );
  expectEqual(
    issues,
    'Evidence reference manifest key',
    evidence.referenceSource?.manifestKey,
    manifestKey
  );
  expectEqual(
    issues,
    'Evidence reference path',
    evidence.referencePath,
    manifestEntry?.artifactPath ?? manifestEntry?.referencePath
  );
  expectEqual(
    issues,
    'Evidence reference-before hash',
    evidence.before?.referenceSha256,
    receipt?.contract?.referenceSha256
  );
  expectEqual(
    issues,
    'Evidence captured reference hash',
    evidence.capture?.referenceSha256,
    receipt?.contract?.referenceSha256
  );
  expectEqual(
    issues,
    'Evidence baseline-before hash',
    evidence.before?.snapshotSha256 ?? null,
    mode === 'measure'
      ? (receipt?.contract?.beforeSha256 ?? null)
      : receipt?.contract?.snapshotSha256
  );
  expectEqual(
    issues,
    'Evidence capture hash',
    evidence.capture?.snapshotSha256,
    receipt?.contract?.captureSha256
  );
  if (mode === 'signoff') {
    expectEqual(
      issues,
      'Evidence baseline reproducibility baseline hash',
      evidence.capture?.baselineReproducibility?.baselineSha256,
      receipt?.contract?.snapshotSha256
    );
    expectEqual(
      issues,
      'Evidence baseline reproducibility capture hash',
      evidence.capture?.baselineReproducibility?.captureSha256,
      receipt?.contract?.captureSha256
    );
    expectEqual(
      issues,
      'Evidence baseline reproducibility metric',
      evidence.capture?.baselineReproducibility?.metric,
      'pixelmatch-aa-excluded-v1'
    );
    if (
      evidence.capture?.baselineReproducibility?.dimensionMismatch !== false ||
      evidence.capture?.baselineReproducibility?.ratio >
        evidence.capture?.baselineReproducibility?.maxRatio
    ) {
      issues.push('Evidence capture exceeds the baseline reproducibility contract.');
    }
  }
  expectEqual(
    issues,
    'Evidence renderer fingerprint',
    evidence.rendererState ? sha256(stableJson(evidence.rendererState)) : null,
    receipt?.contract?.rendererFingerprint
  );
  const rendererFingerprint = evidence.rendererState
    ? sha256(stableJson(evidence.rendererState))
    : null;
  try {
    validateRendererRuntimeAttestation(evidence.rendererRuntime, evidence.rendererState);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  expectEqual(
    issues,
    'Evidence renderer pre-capture fingerprint',
    evidence.rendererMutationGuard?.beforeFingerprint,
    rendererFingerprint
  );
  expectEqual(
    issues,
    'Evidence renderer post-capture fingerprint',
    evidence.rendererMutationGuard?.afterFingerprint,
    rendererFingerprint
  );
  expectEqual(
    issues,
    'Evidence renderer mutation result',
    evidence.rendererMutationGuard?.changed,
    false
  );
  expectEqual(
    issues,
    'Evidence target source fingerprint',
    evidence.targetSourceState?.fingerprint,
    receipt?.contract?.targetSourceFingerprint
  );
  expectEqual(
    issues,
    'Evidence target source pre-capture fingerprint',
    evidence.targetSourceMutationGuard?.beforeFingerprint,
    receipt?.contract?.targetSourceFingerprint
  );
  expectEqual(
    issues,
    'Evidence target source post-capture fingerprint',
    evidence.targetSourceMutationGuard?.afterFingerprint,
    receipt?.contract?.targetSourceFingerprint
  );
  expectEqual(
    issues,
    'Evidence target source mutation result',
    evidence.targetSourceMutationGuard?.changed,
    false
  );
  expectEqual(
    issues,
    'Evidence reference mutation result',
    evidence.referenceMutationGuard?.changed,
    false
  );
  expectEqual(issues, 'Evidence accepted baseline changes', evidence.acceptedBaselineChanges, []);
  expectEqual(
    issues,
    'Evidence capture baseline changes',
    evidence.capture?.acceptedBaselinesChanged,
    []
  );
  expectEqual(
    issues,
    'Evidence strict-audit hash',
    evidence.inspections?.strictAuditSha256,
    receipt?.artifacts?.strictAudit?.sha256
  );
  expectEqual(
    issues,
    'Evidence diff-report hash',
    evidence.inspections?.diffReportSha256,
    receipt?.artifacts?.diffReport?.sha256
  );
  expectEqual(
    issues,
    'Evidence design diagnosis JSON hash',
    evidence.inspections?.designDiagnosisSha256,
    receipt?.artifacts?.designDiagnosis?.sha256
  );
  expectEqual(
    issues,
    'Evidence design diagnosis HTML hash',
    evidence.inspections?.designDiagnosisHtmlSha256,
    receipt?.artifacts?.designDiagnosisHtml?.sha256
  );

  if (!strictAudit || typeof strictAudit !== 'object') {
    issues.push('Receipt strict-audit artifact is not valid JSON evidence.');
    return issues;
  }
  try {
    assertFocusedStrictAudit({
      audit: strictAudit,
      id: item?.id,
      evidenceMode: mode,
      capturedSnapshotPath: evidence.capturedSnapshotPath,
    });
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  const exactRows = (strictAudit.rawDiffs ?? []).filter((row) => row.id === item?.id);
  expectEqual(issues, 'Strict-audit target comparison count', exactRows.length, 1);
  expectEqual(issues, 'Strict-audit total comparison count', strictAudit.counts?.rawDiffs, 1);
  if (exactRows.length === 1) {
    expectEqual(
      issues,
      'Strict-audit reference path',
      exactRows[0].referencePath,
      item?.referencePath
    );
    expectEqual(issues, 'Strict-audit target kind', exactRows[0].kind, item?.kind);
  }
  return issues;
}

export function referencePromotionReceiptIssues({
  receipt,
  manifest,
  manifestKey,
  manifestEntry,
  acquisitionEvidence,
}) {
  const issues = [];
  const acquisition = manifestEntry?.acquisition;
  expectEqual(issues, 'Reference receipt schema version', receipt?.schemaVersion, 1);
  expectEqual(issues, 'Reference receipt kind', receipt?.kind, 'figma-reference-promotion');
  expectEqual(issues, 'Reference receipt manifest key', receipt?.target?.manifestKey, manifestKey);
  expectStringSet(
    issues,
    'Reference receipt registry targets',
    receipt?.target?.registryIds,
    manifestEntry?.registryIds
  );
  expectEqual(issues, 'Reference receipt run id', receipt?.runId, acquisition?.runId);
  expectEqual(
    issues,
    'Reference receipt review digest',
    receipt?.reviewSha256,
    acquisition?.reviewSha256
  );
  expectEqual(
    issues,
    'Reference receipt acquired time',
    receipt?.acquiredAt,
    acquisition?.acquiredAt
  );
  expectEqual(
    issues,
    'Reference receipt promoted time',
    receipt?.promotedAt,
    acquisition?.promotedAt
  );
  issues.push(...approvalIssues(receipt, acquisition));
  issues.push(
    ...artifactPointerIssues(receipt, {
      acquisitionEvidence: acquisition?.evidence,
      reference: {
        path: manifestEntry?.artifactPath,
        sha256: manifestEntry?.assetSha256,
      },
      node: acquisition?.node,
      variables: acquisition?.variables,
      ...(acquisition?.comparisonDiff ? { comparisonDiff: acquisition.comparisonDiff } : {}),
    })
  );
  expectEqual(
    issues,
    'Reference receipt file key',
    receipt?.source?.file?.key,
    manifest?.figmaFile?.key
  );
  expectEqual(
    issues,
    'Reference receipt file name',
    receipt?.source?.file?.name,
    manifest?.figmaFile?.name
  );
  expectEqual(
    issues,
    'Reference receipt page id',
    receipt?.source?.page?.id,
    manifestEntry?.figma?.pageId
  );
  expectEqual(
    issues,
    'Reference receipt page name',
    receipt?.source?.page?.name,
    manifestEntry?.figma?.pageName
  );
  expectEqual(
    issues,
    'Reference receipt node id',
    receipt?.source?.node?.id,
    manifestEntry?.figma?.nodeId
  );
  expectEqual(
    issues,
    'Reference receipt node name',
    receipt?.source?.node?.name,
    manifestEntry?.figma?.nodeName
  );
  expectEqual(
    issues,
    'Reference receipt node type',
    receipt?.source?.node?.type,
    manifestEntry?.figma?.nodeType
  );
  expectEqual(
    issues,
    'Reference receipt node dimensions',
    {
      width: receipt?.source?.node?.bounds?.width,
      height: receipt?.source?.node?.bounds?.height,
    },
    manifestEntry?.figma?.liveBounds
  );
  expectEqual(
    issues,
    'Reference receipt export dimensions',
    receipt?.source?.export?.bounds,
    manifestEntry?.exportBounds
  );
  expectEqual(
    issues,
    'Reference receipt export hash',
    receipt?.source?.export?.sha256,
    manifestEntry?.assetSha256
  );
  expectEqual(
    issues,
    'Reference receipt export spec',
    receipt?.source?.export?.spec,
    acquisition?.exportSpec
  );
  expectEqual(
    issues,
    'Reference receipt node hash',
    receipt?.source?.node?.sha256,
    acquisition?.nodeSha256
  );
  expectEqual(
    issues,
    'Reference receipt variables hash',
    receipt?.source?.variables?.sha256,
    acquisition?.variablesSha256
  );
  expectEqual(
    issues,
    'Reference receipt predecessor hash',
    receipt?.canonicalBefore?.sha256,
    acquisition?.previousAssetSha256
  );
  expectEqual(
    issues,
    'Reference acquisition file key',
    acquisition?.fileKey,
    manifest?.figmaFile?.key
  );
  expectEqual(
    issues,
    'Reference acquisition file name',
    acquisition?.fileName,
    manifest?.figmaFile?.name
  );
  expectEqual(
    issues,
    'Reference acquisition page id',
    acquisition?.pageId,
    manifestEntry?.figma?.pageId
  );
  expectEqual(
    issues,
    'Reference acquisition page name',
    acquisition?.pageName,
    manifestEntry?.figma?.pageName
  );
  expectEqual(
    issues,
    'Reference acquisition node id',
    acquisition?.nodeId,
    manifestEntry?.figma?.nodeId
  );
  expectEqual(
    issues,
    'Reference acquisition export hash',
    acquisition?.exportSha256,
    manifestEntry?.assetSha256
  );

  if (!acquisitionEvidence || typeof acquisitionEvidence !== 'object') {
    issues.push('Reference acquisition evidence artifact is not valid JSON evidence.');
    return issues;
  }
  expectEqual(issues, 'Reference evidence schema version', acquisitionEvidence.schemaVersion, 1);
  expectEqual(
    issues,
    'Reference evidence kind',
    acquisitionEvidence.kind,
    'figma-reference-acquisition'
  );
  expectEqual(issues, 'Reference evidence run id', acquisitionEvidence.runId, receipt?.runId);
  expectEqual(
    issues,
    'Reference evidence manifest key',
    acquisitionEvidence.target?.manifestKey,
    manifestKey
  );
  expectEqual(
    issues,
    'Reference evidence logical path',
    acquisitionEvidence.target?.logicalReferencePath,
    manifestEntry?.referencePath
  );
  if (!manifestEntry?.registryIds?.includes(acquisitionEvidence.target?.registryId)) {
    issues.push('Reference evidence target is not owned by the current manifest entry.');
  }
  expectEqual(issues, 'Reference evidence source', acquisitionEvidence.source, receipt?.source);
  expectEqual(
    issues,
    'Reference evidence predecessor',
    acquisitionEvidence.canonicalBefore,
    receipt?.canonicalBefore
  );
  expectEqual(
    issues,
    'Reference evidence acquired time',
    acquisitionEvidence.acquiredAt,
    receipt?.acquiredAt
  );
  expectEqual(issues, 'Reference evidence result', acquisitionEvidence.result, 'staged');
  expectEqual(
    issues,
    'Reference evidence adapter',
    acquisitionEvidence.acquisition?.adapter,
    acquisition?.adapter
  );
  expectEqual(
    issues,
    'Reference evidence adapter version',
    acquisitionEvidence.acquisition?.adapterVersion,
    acquisition?.adapterVersion
  );
  expectEqual(
    issues,
    'Reference evidence protocol',
    acquisitionEvidence.acquisition?.protocol,
    acquisition?.protocol
  );
  expectEqual(
    issues,
    'Reference evidence plugin',
    acquisitionEvidence.acquisition?.plugin,
    acquisition?.plugin
  );
  expectEqual(
    issues,
    'Reference evidence operations',
    acquisitionEvidence.acquisition?.operations,
    acquisition?.operations
  );
  return issues;
}

export function baselinePromotionReceiptIssues({
  receipt,
  update,
  item,
  manifestKey,
  manifestEntry,
  snapshotPath,
  evidence,
  strictAudit,
}) {
  const issues = [];
  expectEqual(issues, 'Baseline receipt schema version', receipt?.schemaVersion, 1);
  expectEqual(issues, 'Baseline receipt kind', receipt?.kind, 'figma-baseline-promotion');
  expectEqual(issues, 'Baseline receipt target', receipt?.target?.id, item?.id);
  expectEqual(issues, 'Baseline receipt manifest key', receipt?.target?.manifestKey, manifestKey);
  expectEqual(
    issues,
    'Baseline receipt snapshot path',
    receipt?.target?.snapshotPath,
    snapshotPath
  );
  expectEqual(issues, 'Baseline receipt run id', receipt?.runId, update?.measurementRunId);
  expectEqual(
    issues,
    'Baseline receipt review digest',
    receipt?.reviewSha256,
    update?.evidenceSha256
  );
  issues.push(...approvalIssues(receipt, update));
  for (const [label, actual, expected] of [
    [
      'target source fingerprint',
      receipt?.contract?.targetSourceFingerprint,
      update?.targetSourceFingerprint,
    ],
    ['renderer fingerprint', receipt?.contract?.rendererFingerprint, update?.rendererFingerprint],
    ['reference hash', receipt?.contract?.referenceSha256, update?.referenceSha256],
    [
      'reference acquisition receipt',
      receipt?.contract?.referenceAcquisitionReceiptSha256,
      update?.referenceAcquisitionReceiptSha256,
    ],
    ['baseline-before hash', receipt?.contract?.beforeSha256 ?? null, update?.beforeSha256 ?? null],
    ['baseline-after hash', receipt?.contract?.afterSha256, update?.afterSha256],
    ['capture hash', receipt?.contract?.captureSha256, update?.captureSha256],
  ]) {
    expectEqual(issues, `Baseline receipt ${label}`, actual, expected);
  }
  expectEqual(
    issues,
    'Baseline receipt current reference hash',
    receipt?.contract?.referenceSha256,
    manifestEntry?.assetSha256
  );
  expectEqual(
    issues,
    'Baseline receipt current acquisition receipt',
    receipt?.contract?.referenceAcquisitionReceiptSha256,
    manifestEntry?.acquisition?.receipt?.sha256
  );
  expectEqual(
    issues,
    'Baseline receipt capture artifact',
    receipt?.artifacts?.capture?.sha256,
    receipt?.contract?.captureSha256
  );
  expectEqual(
    issues,
    'Baseline receipt promoted pixels',
    receipt?.contract?.afterSha256,
    receipt?.contract?.captureSha256
  );
  issues.push(
    ...visualEvidenceIssues({
      receipt,
      evidence,
      strictAudit,
      item,
      manifestKey,
      manifestEntry,
      snapshotPath,
      mode: 'measure',
    })
  );
  return issues;
}

export function parityAttestationReceiptIssues({
  receipt,
  signoff,
  baselineUpdate,
  item,
  manifestKey,
  manifestEntry,
  snapshotPath,
  maxDiffPixelRatio,
  maxBaselineReproducibilityRatio,
  evidence,
  strictAudit,
}) {
  const issues = [];
  expectEqual(issues, 'Parity receipt schema version', receipt?.schemaVersion, 1);
  expectEqual(issues, 'Parity receipt kind', receipt?.kind, 'figma-parity-attestation');
  expectEqual(issues, 'Parity receipt target', receipt?.target?.id, item?.id);
  expectEqual(issues, 'Parity receipt manifest key', receipt?.target?.manifestKey, manifestKey);
  expectEqual(issues, 'Parity receipt run id', receipt?.runId, signoff?.runId);
  expectEqual(
    issues,
    'Parity receipt review digest',
    receipt?.reviewSha256,
    signoff?.evidenceSha256
  );
  issues.push(...approvalIssues(receipt, signoff));
  for (const [label, actual, expected] of [
    [
      'target source fingerprint',
      receipt?.contract?.targetSourceFingerprint,
      signoff?.targetSourceFingerprint,
    ],
    ['renderer fingerprint', receipt?.contract?.rendererFingerprint, signoff?.rendererFingerprint],
    ['reference hash', receipt?.contract?.referenceSha256, signoff?.referenceSha256],
    [
      'reference acquisition receipt',
      receipt?.contract?.referenceAcquisitionReceiptSha256,
      signoff?.referenceAcquisitionReceiptSha256,
    ],
    [
      'baseline promotion receipt',
      receipt?.contract?.baselinePromotionReceiptSha256,
      signoff?.baselinePromotionReceiptSha256,
    ],
    ['snapshot hash', receipt?.contract?.snapshotSha256, signoff?.snapshotSha256],
    ['capture hash', receipt?.contract?.captureSha256, signoff?.captureSha256],
    ['raw diff ratio', receipt?.contract?.rawDiffPixelRatio, signoff?.rawDiffPixelRatio],
    [
      'acceptance diff ratio',
      receipt?.contract?.acceptanceDiffPixelRatio,
      signoff?.acceptanceDiffPixelRatio,
    ],
    ['acceptance metric', receipt?.contract?.acceptanceMetric, signoff?.acceptanceMetric],
    [
      'baseline reproducibility ratio',
      receipt?.contract?.baselineReproducibilityRatio,
      signoff?.baselineReproducibilityRatio,
    ],
    ['maximum diff ratio', receipt?.contract?.maxDiffPixelRatio, signoff?.maxDiffPixelRatio],
  ]) {
    expectEqual(issues, `Parity receipt ${label}`, actual, expected);
  }
  expectEqual(
    issues,
    'Parity receipt current reference hash',
    receipt?.contract?.referenceSha256,
    manifestEntry?.assetSha256
  );
  expectEqual(
    issues,
    'Parity receipt current acquisition receipt',
    receipt?.contract?.referenceAcquisitionReceiptSha256,
    manifestEntry?.acquisition?.receipt?.sha256
  );
  expectEqual(
    issues,
    'Parity receipt current baseline receipt',
    receipt?.contract?.baselinePromotionReceiptSha256,
    baselineUpdate?.receipt?.sha256
  );
  expectEqual(
    issues,
    'Parity receipt current threshold',
    receipt?.contract?.maxDiffPixelRatio,
    maxDiffPixelRatio
  );
  expectEqual(
    issues,
    'Parity evidence baseline reproducibility ratio',
    evidence?.capture?.baselineReproducibility?.ratio,
    receipt?.contract?.baselineReproducibilityRatio
  );
  expectEqual(
    issues,
    'Parity evidence current baseline reproducibility threshold',
    evidence?.capture?.baselineReproducibility?.maxRatio,
    maxBaselineReproducibilityRatio
  );
  expectEqual(
    issues,
    'Parity receipt capture artifact',
    receipt?.artifacts?.capture?.sha256,
    receipt?.contract?.captureSha256
  );
  issues.push(
    ...visualEvidenceIssues({
      receipt,
      evidence,
      strictAudit,
      item,
      manifestKey,
      manifestEntry,
      snapshotPath,
      mode: 'signoff',
    })
  );
  const exactRows = (strictAudit?.rawDiffs ?? []).filter((row) => row.id === item?.id);
  if (exactRows.length === 1) {
    expectEqual(
      issues,
      'Parity receipt strict-audit ratio',
      receipt?.contract?.rawDiffPixelRatio,
      exactRows[0].ratio
    );
    expectEqual(
      issues,
      'Parity receipt strict-audit acceptance ratio',
      receipt?.contract?.acceptanceDiffPixelRatio,
      exactRows[0].acceptanceRatio
    );
    expectEqual(
      issues,
      'Parity receipt strict-audit acceptance metric',
      receipt?.contract?.acceptanceMetric,
      exactRows[0].acceptanceMetric
    );
    expectEqual(
      issues,
      'Parity receipt strict-audit threshold',
      receipt?.contract?.maxDiffPixelRatio,
      exactRows[0].baseThreshold
    );
    expectEqual(issues, 'Parity strict-audit above-base result', exactRows[0].aboveBase, false);
  }
  expectEqual(issues, 'Parity evidence outcome', evidence?.parity?.outcome, 'within-threshold');
  expectEqual(
    issues,
    'Parity evidence acceptance above-base count',
    evidence?.parity?.acceptanceAboveBase,
    0
  );
  expectEqual(issues, 'Parity evidence comparison count', evidence?.parity?.rawDiffs, 1);
  expectEqual(
    issues,
    'Parity strict-audit acceptance above-base count',
    strictAudit?.counts?.acceptanceAboveBase,
    0
  );
  return issues;
}

export function assertReceiptContract(issues, label) {
  if (issues.length)
    throw new Error(`${label} contradicts the current contract: ${issues.join(' ')}`);
}
