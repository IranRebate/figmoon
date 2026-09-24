#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_ROOT,
  DURABLE_EVIDENCE_ROOT,
  MANIFEST_PATH,
  REGISTRY_PATH,
  REPO_ROOT,
  atomicWriteFile,
  loadVisualEvidenceRun,
  rendererFingerprint,
  resolveManifestArtifact,
  sha256,
  stableJson,
  validateReviewer,
  validateRunId,
} from './lib/figma-reference-run.mjs';
import {
  assertDesignLease,
  assertExpectedDigest,
  durablePointer,
  installContentAddressedJson,
  resolveDurablePointer,
  sealReviewedBundle,
  validateJsonDocument,
  withContractPromotionMutex,
} from './lib/figma-promotion.mjs';
import {
  assertReceiptContract,
  baselinePromotionReceiptIssues,
  parityAttestationReceiptIssues,
  referencePromotionReceiptIssues,
} from './lib/figma-receipt-contract.mjs';
import {
  assertTargetSourceFingerprint,
  assertVisualEvidenceTargetSource,
  targetSourceState,
} from './lib/figma-target-closure.mjs';
import { resolveCanonicalSnapshotPath } from './lib/figma-snapshot-contract.mjs';

import { getFigmoonConfig } from '../lib/config.mjs';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const __figmoonConfig = getFigmoonConfig();
const registrySchemaPath = __figmoonConfig.registrySchemaPath;
const snapshotRoot = __figmoonConfig.snapshotRoot;
const dependencyGraphPath = __figmoonConfig.dependencyGraphPath;
const screenRegistryPath = __figmoonConfig.screenRegistryPath;

