#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { dirname, join, relative, resolve } from 'path';
import { spawn, spawnSync } from 'child_process';
import { createServer } from 'net';
import { fileURLToPath } from 'url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import {
  loadReferenceRun,
  loadVisualEvidenceRun,
  readJson,
  rendererFingerprint,
  resolveManifestArtifact,
  stableJson,
  workspaceFingerprint,
} from './lib/figma-reference-run.mjs';
import {
  captureRuntimeEnvironment,
  captureRuntimeIdentityFromEnvironment,
  createCaptureRuntimeIdentity,
  verifyCaptureRuntime,
} from './lib/figma-capture-runtime.mjs';
import { targetSourceState } from './lib/figma-target-closure.mjs';
import { visualProjectForTarget } from './lib/figma-visual-project.mjs';
import { exactPlaywrightSelection } from './lib/figma-playwright-selection.mjs';
import {
  rendererAttestationEnvironment,
  validateRendererRuntimeAttestation,
} from './lib/figma-renderer-contract.mjs';
import {
  resolveCanonicalSnapshotPath,
  snapshotRelativePath as declaredSnapshotRelativePath,
} from './lib/figma-snapshot-contract.mjs';
import { assertStructuralMeasurementAllowed } from './lib/figma-measurement-preflight.mjs';
import { inspectTarget } from './figma-inspect.mjs';

import { getFigmoonConfig } from '../lib/config.mjs';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const __figmoonConfig = getFigmoonConfig();
const clientRoot = __figmoonConfig.clientRoot;
const repoRoot = __figmoonConfig.consumerRoot;
const snapshotRoot = __figmoonConfig.snapshotRoot;
const registryPath = __figmoonConfig.registryPath;
const manifestPath = __figmoonConfig.manifestPath;
const dependencyGraphPath = __figmoonConfig.dependencyGraphPath;
const screenRegistryPath = __figmoonConfig.screenRegistryPath;

async function compareBaselineCapture(baselinePath, capturePath, maxRatio) {
  const [baselineBuffer, captureBuffer] = await Promise.all([
    sharp(baselinePath).ensureAlpha().png().toBuffer(),
    sharp(capturePath).ensureAlpha().png().toBuffer(),
  ]);
  const baseline = PNG.sync.read(baselineBuffer);
  const capture = PNG.sync.read(captureBuffer);
  if (baseline.width !== capture.width || baseline.height !== capture.height) {
    return {
      metric: 'pixelmatch-aa-excluded-v1',
      ratio: 1,
      maxRatio,
      dimensionMismatch: true,
    };
  }
  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const mismatched = pixelmatch(
    baseline.data,
    capture.data,
    diff.data,
    baseline.width,
    baseline.height,
    { threshold: 0.1, includeAA: false, checkerboard: false }
  );
  return {
    metric: 'pixelmatch-aa-excluded-v1',
    ratio: mismatched / (baseline.width * baseline.height),
    maxRatio,
    dimensionMismatch: false,
  };
}

function parseArgs(argv) {
  const valueFlags = new Map([
    ['--id', 'id'],
    ['--run-id', 'runId'],
    ['--reference-run', 'referenceRun'],
  ]);
  const parsed = { measure: false, id: null, runId: null, referenceRun: null };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--measure') {
      if (parsed.measure) throw new Error('--measure may be provided only once.');
      parsed.measure = true;
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const flag = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
    const key = valueFlags.get(flag);
    if (!key) throw new Error(`Unsupported Figma evidence argument: ${arg}`);
    if (seen.has(flag)) throw new Error(`${flag} may be provided only once.`);
    seen.add(flag);

    const value = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    parsed[key] = value;
  }

  return parsed;
}

const parsedArgs = parseArgs(process.argv.slice(2));
const measureOnly = parsedArgs.measure;
const id = parsedArgs.id;
const requestedRunId = parsedArgs.runId;
const requestedReferenceRun = parsedArgs.referenceRun;

if (!id) {
  throw new Error(
    (measureOnly ? 'figma:measure' : 'figma:signoff') + ' requires exactly one --id <registry-id>.'
  );
}
if (requestedReferenceRun && !measureOnly) {
  throw new Error('figma:signoff never accepts a staged reference; promote it canonically first.');
}

