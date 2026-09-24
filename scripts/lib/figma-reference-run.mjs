import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { release as osRelease } from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { assertFigmaAcquisitionPluginIntegrity } from './figma-plugin-integrity.mjs';
import {
  assertRendererEvidenceSanitized,
  FIGMA_RENDERER_CAPTURE_CONTRACT,
  playwrightRendererIdentity,
  validateRendererRuntimeAttestation,
} from './figma-renderer-contract.mjs';
import { assertFocusedStrictAudit } from './figma-strict-evidence.mjs';

import { getFigmoonConfig } from '../../lib/config.mjs';

const __figmoonConfig = getFigmoonConfig();
export const CLIENT_ROOT = __figmoonConfig.clientRoot;
export const REPO_ROOT = __figmoonConfig.consumerRoot;
export const FIGMA_ROOT = __figmoonConfig.figmaRoot;
export const REFERENCE_RUNS_ROOT = __figmoonConfig.referenceRunsRoot;
export const VISUAL_EVIDENCE_RUNS_ROOT = __figmoonConfig.visualEvidenceRunsRoot;
export const REFERENCE_ARTIFACTS_ROOT = __figmoonConfig.referenceArtifactsRoot;
export const DURABLE_EVIDENCE_ROOT = __figmoonConfig.durableEvidenceRoot;
export const REGISTRY_PATH = __figmoonConfig.registryPath;
export const MANIFEST_PATH = __figmoonConfig.manifestPath;

export const READ_ONLY_FIGMA_OPERATIONS = Object.freeze(['acquire_reference']);

const RUN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, normalize(entry[key])])
      );
    }
    return entry;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function validateRunId(value) {
  if (!RUN_ID_RE.test(value ?? '')) {
    throw new Error('Run id may contain letters, numbers, ., _, and - (max 120 chars).');
  }
  return value;
}

export function pathIsWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function findRegistryItem(registry, id) {
  const matches = (registry.items ?? []).filter((item) => item.id === id);
  if (matches.length !== 1) {
    throw new Error(`Registry id '${id}' must resolve exactly once; found ${matches.length}.`);
  }
  return matches[0];
}

export function findManifestEntry(manifest, id) {
  const matches = Object.entries(manifest.items ?? {}).filter(([, entry]) =>
    entry.registryIds?.includes(id)
  );
  if (matches.length !== 1) {
    throw new Error(
      `Registry id '${id}' must have exactly one manifest owner; found ${matches.length}.`
    );
  }
  const [[key, entry]] = matches;
  return { key, entry };
}

function assertRegularFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  if (lstatSync(path).isSymbolicLink())
    throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (!lstatSync(path).isFile()) throw new Error(`${label} must be a regular file: ${path}`);
}

