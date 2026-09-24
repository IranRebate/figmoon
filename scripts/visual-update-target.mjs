#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DURABLE_EVIDENCE_ROOT,
  MANIFEST_PATH,
  REGISTRY_PATH,
  atomicWriteFile,
  loadVisualEvidenceRun,
  pathIsWithin,
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
  referencePromotionReceiptIssues,
} from './lib/figma-receipt-contract.mjs';
import {
  assertTargetSourceFingerprint,
  assertVisualEvidenceTargetSource,
  baselineReceiptInvalidatesSignoff,
  targetSourceState,
} from './lib/figma-target-closure.mjs';
import { resolveCanonicalSnapshotPath } from './lib/figma-snapshot-contract.mjs';
import { getFigmoonConfig } from '../lib/config.mjs';

const __figmoonConfig = getFigmoonConfig();
const REPO_ROOT = __figmoonConfig.consumerRoot;
const clientRoot = __figmoonConfig.clientRoot;
const snapshotRoot = __figmoonConfig.snapshotRoot;
const registrySchemaPath = __figmoonConfig.registrySchemaPath;
const dependencyGraphPath = __figmoonConfig.dependencyGraphPath;
const screenRegistryPath = __figmoonConfig.screenRegistryPath;

function parseArgs(argv) {
  const allowed = new Set([
    '--id',
    '--measurement-run',
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
    if (!allowed.has(flag))
      throw new Error(`Unsupported visual:update-target argument: ${argument}`);
    if (Object.hasOwn(parsed, flag)) throw new Error(`${flag} may be provided only once.`);
    const value = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires exactly one value.`);
    parsed[flag] = value;
  }
  for (const flag of allowed) {
    if (!parsed[flag]) throw new Error(`visual:update-target requires exactly one ${flag} value.`);
  }
  return parsed;
}

function runPreflight(id) {
  const result = spawnSync(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), 'check-figma-refs.mjs'), '--id', id, '--require-baseline-update'],
    { cwd: REPO_ROOT, env: process.env, stdio: 'inherit' }
  );
  if (result.status !== 0) throw new Error(`Baseline preflight failed for '${id}'.`);
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
const measurementRunId = validateRunId(parsed['--measurement-run']);
const expectedRunSha256 = assertExpectedDigest(parsed['--expected-run-sha256']);
const approvedBy = validateReviewer(parsed['--approved-by']);
const leaseOwner = parsed['--lease-owner'];
const reason = parsed['--reason'].trim();
if (reason.length < 12) throw new Error('--reason must record the exact reviewed visual decision.');

assertDesignLease({ id, owner: leaseOwner, mode: 'implementation' });
runPreflight(id);

await withContractPromotionMutex(async () => {
  assertDesignLease({ id, owner: leaseOwner, mode: 'implementation' });
  const registryBefore = readFileSync(REGISTRY_PATH);
  const manifestBefore = readFileSync(MANIFEST_PATH);
  const registry = JSON.parse(registryBefore.toString('utf8'));
  const manifest = JSON.parse(manifestBefore.toString('utf8'));
  const item = registry.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown registry id: ${id}`);
  if (!item.visualTest?.file || !item.visualTest?.name || !item.snapshot) {
    throw new Error(`Baseline update requires a complete visual contract for ${id}.`);
  }
  if (item.referenceStatus !== 'mapped' || item.parityStatus === 'not-comparable') {
    throw new Error(`Baseline update requires a comparable mapped Figma target: ${id}.`);
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

  let run = loadVisualEvidenceRun({ runId: measurementRunId, id, mode: 'measure' });
  if (run.reviewSha256 !== expectedRunSha256) {
    throw new Error(
      `Reviewed measurement digest mismatch: expected ${expectedRunSha256}, current run is ${run.reviewSha256}.`
    );
  }
  let measurement = run.evidence;
  if (measurement.referenceSource?.kind !== 'canonical-manifest') {
    throw new Error('Baseline promotion accepts only a canonical-manifest measurement run.');
  }
  if (measurement.referenceSource.manifestKey !== manifestKey) {
    throw new Error('Figma manifest ownership changed after measurement.');
  }

  const currentTargetSource = currentTargetSourceState(item);
  assertVisualEvidenceTargetSource(measurement, currentTargetSource, 'Reviewed measurement run');
  const currentRenderer = rendererFingerprint();
  if (stableJson(currentRenderer) !== stableJson(measurement.rendererState)) {
    throw new Error(
      'Renderer/font fingerprint changed after measurement; measure this target again.'
    );
  }
  const canonicalReferencePath = resolveManifestArtifact(manifestEntry);
  const referenceSha256 = sha256(readFileSync(canonicalReferencePath));
  if (
    referenceSha256 !== manifestEntry.assetSha256 ||
    referenceSha256 !== measurement.before?.referenceSha256 ||
    referenceSha256 !== measurement.capture?.referenceSha256
  ) {
    throw new Error('Canonical Figma reference changed after measurement.');
  }

  const targetBaselinePath = resolveCanonicalSnapshotPath({
    item,
    snapshotRoot,
    mustExist: false,
  });
  if (!pathIsWithin(targetBaselinePath, snapshotRoot)) {
    throw new Error(`Registered snapshot escapes the canonical baseline root: ${item.snapshot}`);
  }
  if (existsSync(targetBaselinePath)) {
    if (lstatSync(targetBaselinePath).isSymbolicLink() || !lstatSync(targetBaselinePath).isFile()) {
      throw new Error(`Registered baseline must be a regular file: ${item.snapshot}`);
    }
    if (!pathIsWithin(realpathSync(targetBaselinePath), realpathSync(snapshotRoot))) {
      throw new Error(
        `Registered baseline resolves outside the canonical snapshot root: ${item.snapshot}`
      );
    }
  }
  const expectedRelativeCapture = relative(snapshotRoot, targetBaselinePath);
  const actualRelativeCapture = relative(join(run.runRoot, 'snapshots'), run.capturedSnapshotPath);
  if (expectedRelativeCapture !== actualRelativeCapture) {
    throw new Error('Measurement capture path does not match the registered target snapshot.');
  }

  const beforeBytes = existsSync(targetBaselinePath) ? readFileSync(targetBaselinePath) : null;
  const beforeSha256 = beforeBytes ? sha256(beforeBytes) : null;
  if (beforeSha256 !== (measurement.before?.snapshotSha256 ?? null)) {
    throw new Error('Accepted target baseline changed after measurement.');
  }
  const afterBytes = readFileSync(run.capturedSnapshotPath);
  const afterSha256 = sha256(afterBytes);
  const baselineChanged = beforeSha256 !== afterSha256;

  // Revalidate all mutable inputs immediately before sealing durable artifacts.
  assertDesignLease({ id, owner: leaseOwner, mode: 'implementation' });
  if (
    !readFileSync(REGISTRY_PATH).equals(registryBefore) ||
    !readFileSync(MANIFEST_PATH).equals(manifestBefore)
  ) {
    throw new Error(
      'Registry or Figma reference changed while baseline promotion was being prepared.'
    );
  }
  assertTargetSourceFingerprint(
    currentTargetSource.fingerprint,
    currentTargetSourceState(item),
    'Target source contract during baseline promotion'
  );
  if (stableJson(rendererFingerprint()) !== stableJson(currentRenderer)) {
    throw new Error('Renderer/font state changed while baseline promotion was being prepared.');
  }
  runPreflight(id);

  run = loadVisualEvidenceRun({ runId: measurementRunId, id, mode: 'measure' });
  if (run.reviewSha256 !== expectedRunSha256) {
    throw new Error('Reviewed measurement bundle changed while promotion was being prepared.');
  }
  measurement = run.evidence;
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
  const rendererSha256 = sha256(stableJson(currentRenderer));
  const receipt = {
    schemaVersion: 1,
    kind: 'figma-baseline-promotion',
    target: { id, manifestKey, snapshotPath: relative(REPO_ROOT, targetBaselinePath) },
    runId: measurementRunId,
    reviewSha256: run.reviewSha256,
    approvedAt,
    approval: { approvedBy, leaseOwner, reason },
    contract: {
      targetSourceFingerprint: currentTargetSource.fingerprint,
      rendererFingerprint: rendererSha256,
      referenceSha256,
      referenceAcquisitionReceiptSha256: manifestEntry.acquisition.receipt.sha256,
      beforeSha256,
      afterSha256,
      captureSha256: measurement.capture.snapshotSha256,
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
  const baselineReceiptRotated = item.baselineUpdate?.receipt?.sha256 !== receiptArtifact.sha256;
  const parityClaimed =
    Boolean(item.signoff) ||
    ['figma_parity', 'regression_locked'].includes(item.status) ||
    ['parity', 'locked'].includes(item.parityStatus);
  const parityInvalidated =
    baselineChanged ||
    (parityClaimed &&
      (baselineReceiptRotated ||
        baselineReceiptInvalidatesSignoff(item.signoff, receiptArtifact.sha256)));

  if (parityInvalidated) {
    if (['figma_parity', 'regression_locked'].includes(item.status)) item.status = 'mapped';
    if (['parity', 'locked'].includes(item.parityStatus)) item.parityStatus = 'drifting';
    delete item.signoff;
    item.lastVerifiedAt = null;
  }
  item.baselineUpdate = {
    schemaVersion: 1,
    measurementRunId,
    evidenceSha256: run.reviewSha256,
    receipt: durablePointer(receiptArtifact),
    approvedBy,
    leaseOwner,
    approvedAt,
    reason,
    targetSourceFingerprint: currentTargetSource.fingerprint,
    rendererFingerprint: rendererSha256,
    referenceSha256,
    referenceAcquisitionReceiptSha256: manifestEntry.acquisition.receipt.sha256,
    captureSha256: measurement.capture.snapshotSha256,
    measurementCommand: `npm run figma:measure${__figmoonConfig.npmWorkspace ? ` --workspace=${__figmoonConfig.npmWorkspace}` : ''} -- --id ${id} --run-id ${measurementRunId}`,
    beforeSha256,
    afterSha256,
  };
  assertReceiptContract(
    baselinePromotionReceiptIssues({
      receipt,
      update: item.baselineUpdate,
      item,
      manifestKey,
      manifestEntry,
      snapshotPath: relative(REPO_ROOT, targetBaselinePath),
      evidence: measurement,
      strictAudit: run.strictAudit,
    }),
    'New baseline promotion receipt'
  );
  validateJsonDocument({
    schemaPath: registrySchemaPath,
    value: registry,
    label: 'pixel-perfect-registry.json',
  });

  // Seal the optimistic contract again immediately before the first tracked
  // publication. All operations after this check are synchronous.
  assertDesignLease({ id, owner: leaseOwner, mode: 'implementation' });
  if (
    !readFileSync(REGISTRY_PATH).equals(registryBefore) ||
    !readFileSync(MANIFEST_PATH).equals(manifestBefore)
  ) {
    throw new Error('Registry or Figma reference changed immediately before baseline publication.');
  }
  if (stableJson(rendererFingerprint()) !== stableJson(currentRenderer)) {
    throw new Error('Renderer/font state changed immediately before baseline publication.');
  }
  assertTargetSourceFingerprint(
    currentTargetSource.fingerprint,
    currentTargetSourceState(item),
    'Target source contract immediately before baseline publication'
  );

  if (parityInvalidated) {
    const demotedRegistry = JSON.parse(registryBefore.toString('utf8'));
    const demotedItem = demotedRegistry.items.find((candidate) => candidate.id === id);
    if (['figma_parity', 'regression_locked'].includes(demotedItem.status)) {
      demotedItem.status = 'mapped';
    }
    if (['parity', 'locked'].includes(demotedItem.parityStatus)) {
      demotedItem.parityStatus = 'drifting';
    }
    delete demotedItem.signoff;
    delete demotedItem.baselineUpdate;
    demotedItem.lastVerifiedAt = null;
    validateJsonDocument({
      schemaPath: registrySchemaPath,
      value: demotedRegistry,
      label: 'demoted pixel-perfect-registry.json',
    });

    // Crash-safe conservative ordering: no old parity claim can coexist with
    // new baseline bytes or a rotated review receipt between these writes.
    atomicWriteFile(REGISTRY_PATH, `${JSON.stringify(demotedRegistry, null, 2)}\n`);
    if (baselineChanged) atomicWriteFile(targetBaselinePath, afterBytes);
  }
  atomicWriteFile(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);

  console.log(
    `Promoted reviewed measurement ${measurementRunId} to exactly one baseline: ${relative(REPO_ROOT, targetBaselinePath)}`
  );
  console.log(`Durable baseline receipt: ${relative(REPO_ROOT, receiptArtifact.path)}`);
});