function parseArgs(argv) {
  const allowed = new Set([
    '--id',
    '--run-id',
    '--expected-run-sha256',
    '--approved-by',
    '--lease-owner',
    '--reason',
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equalsIndex = argument.indexOf('=');
    const flag = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
    if (!allowed.has(flag)) throw new Error(`Unsupported figma:attest argument: ${argument}`);
    if (Object.hasOwn(parsed, flag)) throw new Error(`${flag} may be provided only once.`);
    const value = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires exactly one value.`);
    parsed[flag] = value;
  }
  for (const flag of allowed) {
    if (!parsed[flag]) throw new Error(`figma:attest requires exactly one ${flag} value.`);
  }
  return parsed;
}

function runPreflight(id) {
  const result = spawnSync(
    process.execPath,
    [join(scriptDir, 'check-figma-refs.mjs'), '--id', id, '--require-signoff'],
    { cwd: CLIENT_ROOT, env: process.env, stdio: 'inherit' }
  );
  if (result.status !== 0) throw new Error(`Figma attestation preflight failed for '${id}'.`);
}

function currentTargetSourceState(item) {
  return targetSourceState({
    item,
    dependencyGraph: JSON.parse(readFileSync(dependencyGraphPath, 'utf8')),
    screenRegistry: JSON.parse(readFileSync(screenRegistryPath, 'utf8')),
    repoRoot: REPO_ROOT,
  });
}

const parsed = parseArgs(process.argv.slice(2));
const id = parsed['--id'];
const runId = validateRunId(parsed['--run-id']);
const expectedRunSha256 = assertExpectedDigest(parsed['--expected-run-sha256']);
const approvedBy = validateReviewer(parsed['--approved-by']);
const leaseOwner = parsed['--lease-owner'];
const reason = parsed['--reason'].trim();
if (reason.length < 12) throw new Error('--reason must record the reviewed signoff decision.');

assertDesignLease({ id, owner: leaseOwner, mode: 'implementation' });
runPreflight(id);

await withContractPromotionMutex(async () => {
  assertDesignLease({ id, owner: leaseOwner, mode: 'implementation' });
  const registryBefore = readFileSync(REGISTRY_PATH);
  const manifestBefore = readFileSync(MANIFEST_PATH);
  const registry = JSON.parse(registryBefore.toString('utf8'));
  const manifest = JSON.parse(manifestBefore.toString('utf8'));
  const item = registry.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown registry id '${id}'.`);
  if (!item.snapshot || !item.visualTest?.file || !item.visualTest?.name) {
    throw new Error(`Figma attestation requires a complete visual contract for '${id}'.`);
  }
  if (item.referenceStatus !== 'mapped' || item.implementationStatus !== 'implemented') {
    throw new Error(`Figma attestation requires a mapped, implemented target: '${id}'.`);
  }
  const baselinePromotionReceiptSha256 = item.baselineUpdate?.receipt?.sha256;
  if (!/^[a-f0-9]{64}$/.test(baselinePromotionReceiptSha256 ?? '')) {
    throw new Error('Figma attestation requires a reviewed durable baseline promotion receipt.');
  }

  const manifestMatches = Object.entries(manifest.items ?? {}).filter(([, entry]) =>
    entry.registryIds?.includes(id)
  );
  if (manifestMatches.length !== 1) {
    throw new Error(`Registry target '${id}' must have exactly one Figma manifest owner.`);
  }
  const [[manifestKey, manifestEntry]] = manifestMatches;
  const acquisitionReceiptPath = resolveDurablePointer(manifestEntry.acquisition?.receipt, {
    root: DURABLE_EVIDENCE_ROOT,
    extensions: ['json'],
    label: 'Canonical reference acquisition receipt',
  });
  const acquisitionReceipt = JSON.parse(readFileSync(acquisitionReceiptPath, 'utf8'));
  if (
    acquisitionReceipt.kind !== 'figma-reference-promotion' ||
    acquisitionReceipt.reviewSha256 !== manifestEntry.acquisition.reviewSha256 ||
    acquisitionReceipt.artifacts?.reference?.sha256 !== manifestEntry.assetSha256 ||
    !acquisitionReceipt.target?.registryIds?.includes(id)
  ) {
    throw new Error('Canonical reference acquisition receipt contradicts the manifest contract.');
  }
  const acquisitionEvidencePath = resolveDurablePointer(manifestEntry.acquisition?.evidence, {
    root: DURABLE_EVIDENCE_ROOT,
    extensions: ['json'],
    label: 'Canonical reference acquisition evidence',
  });
  assertReceiptContract(
    referencePromotionReceiptIssues({
      receipt: acquisitionReceipt,
      manifest,
      manifestKey,
      manifestEntry,
      acquisitionEvidence: JSON.parse(readFileSync(acquisitionEvidencePath, 'utf8')),
    }),
    'Canonical reference acquisition receipt'
  );

  let run = loadVisualEvidenceRun({ runId, id, mode: 'signoff' });
  if (run.reviewSha256 !== expectedRunSha256) {
    throw new Error(
      `Reviewed signoff digest mismatch: expected ${expectedRunSha256}, current run is ${run.reviewSha256}.`
    );
  }
  let evidence = run.evidence;
  if (evidence.referenceSource?.kind !== 'canonical-manifest') {
    throw new Error('Figma attestation accepts only a canonical-manifest signoff run.');
  }
  if (evidence.referenceSource.manifestKey !== manifestKey) {
    throw new Error('Figma manifest ownership changed after signoff.');
  }
  if (
    evidence.parity?.outcome !== 'within-threshold' ||
    evidence.parity?.acceptanceAboveBase !== 0 ||
    evidence.parity?.structuralAboveBase !== 0 ||
    evidence.parity?.rawDiffs !== 1
  ) {
    throw new Error(
      'Signoff evidence does not prove exactly one canonical within-threshold comparison.'
    );
  }

  const canonicalReferencePath = resolveManifestArtifact(manifestEntry);
  const referenceSha256 = sha256(readFileSync(canonicalReferencePath));
  if (
    referenceSha256 !== manifestEntry.assetSha256 ||
    referenceSha256 !== evidence.before?.referenceSha256 ||
    referenceSha256 !== evidence.capture?.referenceSha256
  ) {
    throw new Error('Canonical Figma reference changed after signoff.');
  }
  const currentTargetSource = currentTargetSourceState(item);
  assertVisualEvidenceTargetSource(evidence, currentTargetSource, 'Reviewed signoff run');
  const currentRenderer = rendererFingerprint();
  if (stableJson(currentRenderer) !== stableJson(evidence.rendererState)) {
    throw new Error('Renderer/font fingerprint changed after signoff; run signoff again.');
  }

  const canonicalBaselinePath = resolveCanonicalSnapshotPath({ item, snapshotRoot });
  const snapshotSha256 = sha256(readFileSync(canonicalBaselinePath));
  if (snapshotSha256 !== evidence.before?.snapshotSha256) {
    throw new Error('Accepted target baseline changed after signoff.');
  }
  const baselineReproducibility = evidence.capture?.baselineReproducibility;
  if (
    baselineReproducibility?.metric !== 'pixelmatch-aa-excluded-v1' ||
    baselineReproducibility?.dimensionMismatch !== false ||
    baselineReproducibility?.baselineSha256 !== snapshotSha256 ||
    baselineReproducibility?.captureSha256 !== evidence.capture?.snapshotSha256 ||
    baselineReproducibility?.maxRatio !== registry._meta.thresholds.regressionBaseline ||
    baselineReproducibility?.ratio > baselineReproducibility?.maxRatio
  ) {
    throw new Error('Signoff capture does not reproduce the accepted baseline within policy.');
  }
  const baselineReceiptPath = resolveDurablePointer(item.baselineUpdate.receipt, {
    root: DURABLE_EVIDENCE_ROOT,
    extensions: ['json'],
    label: 'Canonical baseline promotion receipt',
  });
  const baselineReceipt = JSON.parse(readFileSync(baselineReceiptPath, 'utf8'));
  const baselineEvidencePath = resolveDurablePointer(baselineReceipt.artifacts?.evidence, {
    root: DURABLE_EVIDENCE_ROOT,
    extensions: ['json'],
    label: 'Canonical baseline promotion evidence',
  });
  const baselineStrictAuditPath = resolveDurablePointer(baselineReceipt.artifacts?.strictAudit, {
    root: DURABLE_EVIDENCE_ROOT,
    extensions: ['json'],
    label: 'Canonical baseline promotion strict audit',
  });
  assertReceiptContract(
    baselinePromotionReceiptIssues({
      receipt: baselineReceipt,
      update: item.baselineUpdate,
      item,
      manifestKey,
      manifestEntry,
      snapshotPath: relative(REPO_ROOT, canonicalBaselinePath),
      evidence: JSON.parse(readFileSync(baselineEvidencePath, 'utf8')),
      strictAudit: JSON.parse(readFileSync(baselineStrictAuditPath, 'utf8')),
    }),
    'Canonical baseline promotion receipt'
  );

  const rawDiffs = run.strictAudit.rawDiffs ?? [];
  const exactRawDiff = rawDiffs.filter((entry) => entry.id === id);
  if (
    exactRawDiff.length !== 1 ||
    exactRawDiff[0].aboveBase ||
    run.strictAudit.counts?.acceptanceAboveBase !== 0 ||
    run.strictAudit.counts?.structuralAboveBase !== 0 ||
    run.strictAudit.counts?.rawDiffs !== 1
  ) {
    throw new Error(
      'Strict audit receipt does not prove one target-local canonical within-threshold comparison.'
    );
  }
  const maxDiffPixelRatio =
    item.kind === 'component'
      ? registry._meta.thresholds.figmaParityComponent
      : registry._meta.thresholds.figmaParityPage;
  const maxStructuralEdgeRatio = registry._meta.thresholds.structuralEdgeJaccard;
  if (exactRawDiff[0].acceptanceRatio > maxDiffPixelRatio) {
    throw new Error('Strict AA-aware diff exceeds the canonical parity threshold.');
  }
  if (
    exactRawDiff[0].structuralThreshold !== maxStructuralEdgeRatio ||
    exactRawDiff[0].structuralRatio > maxStructuralEdgeRatio
  ) {
    throw new Error('Strict structural edge diff exceeds the canonical parity threshold.');
  }

  run = loadVisualEvidenceRun({ runId, id, mode: 'signoff' });
  if (run.reviewSha256 !== expectedRunSha256) {
    throw new Error('Reviewed signoff bundle changed while attestation was being prepared.');
  }
  evidence = run.evidence;
  assertTargetSourceFingerprint(
    currentTargetSource.fingerprint,
    currentTargetSourceState(item),
    'Target source contract during parity attestation'
  );
  const sealed = sealReviewedBundle({
    expectedDigest: expectedRunSha256,
    entries: [
      {
        key: 'evidence',
        name: 'evidence.json',
        sourcePath: run.evidencePath,
        root: DURABLE_EVIDENCE_ROOT,
        extension: 'json',
      },
      {
        key: 'capture',
        name: 'capture.png',
        sourcePath: run.capturedSnapshotPath,
        root: DURABLE_EVIDENCE_ROOT,
        extension: 'png',
      },
      {
        key: 'strictAudit',
        name: 'strict-audit.json',
        sourcePath: run.strictAuditPath,
        root: DURABLE_EVIDENCE_ROOT,
        extension: 'json',
      },
      ...(run.designDiagnosisPath && run.designDiagnosisHtmlPath
        ? [
            {
              key: 'designDiagnosis',
              name: 'design-diagnosis.json',
              sourcePath: run.designDiagnosisPath,
              root: DURABLE_EVIDENCE_ROOT,
              extension: 'json',
            },
            {
              key: 'designDiagnosisHtml',
              name: 'design-diagnosis.html',
              sourcePath: run.designDiagnosisHtmlPath,
              root: DURABLE_EVIDENCE_ROOT,
              extension: 'html',
            },
          ]
        : []),
      {
        key: 'diffReport',
        name: 'diff-report.html',
        sourcePath: run.diffReportPath,
        root: DURABLE_EVIDENCE_ROOT,
        extension: 'html',
      },
    ],
  });
  const evidenceArtifact = sealed.evidence;
  const captureArtifact = sealed.capture;
  const strictAuditArtifact = sealed.strictAudit;
  const designDiagnosisArtifact = sealed.designDiagnosis;
  const designDiagnosisHtmlArtifact = sealed.designDiagnosisHtml;
  const diffReportArtifact = sealed.diffReport;
  const approvedAt = new Date().toISOString();
  const receipt = {
    schemaVersion: 1,
    kind: 'figma-parity-attestation',
    target: { id, manifestKey },
    runId,
    reviewSha256: run.reviewSha256,
    approvedAt,
    approval: { approvedBy, leaseOwner, reason },
    contract: {
      targetSourceFingerprint: currentTargetSource.fingerprint,
      rendererFingerprint: sha256(stableJson(currentRenderer)),
      referenceSha256,
      referenceAcquisitionReceiptSha256: manifestEntry.acquisition.receipt.sha256,
      baselinePromotionReceiptSha256,
      snapshotSha256,
      captureSha256: evidence.capture.snapshotSha256,
      rawDiffPixelRatio: exactRawDiff[0].ratio,
      acceptanceDiffPixelRatio: exactRawDiff[0].acceptanceRatio,
      acceptanceMetric: exactRawDiff[0].acceptanceMetric,
      baselineReproducibilityRatio: baselineReproducibility.ratio,
      maxDiffPixelRatio,
    },
    artifacts: {
      evidence: durablePointer(evidenceArtifact),
      capture: durablePointer(captureArtifact),
      strictAudit: durablePointer(strictAuditArtifact),
      ...(designDiagnosisArtifact && designDiagnosisHtmlArtifact
        ? {
            designDiagnosis: durablePointer(designDiagnosisArtifact),
            designDiagnosisHtml: durablePointer(designDiagnosisHtmlArtifact),
          }
        : {}),
      diffReport: durablePointer(diffReportArtifact),
    },
  };
  const receiptArtifact = installContentAddressedJson({
    root: DURABLE_EVIDENCE_ROOT,
    value: receipt,
  });

  item.status = 'figma_parity';
  item.parityStatus = 'parity';
  item.lastVerifiedAt = approvedAt.slice(0, 10);
  item.signoff = {
    schemaVersion: 1,
    runId,
    evidenceSha256: run.reviewSha256,
    receipt: durablePointer(receiptArtifact),
    approvedBy,
    leaseOwner,
    approvedAt,
    reason,
    auditCommand: `npm run figma:signoff -- --id ${id} --run-id ${runId}`,
    targetSourceFingerprint: currentTargetSource.fingerprint,
    rendererFingerprint: sha256(stableJson(currentRenderer)),
    referenceSha256,
    referenceAcquisitionReceiptSha256: manifestEntry.acquisition.receipt.sha256,
    baselinePromotionReceiptSha256,
    snapshotSha256,
    captureSha256: evidence.capture.snapshotSha256,
    rawDiffPixelRatio: exactRawDiff[0].ratio,
    acceptanceDiffPixelRatio: exactRawDiff[0].acceptanceRatio,
    acceptanceMetric: exactRawDiff[0].acceptanceMetric,
    baselineReproducibilityRatio: baselineReproducibility.ratio,
    maxDiffPixelRatio,
  };
  assertReceiptContract(
    parityAttestationReceiptIssues({
      receipt,
      signoff: item.signoff,
      baselineUpdate: item.baselineUpdate,
      item,
      manifestKey,
      manifestEntry,
      snapshotPath: relative(REPO_ROOT, canonicalBaselinePath),
      maxDiffPixelRatio,
      maxBaselineReproducibilityRatio: registry._meta.thresholds.regressionBaseline,
      evidence,
      strictAudit: run.strictAudit,
    }),
    'New parity attestation receipt'
  );

  validateJsonDocument({
    schemaPath: registrySchemaPath,
    value: registry,
    label: 'pixel-perfect-registry.json',
  });
  assertDesignLease({ id, owner: leaseOwner, mode: 'implementation' });
  if (
    !readFileSync(REGISTRY_PATH).equals(registryBefore) ||
    !readFileSync(MANIFEST_PATH).equals(manifestBefore)
  ) {
    throw new Error('Registry or Figma reference changed while attestation was being prepared.');
  }
  runPreflight(id);
  assertTargetSourceFingerprint(
    currentTargetSource.fingerprint,
    currentTargetSourceState(item),
    'Target source contract immediately before parity publication'
  );
  atomicWriteFile(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`Promoted reviewed signoff ${runId} to parity for '${id}'.`);
  console.log(`Durable parity receipt: ${relative(REPO_ROOT, receiptArtifact.path)}`);
});