export function digestNamedBytes(entries) {
  const hash = createHash('sha256');
  const names = new Set();
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry?.name || names.has(entry.name)) {
      throw new Error('Evidence digest entries require unique stable names.');
    }
    names.add(entry.name);
    hash.update(entry.name);
    hash.update('\0');
    hash.update(Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function digestNamedFiles(entries) {
  return digestNamedBytes(
    entries.map((entry) => {
      assertRegularFile(entry.path, `Evidence artifact '${entry.name}'`);
      return { name: entry.name, bytes: readFileSync(entry.path) };
    })
  );
}

export function resolveManifestArtifact(entry, { repoRoot = REPO_ROOT, mustExist = true } = {}) {
  const logicalPath = entry.artifactPath ?? entry.referencePath;
  if (!logicalPath) throw new Error('Manifest reference is missing artifactPath/referencePath.');
  const figmaRoot =
    repoRoot === REPO_ROOT
      ? FIGMA_ROOT
      : join(repoRoot, ...relative(REPO_ROOT, FIGMA_ROOT).split('/').filter(Boolean));
  const resolved = resolve(repoRoot, logicalPath);
  if (!pathIsWithin(resolved, figmaRoot) || resolved === figmaRoot) {
    throw new Error(`Reference artifact escapes the Figmoon reference root: ${logicalPath}`);
  }
  if (mustExist) {
    assertRegularFile(resolved, 'Reference artifact');
    const real = realpathSync(resolved);
    const realFigmaRoot = realpathSync(figmaRoot);
    if (!pathIsWithin(real, realFigmaRoot) || real === realFigmaRoot) {
      throw new Error(`Reference artifact resolves outside the Figmoon reference root: ${logicalPath}`);
    }
  }
  return resolved;
}

export function referenceRunRoot(runId, { clientRoot = CLIENT_ROOT } = {}) {
  const validated = validateRunId(runId);
  const root = resolve(clientRoot, 'e2e', 'figma-reference-runs', validated);
  const runsRoot = resolve(clientRoot, 'e2e', 'figma-reference-runs');
  if (!pathIsWithin(root, runsRoot) || root === runsRoot)
    throw new Error('Reference run path escaped its root.');
  return root;
}

function resolveRunArtifact(runRoot, repoRoot, declaredPath, expectedName) {
  if (!declaredPath) throw new Error(`Reference run is missing ${expectedName} path evidence.`);
  const resolved = resolve(repoRoot, declaredPath);
  if (!pathIsWithin(resolved, runRoot) || resolved === runRoot) {
    throw new Error(`Reference run artifact escapes its immutable run: ${declaredPath}`);
  }
  if (expectedName && resolved !== join(runRoot, expectedName)) {
    throw new Error(`Reference run artifact must be ${expectedName}: ${declaredPath}`);
  }
  assertRegularFile(resolved, 'Reference run artifact');
  return resolved;
}

function assertHash(path, expected, label) {
  if (!SHA256_RE.test(expected ?? '')) throw new Error(`${label} is missing a valid SHA-256.`);
  const actual = sha256(readFileSync(path));
  if (actual !== expected) throw new Error(`${label} hash changed after acquisition.`);
  return actual;
}

export async function loadReferenceRun({
  runId,
  id,
  repoRoot = REPO_ROOT,
  clientRoot = CLIENT_ROOT,
  registry = readJson(REGISTRY_PATH),
  manifest = readJson(MANIFEST_PATH),
  allowRemapCandidate = false,
  allowNodeNameChangeCandidate = false,
  allowSourceRemapCandidate = false,
  allowBoundsChange = false,
  requireCurrentCanonical = true,
} = {}) {
  const runRoot = referenceRunRoot(runId, { clientRoot });
  assertRegularFile(join(runRoot, 'evidence.json'), 'Reference acquisition evidence');
  const evidence = readJson(join(runRoot, 'evidence.json'));
  if (evidence.schemaVersion !== 1 || evidence.kind !== 'figma-reference-acquisition') {
    throw new Error('Reference run has an unsupported evidence contract.');
  }
  if (evidence.runId !== runId) throw new Error('Reference run id does not match its directory.');
  if (evidence.result !== 'staged') {
    throw new Error(
      `Reference run is not promotable/measurable: ${evidence.result ?? 'missing result'}.`
    );
  }
  const acquiredAt = new Date(evidence.acquiredAt ?? '');
  if (Number.isNaN(acquiredAt.getTime()) || acquiredAt.toISOString() !== evidence.acquiredAt) {
    throw new Error('Reference run is missing an exact ISO acquisition timestamp.');
  }
  if (evidence.target?.registryId !== id) {
    throw new Error(
      `Reference run belongs to '${evidence.target?.registryId ?? 'unknown'}', not '${id}'.`
    );
  }

  const item = findRegistryItem(registry, id);
  const { key: manifestKey, entry: manifestEntry } = findManifestEntry(manifest, id);
  if (evidence.target.manifestKey !== manifestKey)
    throw new Error('Reference run manifest owner changed.');
  if (evidence.target.logicalReferencePath !== manifestEntry.referencePath) {
    throw new Error('Reference run logical reference path changed.');
  }

  const operations = evidence.acquisition?.operations;
  if (
    !Array.isArray(operations) ||
    operations.length !== READ_ONLY_FIGMA_OPERATIONS.length ||
    new Set(operations).size !== READ_ONLY_FIGMA_OPERATIONS.length ||
    operations.some((operation) => !READ_ONLY_FIGMA_OPERATIONS.includes(operation))
  ) {
    throw new Error('Reference run did not use the exact read-only acquisition operation set.');
  }
  if (evidence.acquisition?.adapter !== 'figmoon-reference-broker') {
    throw new Error('Reference run used an untrusted acquisition adapter.');
  }
  const trustedPlugin = assertFigmaAcquisitionPluginIntegrity().plugin;
  if (
    evidence.acquisition?.protocol !== 'figmoon-reference-acquisition/v1' ||
    evidence.acquisition?.plugin?.id !== trustedPlugin.id ||
    evidence.acquisition?.plugin?.version !== trustedPlugin.version ||
    evidence.acquisition?.plugin?.build !== trustedPlugin.build
  ) {
    throw new Error('Reference run used an untrusted read-only plugin protocol/build.');
  }

  const referencePath = resolveRunArtifact(
    runRoot,
    repoRoot,
    evidence.source?.export?.path,
    'reference.png'
  );
  const nodePath = resolveRunArtifact(runRoot, repoRoot, evidence.source?.node?.path, 'node.json');
  const variablesPath = resolveRunArtifact(
    runRoot,
    repoRoot,
    evidence.source?.variables?.path,
    'variables.json'
  );
  assertHash(referencePath, evidence.source.export.sha256, 'Reference export');
  assertHash(nodePath, evidence.source.node.sha256, 'Figma node evidence');
  assertHash(variablesPath, evidence.source.variables.sha256, 'Figma variable evidence');
  const nodeEvidence = readJson(nodePath);
  if (
    nodeEvidence.id !== evidence.source.node.id ||
    nodeEvidence.name !== evidence.source.node.name ||
    nodeEvidence.type !== evidence.source.node.type ||
    nodeEvidence.bounds?.x !== evidence.source.node.bounds?.x ||
    nodeEvidence.bounds?.y !== evidence.source.node.bounds?.y ||
    nodeEvidence.bounds?.width !== evidence.source.node.bounds?.width ||
    nodeEvidence.bounds?.height !== evidence.source.node.bounds?.height
  ) {
    throw new Error('Figma node evidence contradicts its acquisition receipt.');
  }
  if (
    evidence.source.stability?.beforeSha256 !== evidence.source.stability?.afterSha256 ||
    evidence.source.stability?.ancestorPage?.id !== evidence.source.page.id ||
    evidence.source.stability?.ancestorPage?.name !== evidence.source.page.name
  ) {
    throw new Error('Figma acquisition did not prove a stable node/page snapshot.');
  }
  const changeTracking = evidence.source.stability?.changeTracking;
  if (changeTracking?.supported !== true) {
    throw new Error(
      'Figma document change tracking was unavailable; this run cannot become canonical.'
    );
  }
  const trackedRevisions = [
    changeTracking.beforeReadStart,
    changeTracking.beforeReadEnd,
    changeTracking.afterReadStart,
    changeTracking.afterReadEnd,
  ];
  if (!trackedRevisions.every((revision) => Number.isSafeInteger(revision) && revision >= 0)) {
    throw new Error('Figma document change tracking returned invalid revision evidence.');
  }
  if (new Set(trackedRevisions).size !== 1) {
    throw new Error('Figma document revision changed during acquisition.');
  }
  if (
    evidence.source.export.spec?.format !== 'PNG' ||
    evidence.source.export.spec?.scale !== 1 ||
    typeof evidence.source.export.spec?.clip !== 'boolean'
  ) {
    throw new Error('Reference export did not use the canonical raw PNG export contract.');
  }

  const metadata = await sharp(referencePath).metadata();
  const recordedBounds = evidence.source.export.bounds;
  if (!metadata.width || !metadata.height || metadata.format !== 'png') {
    throw new Error('Reference export must be a readable PNG with dimensions.');
  }
  if (metadata.width !== recordedBounds?.width || metadata.height !== recordedBounds?.height) {
    throw new Error('Reference export dimensions changed after acquisition.');
  }

  if (
    typeof evidence.source?.file?.key !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(evidence.source.file.key) ||
    typeof evidence.source.file.name !== 'string' ||
    !evidence.source.file.name.trim() ||
    evidence.source.file.name.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(evidence.source.file.name)
  ) {
    throw new Error('Reference run has an invalid Figma source file identity.');
  }
  const fileBindingCandidate = !manifest.figmaFile?.key;
  const sourceRemapCandidate =
    (Boolean(manifest.figmaFile?.key) && evidence.source.file.key !== manifest.figmaFile.key) ||
    evidence.source.file.name !== manifest.figmaFile?.name;
  if (sourceRemapCandidate && !allowSourceRemapCandidate) {
    throw new Error(
      'Reference run came from a different Figma source; explicit source remap review is required.'
    );
  }
  if (
    evidence.source.page.id !== manifestEntry.figma?.pageId ||
    evidence.source.page.name !== manifestEntry.figma?.pageName
  ) {
    throw new Error('Reference run came from a different Figma page.');
  }

  const remapCandidate = evidence.source.node.id !== manifestEntry.figma?.nodeId;
  const nodeNameChangeCandidate =
    !remapCandidate && evidence.source.node.name !== manifestEntry.figma?.nodeName;
  if (remapCandidate && !allowRemapCandidate) {
    throw new Error(
      'Reference run targets a different Figma node; explicit remap review is required.'
    );
  }
  if (!remapCandidate) {
    if (evidence.source.node.type !== manifestEntry.figma?.nodeType)
      throw new Error('Mapped Figma node type changed. Acquire it as an explicit remap candidate.');
    if (nodeNameChangeCandidate && !allowNodeNameChangeCandidate)
      throw new Error(
        'Mapped Figma node name changed; explicit node-name-change review is required.'
      );
  }

  const expectedBounds = manifestEntry.exportBounds;
  const boundsChanged =
    metadata.width !== expectedBounds?.width || metadata.height !== expectedBounds?.height;
  if (boundsChanged && !allowBoundsChange) {
    throw new Error(
      `Reference export bounds changed from ${expectedBounds?.width}x${expectedBounds?.height} to ${metadata.width}x${metadata.height}.`
    );
  }

  const canonicalPath = resolveManifestArtifact(manifestEntry, { repoRoot });
  const canonicalSha256 = sha256(readFileSync(canonicalPath));
  if (
    requireCurrentCanonical &&
    (canonicalSha256 !== evidence.canonicalBefore?.sha256 ||
      manifestEntry.assetSha256 !== evidence.canonicalBefore?.manifestSha256)
  ) {
    throw new Error(
      'Canonical reference changed after this acquisition run; reacquire before continuing.'
    );
  }

  const reviewSha256 = digestNamedFiles([
    { name: 'evidence.json', path: join(runRoot, 'evidence.json') },
    { name: 'node.json', path: nodePath },
    { name: 'reference.png', path: referencePath },
    { name: 'variables.json', path: variablesPath },
    ...(evidence.comparison?.diffPath
      ? [
          {
            name: 'candidate-vs-canonical.png',
            path: resolveRunArtifact(
              runRoot,
              repoRoot,
              evidence.comparison.diffPath,
              'candidate-vs-canonical.png'
            ),
          },
        ]
      : []),
  ]);

  return {
    runRoot,
    evidencePath: join(runRoot, 'evidence.json'),
    evidence,
    referencePath,
    nodePath,
    variablesPath,
    item,
    manifestKey,
    manifestEntry,
    canonicalPath,
    canonicalSha256,
    metadata,
    fileBindingCandidate,
    sourceRemapCandidate,
    remapCandidate,
    nodeNameChangeCandidate,
    boundsChanged,
    reviewSha256,
  };
}

export function visualEvidenceRunRoot(runId, { clientRoot = CLIENT_ROOT } = {}) {
  const validated = validateRunId(runId);
  const runsRoot = resolve(clientRoot, 'e2e', 'figma-audit-results', 'runs');
  const root = resolve(runsRoot, validated);
  if (!pathIsWithin(root, runsRoot) || root === runsRoot) {
    throw new Error('Visual evidence run path escaped its root.');
  }
  return root;
}

export function loadVisualEvidenceRun({
  runId,
  id,
  mode,
  repoRoot = REPO_ROOT,
  clientRoot = CLIENT_ROOT,
} = {}) {
  const runRoot = visualEvidenceRunRoot(runId, { clientRoot });
  if (
    !existsSync(runRoot) ||
    lstatSync(runRoot).isSymbolicLink() ||
    !lstatSync(runRoot).isDirectory()
  ) {
    throw new Error(`Visual evidence run is not a real directory: ${runId}`);
  }
  const realRunRoot = realpathSync(runRoot);
  const realRunsRoot = realpathSync(resolve(clientRoot, 'e2e', 'figma-audit-results', 'runs'));
  if (!pathIsWithin(realRunRoot, realRunsRoot) || realRunRoot === realRunsRoot) {
    throw new Error('Visual evidence run resolves outside its root.');
  }

  const evidencePath = join(runRoot, 'evidence.json');
  assertRegularFile(evidencePath, 'Visual evidence receipt');
  const evidence = readJson(evidencePath);
  if (![1, 2].includes(evidence.schemaVersion) || evidence.kind !== 'figma-parity-evidence') {
    throw new Error('Visual evidence run has an unsupported receipt contract.');
  }
  if (evidence.runId !== runId || evidence.id !== id || evidence.mode !== mode) {
    throw new Error('Visual evidence run identity does not match the requested target/mode.');
  }
  for (const [label, value] of [
    ['capture', evidence.capturedAt],
    ['completion', evidence.completedAt],
  ]) {
    const timestamp = new Date(value ?? '');
    if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
      throw new Error(`Visual evidence run is missing an exact ISO ${label} timestamp.`);
    }
  }
  if (Date.parse(evidence.completedAt) < Date.parse(evidence.capturedAt)) {
    throw new Error('Visual evidence completion predates its capture.');
  }
  if (!SHA256_RE.test(evidence.sourceState?.fingerprint ?? '')) {
    throw new Error('Visual evidence run is missing a workspace source fingerprint.');
  }
  if (
    !['owned-attested', 'provided-attested'].includes(evidence.captureRuntime?.source) ||
    evidence.captureRuntime?.sourceFingerprint !== evidence.sourceState.fingerprint ||
    !SHA256_RE.test(evidence.captureRuntime?.nonceSha256 ?? '') ||
    !String(evidence.captureRuntime?.endpoint ?? '').endsWith('/.well-known/figma-capture-runtime')
  ) {
    throw new Error('Visual evidence run did not use an attested capture runtime.');
  }
  if (
    evidence.captureRuntime.postCapture?.sourceFingerprint !==
      evidence.captureRuntime.sourceFingerprint ||
    evidence.captureRuntime.postCapture?.nonceSha256 !== evidence.captureRuntime.nonceSha256 ||
    evidence.captureRuntime.postCapture?.endpoint !== evidence.captureRuntime.endpoint
  ) {
    throw new Error('Visual evidence run did not re-attest the same runtime after capture.');
  }
  validateRendererRuntimeAttestation(evidence.rendererRuntime, evidence.rendererState);
  const sealedRendererFingerprint = sha256(stableJson(evidence.rendererState));
  if (
    evidence.rendererMutationGuard?.changed ||
    evidence.rendererMutationGuard?.beforeFingerprint !== sealedRendererFingerprint ||
    evidence.rendererMutationGuard?.afterFingerprint !== sealedRendererFingerprint
  ) {
    throw new Error('Visual evidence run reports a renderer mutation.');
  }
  const expectedResult = mode === 'signoff' ? 'passed' : 'completed';
  if (evidence.result !== expectedResult) {
    throw new Error(
      `Visual evidence run is not promotable: ${evidence.result ?? 'missing result'}.`
    );
  }
  if (
    evidence.acceptedBaselineChanges?.length ||
    evidence.capture?.acceptedBaselinesChanged?.length
  ) {
    throw new Error('Visual evidence run reports an accepted-baseline mutation.');
  }
  if (
    evidence.referenceMutationGuard?.changed ||
    evidence.referenceMutationGuard?.beforeSha256 !== evidence.referenceMutationGuard?.afterSha256
  ) {
    throw new Error('Visual evidence run reports a reference mutation.');
  }

  const resolveEvidenceArtifact = (declaredPath, expectedRelative, label) => {
    const artifact = resolve(repoRoot, declaredPath ?? '');
    const expected = join(runRoot, expectedRelative);
    if (artifact !== expected || !pathIsWithin(artifact, runRoot)) {
      throw new Error(`${label} path does not match the immutable run contract.`);
    }
    assertRegularFile(artifact, label);
    if (!pathIsWithin(realpathSync(artifact), realRunRoot)) {
      throw new Error(`${label} resolves outside the visual evidence run.`);
    }
    return artifact;
  };

  const capturedSnapshotPath = resolve(repoRoot, evidence.capturedSnapshotPath ?? '');
  if (!pathIsWithin(capturedSnapshotPath, runRoot) || capturedSnapshotPath === runRoot) {
    throw new Error('Captured snapshot escapes the visual evidence run.');
  }
  assertRegularFile(capturedSnapshotPath, 'Captured snapshot');
  if (!pathIsWithin(realpathSync(capturedSnapshotPath), realRunRoot)) {
    throw new Error('Captured snapshot resolves outside the visual evidence run.');
  }
  assertHash(capturedSnapshotPath, evidence.capture?.snapshotSha256, 'Captured snapshot');

  const strictAuditPath = resolveEvidenceArtifact(
    evidence.inspections?.strictAuditPath,
    join('strict-audit', 'strict-audit.json'),
    'Strict audit evidence'
  );
  assertHash(strictAuditPath, evidence.inspections?.strictAuditSha256, 'Strict audit evidence');
  const strictAudit = readJson(strictAuditPath);
  assertFocusedStrictAudit({
    audit: strictAudit,
    id,
    evidenceMode: mode,
    capturedSnapshotPath: evidence.capturedSnapshotPath,
  });
  const diffReportPath = resolveEvidenceArtifact(
    evidence.inspections?.diffReportPath,
    join('diff', 'index.html'),
    'Visual diff report'
  );
  assertHash(diffReportPath, evidence.inspections?.diffReportSha256, 'Visual diff report');

  const usesCausalReview = Number(evidence.schemaVersion ?? 1) >= 2;
  let designDiagnosisPath = null;
  let designDiagnosisHtmlPath = null;
  if (usesCausalReview) {
    const supportedReview =
      (evidence.review?.method === 'causal-design-diagnosis-v1' ||
        (evidence.review?.method === 'raster-confirmation-v1' &&
          evidence.review?.role === 'pixel-and-edge-confirmation-after-structural-inspection')) &&
      evidence.review?.primaryArtifact === 'design-diagnosis.html' &&
      evidence.review?.secondaryArtifact === 'diff/index.html';
    if (!supportedReview) {
      throw new Error('Visual evidence does not declare a supported raster review contract.');
    }
    designDiagnosisPath = resolveEvidenceArtifact(
      evidence.inspections?.designDiagnosisPath,
      'design-diagnosis.json',
      'Causal design diagnosis'
    );
    assertHash(
      designDiagnosisPath,
      evidence.inspections?.designDiagnosisSha256,
      'Causal design diagnosis'
    );
    designDiagnosisHtmlPath = resolveEvidenceArtifact(
      evidence.inspections?.designDiagnosisHtmlPath,
      'design-diagnosis.html',
      'Primary causal review report'
    );
    assertHash(
      designDiagnosisHtmlPath,
      evidence.inspections?.designDiagnosisHtmlSha256,
      'Primary causal review report'
    );
  }

  const reviewSha256 = digestNamedFiles([
    { name: 'capture.png', path: capturedSnapshotPath },
    ...(usesCausalReview
      ? [
          { name: 'design-diagnosis.json', path: designDiagnosisPath },
          { name: 'design-diagnosis.html', path: designDiagnosisHtmlPath },
        ]
      : []),
    { name: 'diff-report.html', path: diffReportPath },
    { name: 'evidence.json', path: evidencePath },
    { name: 'strict-audit.json', path: strictAuditPath },
  ]);

  return {
    runRoot,
    evidencePath,
    evidence,
    capturedSnapshotPath,
    strictAuditPath,
    strictAudit,
    designDiagnosisPath,
    designDiagnosisHtmlPath,
    diffReportPath,
    reviewSha256,
  };
}

