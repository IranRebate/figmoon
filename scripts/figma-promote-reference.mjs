#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  DURABLE_EVIDENCE_ROOT,
  MANIFEST_PATH,
  REFERENCE_ARTIFACTS_ROOT,
  REGISTRY_PATH,
  REPO_ROOT,
  atomicWriteFile,
  loadReferenceRun,
  readJson,
  resolveAutomaticApprover,
  stableJson,
  validateReviewer,
} from './lib/figma-reference-run.mjs';
import { getFigmoonConfig } from '../lib/config.mjs';
import {
  assertDesignLease,
  assertExpectedDigest,
  assertFreshAcquisition,
  assertReferenceRunNotReplayed,
  demoteReferenceDependents,
  durablePointer,
  installContentAddressedJson,
  referencePromotionImpact,
  sealReviewedBundle,
  validateJsonDocument,
  withContractPromotionMutex,
} from './lib/figma-promotion.mjs';
import {
  assertReceiptContract,
  referencePromotionReceiptIssues,
} from './lib/figma-receipt-contract.mjs';

const __figmoonConfig = getFigmoonConfig();
const manifestSchemaPath = __figmoonConfig.manifestSchemaPath;
const registrySchemaPath = __figmoonConfig.registrySchemaPath;

function parseArgs(argv) {
  const valueFlags = new Set([
    '--id',
    '--run-id',
    '--expected-run-sha256',
    '--approved-by',
    '--agent-name',
    '--lease-owner',
    '--reason',
  ]);
  const booleanFlags = new Set([
    '--accept-remap',
    '--accept-node-name-change',
    '--accept-source-remap',
    '--accept-bounds-change',
  ]);
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equalsIndex = argument.indexOf('=');
    const flag = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
    if (booleanFlags.has(flag)) {
      if (equalsIndex >= 0 || parsed[flag] === true) {
        throw new Error(`${flag} must be provided at most once and without a value.`);
      }
      parsed[flag] = true;
      continue;
    }
    if (!valueFlags.has(flag))
      throw new Error(`Unsupported figma:promote-reference argument: ${argument}`);
    if (Object.hasOwn(parsed, flag)) throw new Error(`${flag} may be provided only once.`);
    const value = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires exactly one value.`);
    parsed[flag] = value;
  }

  for (const flag of valueFlags) {
    if (flag === '--approved-by' || flag === '--agent-name') continue;
    if (!parsed[flag])
      throw new Error(`figma:promote-reference requires exactly one ${flag} value.`);
  }
  return parsed;
}

function referenceContractChanged(manifest, entry, run) {
  const evidence = run.evidence;
  return (
    entry.acquisition?.reviewSha256 !== run.reviewSha256 ||
    manifest.figmaFile?.key !== evidence.source.file.key ||
    manifest.figmaFile?.name !== evidence.source.file.name ||
    entry.assetSha256 !== evidence.source.export.sha256 ||
    entry.exportBounds?.width !== evidence.source.export.bounds.width ||
    entry.exportBounds?.height !== evidence.source.export.bounds.height ||
    entry.figma?.pageId !== evidence.source.page.id ||
    entry.figma?.pageName !== evidence.source.page.name ||
    entry.figma?.nodeId !== evidence.source.node.id ||
    entry.figma?.nodeName !== evidence.source.node.name ||
    entry.figma?.nodeType !== evidence.source.node.type ||
    entry.acquisition?.nodeSha256 !== evidence.source.node.sha256 ||
    entry.acquisition?.variablesSha256 !== evidence.source.variables.sha256 ||
    stableJson(entry.acquisition?.exportSpec ?? null) !== stableJson(evidence.source.export.spec)
  );
}

function laterDate(left, right) {
  if (!left) return right;
  return left > right ? left : right;
}

const parsed = parseArgs(process.argv.slice(2));
const id = parsed['--id'];
const runId = parsed['--run-id'];
const expectedRunSha256 = assertExpectedDigest(parsed['--expected-run-sha256']);
// A human reviewer, when supplied, takes precedence. Otherwise the executing
// agent records its own identity instead of inheriting a vendor-specific name.
const approvedBy = parsed['--approved-by']
  ? validateReviewer(parsed['--approved-by'])
  : resolveAutomaticApprover({ explicitName: parsed['--agent-name'] });
const leaseOwner = parsed['--lease-owner'];
const reason = parsed['--reason'].trim();
const acceptRemap = Boolean(parsed['--accept-remap']);
const acceptNodeNameChange = Boolean(parsed['--accept-node-name-change']);
const acceptSourceRemap = Boolean(parsed['--accept-source-remap']);
const acceptBoundsChange = Boolean(parsed['--accept-bounds-change']);

if (reason.length < 12) throw new Error('--reason must record the reviewed reference decision.');
assertDesignLease({ id, owner: leaseOwner, mode: 'reference' });

await withContractPromotionMutex(async () => {
  assertDesignLease({ id, owner: leaseOwner, mode: 'reference' });
  const manifestBefore = readFileSync(MANIFEST_PATH);
  const registryBefore = readFileSync(REGISTRY_PATH);
  const manifest = JSON.parse(manifestBefore.toString('utf8'));
  const registry = JSON.parse(registryBefore.toString('utf8'));
  let run = await loadReferenceRun({
    runId,
    id,
    registry,
    manifest,
    allowRemapCandidate: acceptRemap,
    allowNodeNameChangeCandidate: acceptNodeNameChange,
    allowSourceRemapCandidate: acceptSourceRemap,
    allowBoundsChange: acceptBoundsChange,
  });
  if (run.reviewSha256 !== expectedRunSha256) {
    throw new Error(
      `Reviewed acquisition digest mismatch: expected ${expectedRunSha256}, current run is ${run.reviewSha256}.`
    );
  }

  const now = new Date();
  const freshnessDays =
    run.manifestEntry.staleAfterDays ?? manifest.figmaFile?.freshnessPolicy?.maxAgeDays ?? 14;
  assertFreshAcquisition({ acquiredAt: run.evidence.acquiredAt, maxAgeDays: freshnessDays, now });

  run = await loadReferenceRun({
    runId,
    id,
    registry,
    manifest,
    allowRemapCandidate: acceptRemap,
    allowNodeNameChangeCandidate: acceptNodeNameChange,
    allowSourceRemapCandidate: acceptSourceRemap,
    allowBoundsChange: acceptBoundsChange,
  });
  if (run.reviewSha256 !== expectedRunSha256) {
    throw new Error('Reviewed acquisition bundle changed while promotion was being prepared.');
  }

  const entry = manifest.items[run.manifestKey];
  assertReferenceRunNotReplayed(entry, { runId, reviewSha256: run.reviewSha256 });
  const contractChanged = referenceContractChanged(manifest, entry, run);
  const promotionImpact = referencePromotionImpact({
    manifest,
    manifestKey: run.manifestKey,
    sourceFile: run.evidence.source.file,
  });
  const invalidatedRegistryIds = contractChanged
    ? demoteReferenceDependents(registry, promotionImpact.registryIds)
    : [];
  const acquiredDate = run.evidence.acquiredAt.slice(0, 10);
  const promotedAt = now.toISOString();

  const sealed = sealReviewedBundle({
    expectedDigest: expectedRunSha256,
    entries: [
      {
        key: 'reference',
        name: 'reference.png',
        sourcePath: run.referencePath,
        root: REFERENCE_ARTIFACTS_ROOT,
        extension: 'png',
      },
      {
        key: 'acquisitionEvidence',
        name: 'evidence.json',
        sourcePath: run.evidencePath,
        root: DURABLE_EVIDENCE_ROOT,
        extension: 'json',
      },
      {
        key: 'node',
        name: 'node.json',
        sourcePath: run.nodePath,
        root: DURABLE_EVIDENCE_ROOT,
        extension: 'json',
      },
      {
        key: 'variables',
        name: 'variables.json',
        sourcePath: run.variablesPath,
        root: DURABLE_EVIDENCE_ROOT,
        extension: 'json',
      },
      ...(run.evidence.comparison?.diffPath
        ? [
            {
              key: 'comparisonDiff',
              name: 'candidate-vs-canonical.png',
              sourcePath: join(run.runRoot, 'candidate-vs-canonical.png'),
              root: DURABLE_EVIDENCE_ROOT,
              extension: 'png',
            },
          ]
        : []),
    ],
  });
  const referenceArtifact = sealed.reference;
  const acquisitionEvidenceArtifact = sealed.acquisitionEvidence;
  const nodeArtifact = sealed.node;
  const variablesArtifact = sealed.variables;
  const comparisonDiffArtifact = sealed.comparisonDiff ?? null;

  const receipt = {
    schemaVersion: 1,
    kind: 'figma-reference-promotion',
    target: { manifestKey: run.manifestKey, registryIds: [...entry.registryIds] },
    runId,
    reviewSha256: run.reviewSha256,
    acquiredAt: run.evidence.acquiredAt,
    promotedAt,
    approval: { approvedBy, leaseOwner, reason },
    source: run.evidence.source,
    canonicalBefore: run.evidence.canonicalBefore,
    artifacts: {
      acquisitionEvidence: durablePointer(acquisitionEvidenceArtifact),
      reference: durablePointer(referenceArtifact),
      node: durablePointer(nodeArtifact),
      variables: durablePointer(variablesArtifact),
      ...(comparisonDiffArtifact ? { comparisonDiff: durablePointer(comparisonDiffArtifact) } : {}),
    },
    invalidation: {
      referenceContractChanged: contractChanged,
      sourceContractChanged: promotionImpact.sourceContractChanged,
      registryIds: invalidatedRegistryIds,
    },
  };
  const receiptArtifact = installContentAddressedJson({
    root: DURABLE_EVIDENCE_ROOT,
    value: receipt,
  });

  entry.artifactPath = relative(REPO_ROOT, referenceArtifact.path);
  entry.assetSha256 = referenceArtifact.sha256;
  entry.exportBounds = { ...run.evidence.source.export.bounds };
  entry.exportedAt = acquiredDate;
  entry.lastCheckedAt = acquiredDate;
  entry.figma = {
    ...entry.figma,
    pageId: run.evidence.source.page.id,
    pageName: run.evidence.source.page.name,
    nodeId: run.evidence.source.node.id,
    nodeName: run.evidence.source.node.name,
    nodeType: run.evidence.source.node.type,
    liveBounds: {
      width: run.evidence.source.node.bounds.width,
      height: run.evidence.source.node.bounds.height,
    },
  };
  entry.lifecycle = {
    status: 'canonical-product',
    owner: entry.lifecycle?.owner ?? 'product-design',
    reason,
    reviewBy: entry.lifecycle?.reviewBy ?? null,
  };
  entry.acquisition = {
    schemaVersion: 1,
    runId,
    adapter: run.evidence.acquisition.adapter,
    adapterVersion: run.evidence.acquisition.adapterVersion,
    protocol: run.evidence.acquisition.protocol,
    plugin: run.evidence.acquisition.plugin,
    operations: run.evidence.acquisition.operations,
    fileKey: run.evidence.source.file.key,
    fileName: run.evidence.source.file.name,
    pageId: run.evidence.source.page.id,
    pageName: run.evidence.source.page.name,
    nodeId: run.evidence.source.node.id,
    nodeSha256: run.evidence.source.node.sha256,
    variablesSha256: run.evidence.source.variables.sha256,
    exportSha256: referenceArtifact.sha256,
    exportSpec: run.evidence.source.export.spec,
    acquiredAt: run.evidence.acquiredAt,
    promotedAt,
    previousAssetSha256: run.evidence.canonicalBefore.sha256,
    reviewSha256: run.reviewSha256,
    receipt: durablePointer(receiptArtifact),
    evidence: durablePointer(acquisitionEvidenceArtifact),
    node: durablePointer(nodeArtifact),
    variables: durablePointer(variablesArtifact),
    ...(comparisonDiffArtifact ? { comparisonDiff: durablePointer(comparisonDiffArtifact) } : {}),
    approvedBy,
    leaseOwner,
    reason,
  };
  manifest.figmaFile = {
    ...manifest.figmaFile,
    key: run.evidence.source.file.key,
    name: run.evidence.source.file.name,
    currentPageId: run.evidence.source.page.id,
    currentPageName: run.evidence.source.page.name,
    lastLiveInspectionAt: laterDate(manifest.figmaFile?.lastLiveInspectionAt, acquiredDate),
  };

  assertReceiptContract(
    referencePromotionReceiptIssues({
      receipt,
      manifest,
      manifestKey: run.manifestKey,
      manifestEntry: entry,
      acquisitionEvidence: run.evidence,
    }),
    'New reference promotion receipt'
  );

  validateJsonDocument({
    schemaPath: registrySchemaPath,
    value: registry,
    label: 'pixel-perfect-registry.json',
  });
  validateJsonDocument({
    schemaPath: manifestSchemaPath,
    value: manifest,
    label: 'reference-manifest.json',
  });
  assertDesignLease({ id, owner: leaseOwner, mode: 'reference' });
  const currentManifest = readFileSync(MANIFEST_PATH);
  const currentRegistry = readFileSync(REGISTRY_PATH);
  if (!currentManifest.equals(manifestBefore) || !currentRegistry.equals(registryBefore)) {
    throw new Error(
      'Reference contract changed while promotion was being prepared; reacquire/review it.'
    );
  }

  // Conservative ordering: a crash may leave claims demoted, never a new
  // reference paired with stale parity. The next promotion can safely retry.
  if (contractChanged) atomicWriteFile(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
  atomicWriteFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Promoted reviewed Figma reference ${run.manifestKey}: ${entry.artifactPath}`);
  console.log(`Durable promotion receipt: ${relative(REPO_ROOT, receiptArtifact.path)}`);
  if (invalidatedRegistryIds.length) {
    console.log(
      `Invalidated dependent parity/baseline claims: ${invalidatedRegistryIds.join(', ')}`
    );
  }
});