const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const item = registry.items.find((entry) => entry.id === id);
if (!item) throw new Error('Unknown registry id: ' + id);
const comparable =
  (requestedReferenceRun
    ? ['mapped', 'requires-remap'].includes(item.referenceStatus)
    : item.referenceStatus === 'mapped') &&
  ['partial', 'implemented'].includes(item.implementationStatus) &&
  item.parityStatus !== 'waived' &&
  (!requestedReferenceRun || measureOnly) &&
  (requestedReferenceRun || item.parityStatus !== 'not-comparable');
if (!comparable) {
  throw new Error(
    `${id} is not a comparable Figma target (${item.referenceStatus ?? 'missing reference status'}/${item.parityStatus ?? 'missing parity status'}). ` +
      'Run its fixture-contract test while remapping the reference; do not create a visual measurement or signoff from this state.'
  );
}
if (!item.visualTest?.file || !item.visualTest?.name) {
  throw new Error(
    'Signoff requires visualTest.file and visualTest.name in the registry for ' + id + '.'
  );
}
const stagedReference = requestedReferenceRun
  ? await loadReferenceRun({
      runId: requestedReferenceRun,
      id,
      registry,
      manifest,
      allowRemapCandidate: true,
      allowNodeNameChangeCandidate: true,
      allowSourceRemapCandidate: true,
    })
  : null;
const manifestMatch = Object.entries(manifest.items ?? {}).find(([, entry]) =>
  entry.registryIds?.includes(id)
);
const manifestEntry = manifestMatch?.[1];
if (!manifestEntry) throw new Error(`No Figma manifest entry owns '${id}'.`);

const structuralPreflight = await inspectTarget({
  id,
  runId: null,
  figmaSource: 'canonical',
  referenceRun: requestedReferenceRun,
  json: true,
});
const structuralWorkflow = assertStructuralMeasurementAllowed({
  id,
  comparison: structuralPreflight.report.comparison,
  reportPath: relative(repoRoot, structuralPreflight.htmlPath),
});
const sourceState = workspaceFingerprint();
if (
  structuralPreflight.report.browser.captureRuntime.sourceFingerprint !==
  sourceState.fingerprint
) {
  throw new Error(
    `Workspace source changed after structural inspection for '${id}'. Rerun the measurement so its preflight and raster capture use one source state.`
  );
}

function readCurrentTargetSourceState() {
  const currentRegistry = readJson(registryPath);
  const currentItem = currentRegistry.items?.find((candidate) => candidate.id === id);
  if (!currentItem) throw new Error(`Target source contract disappeared for '${id}'.`);
  return targetSourceState({
    item: currentItem,
    dependencyGraph: readJson(dependencyGraphPath),
    screenRegistry: readJson(screenRegistryPath),
    repoRoot,
  });
}

const project = visualProjectForTarget(item);
if (!project) throw new Error('No Playwright project is registered for ' + id + '.');

function withoutVisionEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith('FIGMA_VISION_'))
  );
}

const nonVisionEnvironment = withoutVisionEnvironment();

function snapshotRelativePath() {
  if (item.snapshot) return declaredSnapshotRelativePath(item);
  const suite =
    item.kind === 'component'
      ? 'desktop/visual/components.spec.ts'
      : project +
        '/visual/' +
        (project === 'desktop'
          ? 'pages.spec.ts'
          : project === 'mobile'
            ? 'mobile.spec.ts'
            : 'tablet.spec.ts');
  return join(suite, id + '.png');
}

function resolveSnapshotPath(root) {
  return join(root, snapshotRelativePath());
}

function hash(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

function snapshotHashes(root) {
  const paths = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current || !existsSync(current)) continue;
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        throw new Error(`Visual snapshot roots must not contain symbolic links: ${path}`);
      }
      if (info.isDirectory()) stack.push(path);
      else if (info.isFile() && path.endsWith('.png')) paths.push(path);
    }
  }
  return new Map(paths.map((path) => [path, hash(path)]));
}

function changedSnapshotPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

function run(commandArgs, label, environment = nonVisionEnvironment) {
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: clientRoot,
    env: environment,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(label + ' failed for ' + id + '.');
}