export function atomicWriteFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
  );
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}

function hashDirectory(root) {
  const hash = createHash('sha256');
  if (!existsSync(root)) return hash.digest('hex');
  const paths = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) stack.push(path);
      else if (stat.isFile()) paths.push(path);
    }
  }
  for (const path of paths.sort()) {
    hash.update(relative(root, path));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function workspaceFingerprint({ repoRoot = REPO_ROOT } = {}) {
  const git = (gitArgs, encoding = null) =>
    execFileSync('git', gitArgs, { cwd: repoRoot, encoding, maxBuffer: 256 * 1024 * 1024 });
  const head = String(git(['rev-parse', 'HEAD'], 'utf8')).trim();
  const trackedPatchSha256 = sha256(git(['diff', '--binary', 'HEAD', '--', '.']));
  const untracked = String(git(['ls-files', '--others', '--exclude-standard', '-z'], 'utf8'))
    .split('\0')
    .filter(Boolean)
    .sort();
  const untrackedHash = createHash('sha256');
  for (const path of untracked) {
    const absolute = resolve(repoRoot, path);
    if (!pathIsWithin(absolute, repoRoot) || !existsSync(absolute)) continue;
    const stat = lstatSync(absolute);
    untrackedHash.update(path);
    untrackedHash.update('\0');
    if (stat.isFile()) untrackedHash.update(readFileSync(absolute));
    else if (stat.isSymbolicLink()) untrackedHash.update(String(realpathSync(absolute)));
    untrackedHash.update('\0');
  }
  const untrackedSha256 = untrackedHash.digest('hex');
  const fingerprint = sha256(`${head}\0${trackedPatchSha256}\0${untrackedSha256}`);
  return { head, trackedPatchSha256, untrackedSha256, fingerprint };
}

export function rendererFingerprint({ repoRoot = REPO_ROOT } = {}) {
  const playwrightPackage = readJson(
    join(repoRoot, 'node_modules', '@playwright', 'test', 'package.json')
  );
  const hashFile = (path) => sha256(readFileSync(path));
  return {
    node: process.version,
    platform: process.platform,
    osRelease: osRelease(),
    architecture: process.arch,
    playwright: playwrightPackage.version,
    chromium: assertRendererEvidenceSanitized(playwrightRendererIdentity({ repoRoot })),
    captureContract: {
      ...FIGMA_RENDERER_CAPTURE_CONTRACT,
      launchArgs: [...FIGMA_RENDERER_CAPTURE_CONTRACT.launchArgs],
    },
    playwrightConfigSha256: hashFile(join(repoRoot, 'client', 'playwright.config.ts')),
    viteConfigSha256: hashFile(join(repoRoot, 'client', 'vite.config.ts')),
    dependencyLockSha256: hashFile(join(repoRoot, 'package-lock.json')),
    fontsSha256: hashDirectory(join(repoRoot, 'client', 'public', 'fonts')),
  };
}

export function validateReviewer(value, flag = '--approved-by') {
  const denied = new Set([
    'agent',
    'claude',
    'codex',
    'design-system',
    'frontend-platform',
    'product-design',
    'user',
    'user-authorized',
    'unknown',
  ]);
  const normalized = String(value ?? '').trim();
  if (
    normalized.length < 2 ||
    normalized.length > 100 ||
    denied.has(normalized.toLowerCase()) ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._@+-]*$/u.test(normalized)
  ) {
    throw new Error(`${flag} must name the human who reviewed this exact evidence run.`);
  }
  return normalized;
}

export function resolveAutomaticApprover({ explicitName, env = process.env } = {}) {
  const candidate =
    explicitName ??
    env.FIGMA_AGENT_NAME ??
    (env.CLAUDECODE ? 'Claude' : undefined) ??
    (env.CURSOR_AGENT ? 'Cursor' : undefined) ??
    (env.CODEX_THREAD_ID || env.CODEX_CI ? 'Codex' : undefined) ??
    'AI agent';
  const normalized = String(candidate).trim();
  if (
    normalized.length < 2 ||
    normalized.length > 100 ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._@+-]*$/u.test(normalized)
  ) {
    throw new Error('--agent-name must identify the AI agent producing this receipt.');
  }
  return normalized;
}