function resolveExactPlaywrightTest({ testFile, testName, projectName, environment }) {
  const result = spawnSync(
    process.execPath,
    [
      join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test',
      testFile.replace(/^client\//, ''),
      '--project',
      projectName,
      '--grep',
      testName.replace(/[.*+?^$\{()|[\]\\]/g, '\\$&') + '$',
      '--list',
      '--reporter=json',
    ],
    {
      cwd: clientRoot,
      env: environment,
      encoding: 'utf8',
    }
  );
  if (result.status !== 0) {
    throw new Error(`Playwright test discovery failed for ${id}.`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Playwright test discovery returned invalid JSON for ${id}.`);
  }
  return exactPlaywrightSelection({
    report,
    testName,
    testFile,
    project: projectName,
  });
}

function runAsync(commandArgs, label, environment = nonVisionEnvironment) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, commandArgs, {
      cwd: clientRoot,
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${label} failed for ${id}${signal ? ` (${signal})` : '.'}`));
    });
  });
}

function makeRunId() {
  return `${measureOnly ? 'measure' : 'signoff'}-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

function validateRunId(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value)) {
    throw new Error('--run-id may contain letters, numbers, ., _, and - (max 120 chars).');
  }
  return value;
}

function allocatePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate an isolated local port for Figma capture.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function waitForOwnedCaptureRuntime(baseUrl, child, identity, sourceFingerprint) {
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Owned visual capture runtime exited with code ${child.exitCode}.`);
    }
    try {
      return await verifyCaptureRuntime({
        baseUrl,
        identity,
        currentSourceFingerprint: sourceFingerprint,
        timeoutMilliseconds: 1_000,
      });
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    `Timed out waiting for the owned visual capture runtime${lastError ? `: ${lastError.message}` : '.'}`
  );
}

async function stopOwnedCaptureRuntime(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}

const runId = validateRunId(requestedRunId ?? makeRunId());
const runRoot = join(clientRoot, 'e2e', 'figma-audit-results', 'runs', runId);
const captureSnapshotRoot = join(runRoot, 'snapshots');
const captureOutputRoot = join(runRoot, 'playwright-results');
const captureReportRoot = join(runRoot, 'playwright-report');
const diffReportRoot = join(runRoot, 'diff');
const strictAuditRoot = join(runRoot, 'strict-audit');
const visionEvidencePath = join(runRoot, 'vision.json');
const rendererRuntimePath = join(runRoot, 'renderer-runtime.json');
mkdirSync(dirname(runRoot), { recursive: true });
mkdirSync(runRoot);

const targetSourceBefore = readCurrentTargetSourceState();
const rendererState = rendererFingerprint();
const providedCaptureBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const captureBaseUrl = providedCaptureBaseUrl ?? `http://127.0.0.1:${await allocatePort()}`;
const captureRuntimeIdentity = providedCaptureBaseUrl
  ? captureRuntimeIdentityFromEnvironment(nonVisionEnvironment)
  : createCaptureRuntimeIdentity(sourceState.fingerprint);
if (!captureRuntimeIdentity) {
  throw new Error(
    'A provided PLAYWRIGHT_BASE_URL requires the Figma capture runtime nonce and source fingerprint credentials.'
  );
}
let ownedCaptureRuntime = null;
let captureRuntimeAttestation;
if (providedCaptureBaseUrl) {
  captureRuntimeAttestation = await verifyCaptureRuntime({
    baseUrl: captureBaseUrl,
    identity: captureRuntimeIdentity,
    currentSourceFingerprint: sourceState.fingerprint,
  });
} else {
  ownedCaptureRuntime = spawn(
    'npm',
    [
      'run',
      'dev',
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      new URL(captureBaseUrl).port,
      '--strictPort',
    ],
    {
      cwd: clientRoot,
      env: {
        ...nonVisionEnvironment,
        ...captureRuntimeEnvironment(captureRuntimeIdentity),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  ownedCaptureRuntime.stdout.resume();
  ownedCaptureRuntime.stderr.resume();
  try {
    captureRuntimeAttestation = await waitForOwnedCaptureRuntime(
      captureBaseUrl,
      ownedCaptureRuntime,
      captureRuntimeIdentity,
      sourceState.fingerprint
    );
  } catch (error) {
    await stopOwnedCaptureRuntime(ownedCaptureRuntime);
    throw error;
  }
}
const captureEnv = {
  ...nonVisionEnvironment,
  PLAYWRIGHT_BASE_URL: captureBaseUrl,
  PLAYWRIGHT_REUSE_SERVER: '1',
  ...captureRuntimeEnvironment(captureRuntimeIdentity),
  PLAYWRIGHT_VISUAL_SNAPSHOT_ROOT: captureSnapshotRoot,
  PLAYWRIGHT_VISUAL_OUTPUT_DIR: captureOutputRoot,
  PLAYWRIGHT_VISUAL_REPORT_DIR: captureReportRoot,
  FIGMA_DESIGN_DIAGNOSTICS_DIR: join(runRoot, 'design-ownership'),
  ...rendererAttestationEnvironment({
    attestationPath: rendererRuntimePath,
    runtimeVersion: rendererState.chromium.runtimeVersion,
  }),
};
const snapshotPath = item.snapshot
  ? resolveCanonicalSnapshotPath({ item, snapshotRoot, mustExist: false })
  : resolveSnapshotPath(snapshotRoot);
const capturedSnapshotPath = resolveSnapshotPath(captureSnapshotRoot);
const referencePath = stagedReference?.referencePath ?? resolveManifestArtifact(manifestEntry);
const baselineBefore = snapshotHashes(snapshotRoot);
const referenceSha256Before = hash(referencePath);

const exactTestName = item.visualTest.name;
// Playwright matches --grep against the full title (including file/project), so
// anchor the registered test title at the end. The registry preflight separately
// verifies this exact title exists in this exact file.
const escapedTestName = exactTestName.replace(/[.*+?^$\{()|[\]\\]/g, '\\$&');
const evidence = {
  schemaVersion: 2,
  kind: 'figma-parity-evidence',
  id,
  mode: measureOnly ? 'measure' : 'signoff',
  visualTest: item.visualTest,
  project,
  runId,
  artifacts: {
    root: relative(repoRoot, runRoot),
    snapshotRoot: relative(repoRoot, captureSnapshotRoot),
    diffReportRoot: relative(repoRoot, diffReportRoot),
    strictAuditRoot: relative(repoRoot, strictAuditRoot),
    visionEvidencePath: relative(repoRoot, visionEvidencePath),
  },
  captureRuntime: {
    source: providedCaptureBaseUrl ? 'provided-attested' : 'owned-attested',
    protocol: new URL(captureBaseUrl).protocol.slice(0, -1),
    ...captureRuntimeAttestation,
  },
  claim: measureOnly
    ? 'Measurement only: this run is not a Figma-parity or baseline-promotion claim.'
    : 'Targeted Figma signoff claim.',
  review: {
    method: 'raster-confirmation-v1',
    role: 'pixel-and-edge-confirmation-after-structural-inspection',
    primaryArtifact: 'design-diagnosis.html',
    secondaryArtifact: 'diff/index.html',
  },
  structuralPreflight: {
    reportPath: relative(repoRoot, structuralPreflight.jsonPath),
    htmlPath: relative(repoRoot, structuralPreflight.htmlPath),
    workflow: structuralWorkflow,
    summary: structuralPreflight.report.comparison.summary,
  },
  referencePath: relative(repoRoot, referencePath),
  referenceSource: stagedReference
    ? {
        kind: 'staged-acquisition',
        runId: requestedReferenceRun,
        evidencePath: relative(repoRoot, stagedReference.evidencePath),
        evidenceSha256: hash(stagedReference.evidencePath),
      }
    : { kind: 'canonical-manifest', manifestKey: manifestMatch[0] },
  sourceState,
  targetSourceState: targetSourceBefore,
  rendererState,
  canonicalSnapshotPath: relative(repoRoot, snapshotPath),
  capturedSnapshotPath: relative(repoRoot, capturedSnapshotPath),
  before: {
    referenceSha256: referenceSha256Before,
    snapshotSha256: hash(snapshotPath),
  },
  capturedAt: new Date().toISOString(),
  vision: {
    status: /^(1|true|yes)$/i.test(process.env.FIGMA_VISION_ENABLED ?? '') ? 'pending' : 'disabled',
    claim:
      'Optional advisory visual/OCR evidence; it cannot establish parity or authorize a baseline update.',
  },
};

let exitCode = 1;
try {
  run(
    [
      join(scriptDir, 'check-figma-refs.mjs'),
      '--id',
      id,
      ...(requestedReferenceRun ? ['--reference-run', requestedReferenceRun] : []),
      ...(measureOnly ? ['--allow-stale-baseline'] : []),
      ...(measureOnly ? [] : ['--require-signoff']),
    ],
    'Registry/mapping preflight'
  );

  evidence.playwrightSelection = resolveExactPlaywrightTest({
    testFile: item.visualTest.file,
    testName: exactTestName,
    projectName: project,
    environment: captureEnv,
  });

  run(
    [
      join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test',
      item.visualTest.file.replace(/^client\//, ''),
      '--project',
      project,
      '--grep',
      escapedTestName + '$',
      '--update-snapshots=all',
    ],
    'Fresh visual capture',
    captureEnv
  );
  if (!existsSync(rendererRuntimePath)) {
    throw new Error('Fresh capture did not produce renderer runtime attestation.');
  }
  evidence.rendererRuntime = validateRendererRuntimeAttestation(
    readJson(rendererRuntimePath),
    rendererState
  );
  if (!existsSync(capturedSnapshotPath)) {
    throw new Error(
      'Fresh capture did not produce the isolated registry snapshot: ' + capturedSnapshotPath
    );
  }
  resolveCanonicalSnapshotPath({ item, snapshotRoot: captureSnapshotRoot });
  const postCaptureRuntimeAttestation = await verifyCaptureRuntime({
    baseUrl: captureBaseUrl,
    identity: captureRuntimeIdentity,
    currentSourceFingerprint: sourceState.fingerprint,
  });
  evidence.captureRuntime.postCapture = postCaptureRuntimeAttestation;
  const baselineAfter = snapshotHashes(snapshotRoot);
  const mutatedBaselines = changedSnapshotPaths(baselineBefore, baselineAfter);
  if (mutatedBaselines.length) {
    throw new Error(
      'Fresh capture modified accepted visual baselines: ' +
        mutatedBaselines.map((path) => relative(repoRoot, path)).join(', ')
    );
  }
  evidence.capture = {
    snapshotSha256: hash(capturedSnapshotPath),
    referenceSha256: referencePath ? hash(referencePath) : null,
    acceptedBaselinesChanged: [],
  };
  if (!measureOnly) {
    const reproducibility = await compareBaselineCapture(
      snapshotPath,
      capturedSnapshotPath,
      registry._meta.thresholds.regressionBaseline
    );
    evidence.capture.baselineReproducibility = {
      ...reproducibility,
      baselineSha256: hash(snapshotPath),
      captureSha256: hash(capturedSnapshotPath),
    };
    if (reproducibility.dimensionMismatch || reproducibility.ratio > reproducibility.maxRatio) {
      throw new Error(
        'Signoff capture exceeds the accepted baseline reproducibility threshold. Promote the reviewed measurement run before signoff.'
      );
    }
  }

  // These consumers all read the completed capture and write distinct evidence.
  // Vision stays advisory, but begins alongside the deterministic inspections.
  const visionPromise =
    evidence.vision.status === 'pending' && referencePath
      ? runAsync(
          [
            join(scriptDir, 'figma-vision-inspect.mjs'),
            '--input',
            `reference=${referencePath}`,
            '--input',
            `current=${capturedSnapshotPath}`,
            '--out',
            visionEvidencePath,
            '--max-parallel',
            process.env.FIGMA_VISION_MAX_PARALLEL ?? '2',
            '--allow-partial',
          ],
          'Optional vision evidence',
          process.env
        )
      : null;
  const [inspections, visionInspection] = await Promise.all([
    Promise.allSettled([
      runAsync(
        [
          join(scriptDir, 'figma-diff-report.mjs'),
          '--id',
          id,
          '--snapshot-root',
          captureSnapshotRoot,
          '--out-dir',
          diffReportRoot,
          ...(stagedReference ? ['--reference-path', referencePath] : []),
        ],
        'Fresh Figma diff report'
      ),
      runAsync(
        [
          join(scriptDir, 'figma-strict-audit.mjs'),
          '--mode',
          measureOnly ? 'report' : 'signoff',
          '--id',
          id,
          '--snapshot-root',
          captureSnapshotRoot,
          '--out-dir',
          strictAuditRoot,
          ...(stagedReference ? ['--reference-path', referencePath] : []),
        ],
        'Strict Figma audit'
      ),
    ]),
    visionPromise
      ? Promise.allSettled([visionPromise]).then(([result]) => result)
      : Promise.resolve(null),
  ]);
  const failedInspections = inspections.filter((result) => result.status === 'rejected');
  evidence.inspections = {
    strictAuditMode: measureOnly ? 'report' : 'signoff',
    baselineMutationGuard: 'passed',
    strictAuditPath: relative(repoRoot, join(strictAuditRoot, 'strict-audit.json')),
    strictAuditSha256: hash(join(strictAuditRoot, 'strict-audit.json')),
    diffReportPath: relative(repoRoot, join(diffReportRoot, 'index.html')),
    diffReportSha256: hash(join(diffReportRoot, 'index.html')),
  };
  if (evidence.vision.status === 'pending' && !referencePath) {
    evidence.vision = {
      status: 'unavailable',
      artifact: relative(repoRoot, visionEvidencePath),
      claim: evidence.vision.claim,
      error: 'Optional vision evidence requires a local Figma reference image.',
    };
  } else if (evidence.vision.status === 'pending' && visionInspection?.status === 'fulfilled') {
    try {
      const visionArtifact = JSON.parse(readFileSync(visionEvidencePath, 'utf8'));
      const visionResults = Array.isArray(visionArtifact.results) ? visionArtifact.results : [];
      const successfulInputs = visionResults.filter((result) => result.status === 'ok').length;
      const failedInputs = visionResults.filter((result) => result.status === 'error').length;
      if (!successfulInputs)
        throw new Error('Optional vision evidence did not contain a successful image result.');
      evidence.vision = {
        status: failedInputs ? 'partial' : 'captured',
        artifact: relative(repoRoot, visionEvidencePath),
        claim: evidence.vision.claim,
        successfulInputs,
        failedInputs,
      };
    } catch (visionError) {
      evidence.vision = {
        status: 'unavailable',
        artifact: relative(repoRoot, visionEvidencePath),
        claim: evidence.vision.claim,
        error: visionError instanceof Error ? visionError.message : String(visionError),
      };
      console.warn(
        'Optional vision evidence was unavailable; continuing with local visual evidence.'
      );
    }
  } else if (evidence.vision.status === 'pending') {
    evidence.vision = {
      status: 'unavailable',
      artifact: relative(repoRoot, visionEvidencePath),
      claim: evidence.vision.claim,
      error:
        visionInspection?.status === 'rejected'
          ? visionInspection.reason instanceof Error
            ? visionInspection.reason.message
            : String(visionInspection.reason)
          : 'Optional vision evidence did not start.',
    };
    console.warn(
      'Optional vision evidence was unavailable; continuing with local visual evidence.'
    );
  }
  if (failedInspections.length) {
    throw new Error(
      failedInspections
        .map((result) =>
          result.status === 'rejected' ? result.reason.message : 'Unknown inspection error'
        )
        .join('; ')
    );
  }
  await runAsync(
    [join(scriptDir, 'design-diagnose.mjs'), '--run', runRoot],
    'Design ownership diagnosis'
  );
  const diagnosisPath = join(runRoot, 'design-diagnosis.json');
  const diagnosisHtmlPath = join(runRoot, 'design-diagnosis.html');
  evidence.inspections.designDiagnosisPath = relative(repoRoot, diagnosisPath);
  evidence.inspections.designDiagnosisSha256 = hash(diagnosisPath);
  evidence.inspections.designDiagnosisHtmlPath = relative(repoRoot, diagnosisHtmlPath);
  evidence.inspections.designDiagnosisHtmlSha256 = hash(diagnosisHtmlPath);
  const strictAuditEvidence = readJson(join(strictAuditRoot, 'strict-audit.json'));
  evidence.parity = {
    outcome:
      strictAuditEvidence.counts?.acceptanceAboveBase > 0 ||
      strictAuditEvidence.counts?.structuralAboveBase > 0
        ? 'drifting'
        : strictAuditEvidence.counts?.rawDiffs === 1
          ? 'within-threshold'
          : 'not-comparable',
    rawAboveBase: strictAuditEvidence.counts?.rawAboveBase ?? null,
    acceptanceAboveBase: strictAuditEvidence.counts?.acceptanceAboveBase ?? null,
    acceptanceMetric: 'pixelmatch-aa-excluded-v1',
    structuralAboveBase: strictAuditEvidence.counts?.structuralAboveBase ?? null,
    structuralMetric: 'pixelmatch-raw-masked-sobel-jaccard-v3',
    structuralThreshold: registry._meta.thresholds.structuralEdgeJaccard,
    rawDiffs: strictAuditEvidence.counts?.rawDiffs ?? null,
    claim: measureOnly
      ? 'Diagnostic outcome only; measurement completion is not parity approval.'
      : 'Canonical target signoff outcome.',
  };
  evidence.result = measureOnly ? 'completed' : 'passed';
  exitCode = 0;
} catch (error) {
  evidence.result = 'failed';
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(error);
} finally {
  const baselineAfter = snapshotHashes(snapshotRoot);
  const mutatedBaselines = changedSnapshotPaths(baselineBefore, baselineAfter);
  evidence.acceptedBaselineChanges = mutatedBaselines.map((path) => relative(repoRoot, path));
  if (mutatedBaselines.length) {
    const message =
      'Capture touched accepted visual baselines: ' + evidence.acceptedBaselineChanges.join(', ');
    evidence.result = 'failed';
    evidence.error = evidence.error ? `${evidence.error}; ${message}` : message;
    exitCode = 1;
  }
  const referenceSha256After = hash(referencePath);
  evidence.referenceMutationGuard = {
    beforeSha256: referenceSha256Before,
    afterSha256: referenceSha256After,
    changed: referenceSha256Before !== referenceSha256After,
  };
  if (referenceSha256Before !== referenceSha256After) {
    const message = 'Figma reference changed while measurement/signoff was running.';
    evidence.result = 'failed';
    evidence.error = evidence.error ? `${evidence.error}; ${message}` : message;
    exitCode = 1;
  }
  try {
    const targetSourceAfter = readCurrentTargetSourceState();
    evidence.targetSourceMutationGuard = {
      beforeFingerprint: targetSourceBefore.fingerprint,
      afterFingerprint: targetSourceAfter.fingerprint,
      changed: targetSourceBefore.fingerprint !== targetSourceAfter.fingerprint,
    };
    if (evidence.targetSourceMutationGuard.changed) {
      const message =
        "This target's implementation or shared visual inputs changed during measurement/signoff.";
      evidence.result = 'failed';
      evidence.error = evidence.error ? `${evidence.error}; ${message}` : message;
      exitCode = 1;
    }
  } catch (targetSourceError) {
    const message =
      targetSourceError instanceof Error ? targetSourceError.message : String(targetSourceError);
    evidence.targetSourceMutationGuard = {
      beforeFingerprint: targetSourceBefore.fingerprint,
      afterFingerprint: null,
      changed: true,
      error: message,
    };
    evidence.result = 'failed';
    evidence.error = evidence.error ? `${evidence.error}; ${message}` : message;
    exitCode = 1;
  }
  try {
    const rendererAfter = rendererFingerprint();
    const beforeFingerprint = createHash('sha256').update(stableJson(rendererState)).digest('hex');
    const afterFingerprint = createHash('sha256').update(stableJson(rendererAfter)).digest('hex');
    evidence.rendererMutationGuard = {
      beforeFingerprint,
      afterFingerprint,
      changed: beforeFingerprint !== afterFingerprint,
    };
    if (evidence.rendererMutationGuard.changed) {
      const message = 'The Playwright renderer distribution changed during measurement/signoff.';
      evidence.result = 'failed';
      evidence.error = evidence.error ? `${evidence.error}; ${message}` : message;
      exitCode = 1;
    }
  } catch (rendererError) {
    const message = rendererError instanceof Error ? rendererError.message : String(rendererError);
    evidence.rendererMutationGuard = {
      beforeFingerprint: null,
      afterFingerprint: null,
      changed: true,
      error: message,
    };
    evidence.result = 'failed';
    evidence.error = evidence.error ? `${evidence.error}; ${message}` : message;
    exitCode = 1;
  }
  evidence.completedAt = new Date().toISOString();
  writeFileSync(join(runRoot, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  await stopOwnedCaptureRuntime(ownedCaptureRuntime);
}

console.log(`Figma evidence: ${runRoot}`);
if (exitCode === 0) {
  console.log(
    `Raster confirmation report (after structural inspection, or as fallback): ${join(runRoot, 'design-diagnosis.html')}`
  );
  console.log(`Secondary pixel diff: ${join(diffReportRoot, 'index.html')}`);
  const completedRun = loadVisualEvidenceRun({
    runId,
    id,
    mode: measureOnly ? 'measure' : 'signoff',
  });
  console.log(`Review SHA-256: ${completedRun.reviewSha256}`);
}
process.exit(exitCode);
