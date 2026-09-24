import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { assertFigmaAcquisitionPluginIntegrity } from './lib/figma-plugin-integrity.mjs';
import {
  READ_ONLY_FIGMA_OPERATIONS,
  loadReferenceRun,
  loadVisualEvidenceRun,
  rendererFingerprint,
  resolveAutomaticApprover,
  sha256,
  stableJson,
  validateReviewer,
} from './lib/figma-reference-run.mjs';

const ACQUISITION_PLUGIN = assertFigmaAcquisitionPluginIntegrity().plugin;

function pngBytes(width = 2, height = 2, color = [10, 20, 30, 255]) {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = color[0];
    png.data[index + 1] = color[1];
    png.data[index + 2] = color[2];
    png.data[index + 3] = color[3];
  }
  return PNG.sync.write(png);
}

function fixture(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'figmoon-reference-run-'));
  const clientRoot = join(repoRoot, 'client');
  const runId = 'reference-test-run';
  const runRoot = join(clientRoot, 'e2e', 'figma-reference-runs', runId);
  const figmaRoot = join(repoRoot, 'docs', 'design', 'figma');
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(figmaRoot, { recursive: true });
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  const canonicalPath = join(figmaRoot, 'pages', 'target.png');
  mkdirSync(join(figmaRoot, 'pages'), { recursive: true });
  const canonical = pngBytes();
  const candidate = pngBytes();
  writeFileSync(canonicalPath, canonical);
  writeFileSync(join(runRoot, 'reference.png'), candidate);
  const nodeJson = stableJson({
    id: '1:2',
    name: 'Target',
    type: 'FRAME',
    bounds: { x: 0, y: 0, width: 2, height: 2 },
  });
  const variablesJson = stableJson({ collections: [] });
  writeFileSync(join(runRoot, 'node.json'), nodeJson);
  writeFileSync(join(runRoot, 'variables.json'), variablesJson);

  const registry = {
    items: [
      {
        id: 'target',
        referencePath: 'docs/design/figma/pages/target.png',
        referenceStatus: 'mapped',
        implementationStatus: 'implemented',
        parityStatus: 'drifting',
      },
    ],
  };
  const manifest = {
    figmaFile: { key: 'FileKey123', name: 'Final ' },
    items: {
      target: {
        registryIds: ['target'],
        referencePath: 'docs/design/figma/pages/target.png',
        exportBounds: { width: 2, height: 2 },
        assetSha256: sha256(canonical),
        figma: {
          pageId: '0:1',
          pageName: 'Final ',
          nodeId: '1:2',
          nodeName: 'Target',
          nodeType: 'FRAME',
        },
      },
    },
  };
  const evidence = {
    schemaVersion: 1,
    kind: 'figma-reference-acquisition',
    runId,
    target: {
      registryId: 'target',
      manifestKey: 'target',
      logicalReferencePath: 'docs/design/figma/pages/target.png',
    },
    acquisition: {
      adapter: 'figmoon-reference-broker',
      adapterVersion: '1.0.0',
      protocol: 'figmoon-reference-acquisition/v1',
      plugin: { ...ACQUISITION_PLUGIN },
      operations: [...READ_ONLY_FIGMA_OPERATIONS],
    },
    source: {
      file: { key: 'FileKey123', name: 'Final ' },
      page: { id: '0:1', name: 'Final ' },
      node: {
        id: '1:2',
        name: 'Target',
        type: 'FRAME',
        bounds: { x: 0, y: 0, width: 2, height: 2 },
        path: relative(repoRoot, join(runRoot, 'node.json')),
        sha256: sha256(nodeJson),
      },
      variables: {
        path: relative(repoRoot, join(runRoot, 'variables.json')),
        sha256: sha256(variablesJson),
      },
      stability: {
        beforeSha256: sha256(nodeJson),
        afterSha256: sha256(nodeJson),
        ancestorPage: { id: '0:1', name: 'Final ' },
        changeTracking: {
          supported: true,
          beforeReadStart: 0,
          beforeReadEnd: 0,
          afterReadStart: 0,
          afterReadEnd: 0,
        },
      },
      export: {
        path: relative(repoRoot, join(runRoot, 'reference.png')),
        sha256: sha256(candidate),
        bounds: { width: 2, height: 2 },
        spec: { format: 'PNG', scale: 1, clip: false },
      },
    },
    canonicalBefore: {
      sha256: sha256(canonical),
      manifestSha256: sha256(canonical),
    },
    acquiredAt: '2026-08-02T00:00:00.000Z',
    result: 'staged',
  };
  writeFileSync(join(runRoot, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  return { repoRoot, clientRoot, runId, runRoot, registry, manifest, evidence, canonicalPath };
}

function visualFixture(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'figmoon-visual-run-'));
  const clientRoot = join(repoRoot, 'client');
  const runId = 'visual-test-run';
  const runRoot = join(clientRoot, 'e2e', 'figma-audit-results', 'runs', runId);
  const capturePath = join(runRoot, 'snapshots', 'desktop', 'target.png');
  const strictPath = join(runRoot, 'strict-audit', 'strict-audit.json');
  const diffPath = join(runRoot, 'diff', 'index.html');
  mkdirSync(dirname(capturePath), { recursive: true });
  mkdirSync(dirname(strictPath), { recursive: true });
  mkdirSync(dirname(diffPath), { recursive: true });
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const capture = pngBytes();
  const strict = stableJson({
    filters: {
      id: 'target',
      crop: null,
      grep: null,
      mode: 'report',
      snapshotRoot: join(runRoot, 'snapshots'),
      outDir: join(runRoot, 'strict-audit'),
      referencePath: null,
    },
    focused: true,
    counts: {
      registryItems: 1,
      rawDiffs: 1,
      rawAboveBase: 0,
      dimensionMismatches: 0,
      targetMaskingFiles: 1,
      targetOwnedMasking: 0,
      exceptionPolicyErrors: 0,
    },
    rawDiffs: [
      {
        id: 'target',
        snapshotPath: relative(repoRoot, capturePath),
        dimensionMismatch: false,
        aboveBase: false,
      },
    ],
    targetMaskingAudit: { inspectedFiles: ['client/src/Target.tsx'] },
    targetOwnedMasking: [],
    exceptionPolicyErrors: [],
  });
  const diff = '<!doctype html><title>diff</title>\n';
  const rendererState = { chromium: { runtimeVersion: '1.2.3.4' } };
  const rendererStateSha256 = sha256(stableJson(rendererState));
  writeFileSync(capturePath, capture);
  writeFileSync(strictPath, strict);
  writeFileSync(diffPath, diff);
  const evidence = {
    schemaVersion: 1,
    kind: 'figma-parity-evidence',
    id: 'target',
    mode: 'measure',
    runId,
    result: 'completed',
    capturedAt: '2026-08-02T00:00:00.000Z',
    completedAt: '2026-08-02T00:00:01.000Z',
    sourceState: { fingerprint: 'b'.repeat(64) },
    captureRuntime: {
      source: 'owned-attested',
      sourceFingerprint: 'b'.repeat(64),
      nonceSha256: 'c'.repeat(64),
      endpoint: 'http://127.0.0.1:4173/.well-known/figma-capture-runtime',
      postCapture: {
        sourceFingerprint: 'b'.repeat(64),
        nonceSha256: 'c'.repeat(64),
        endpoint: 'http://127.0.0.1:4173/.well-known/figma-capture-runtime',
      },
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
      beforeFingerprint: rendererStateSha256,
      afterFingerprint: rendererStateSha256,
      changed: false,
    },
    capturedSnapshotPath: relative(repoRoot, capturePath),
    capture: {
      snapshotSha256: sha256(capture),
      acceptedBaselinesChanged: [],
    },
    inspections: {
      strictAuditPath: relative(repoRoot, strictPath),
      strictAuditSha256: sha256(strict),
      diffReportPath: relative(repoRoot, diffPath),
      diffReportSha256: sha256(diff),
    },
    acceptedBaselineChanges: [],
    referenceMutationGuard: {
      beforeSha256: 'a'.repeat(64),
      afterSha256: 'a'.repeat(64),
      changed: false,
    },
  };
  const evidencePath = join(runRoot, 'evidence.json');
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { repoRoot, clientRoot, runId, runRoot, evidence, evidencePath, strictPath };
}

test('validates an immutable read-only reference run against its current predecessor', async (t) => {
  const current = fixture(t);
  const loaded = await loadReferenceRun({ ...current, id: 'target' });
  assert.equal(loaded.manifestKey, 'target');
  assert.equal(loaded.remapCandidate, false);
  assert.equal(loaded.boundsChanged, false);
  assert.equal(loaded.evidence.source.export.sha256, sha256(readFileSync(loaded.referencePath)));
});

test('rejects a staged export whose bytes changed after acquisition', async (t) => {
  const current = fixture(t);
  writeFileSync(join(current.runRoot, 'reference.png'), pngBytes(2, 2, [200, 1, 1, 255]));
  await assert.rejects(
    loadReferenceRun({ ...current, id: 'target' }),
    /Reference export hash changed after acquisition/
  );
});

test('rejects a run after its canonical predecessor changes', async (t) => {
  const current = fixture(t);
  writeFileSync(current.canonicalPath, pngBytes(2, 2, [1, 200, 1, 255]));
  await assert.rejects(
    loadReferenceRun({ ...current, id: 'target' }),
    /Canonical reference changed after this acquisition run/
  );
});

test('rejects evidence paths that escape the immutable run root', async (t) => {
  const current = fixture(t);
  current.evidence.source.export.path = 'docs/design/figma/pages/target.png';
  writeFileSync(
    join(current.runRoot, 'evidence.json'),
    `${JSON.stringify(current.evidence, null, 2)}\n`
  );
  await assert.rejects(
    loadReferenceRun({ ...current, id: 'target' }),
    /Reference run artifact escapes its immutable run/
  );
});

test('rejects a run from an unpinned plugin build', async (t) => {
  const current = fixture(t);
  current.evidence.acquisition.plugin.build = 'untrusted-build';
  writeFileSync(
    join(current.runRoot, 'evidence.json'),
    `${JSON.stringify(current.evidence, null, 2)}\n`
  );
  await assert.rejects(
    loadReferenceRun({ ...current, id: 'target' }),
    /untrusted read-only plugin protocol\/build/
  );
});

test('rejects mixed before/after Figma snapshots', async (t) => {
  const current = fixture(t);
  current.evidence.source.stability.afterSha256 = 'f'.repeat(64);
  writeFileSync(
    join(current.runRoot, 'evidence.json'),
    `${JSON.stringify(current.evidence, null, 2)}\n`
  );
  await assert.rejects(
    loadReferenceRun({ ...current, id: 'target' }),
    /did not prove a stable node\/page snapshot/
  );
});

test('rejects acquisition when document change tracking is unavailable', async (t) => {
  const current = fixture(t);
  current.evidence.source.stability.changeTracking.supported = false;
  writeFileSync(
    join(current.runRoot, 'evidence.json'),
    `${JSON.stringify(current.evidence, null, 2)}\n`
  );
  await assert.rejects(
    loadReferenceRun({ ...current, id: 'target' }),
    /change tracking was unavailable/
  );
});

test('requires explicit review flags for remap and bounds candidates', async (t) => {
  const current = fixture(t);
  current.evidence.source.node.id = '9:9';
  current.evidence.source.node.name = 'Candidate';
  const candidateNodeJson = stableJson({
    id: '9:9',
    name: 'Candidate',
    type: 'FRAME',
    bounds: { x: 0, y: 0, width: 2, height: 2 },
  });
  writeFileSync(join(current.runRoot, 'node.json'), candidateNodeJson);
  current.evidence.source.node.sha256 = sha256(candidateNodeJson);
  current.evidence.source.export.bounds = { width: 3, height: 2 };
  const changed = pngBytes(3, 2);
  writeFileSync(join(current.runRoot, 'reference.png'), changed);
  current.evidence.source.export.sha256 = sha256(changed);
  writeFileSync(
    join(current.runRoot, 'evidence.json'),
    `${JSON.stringify(current.evidence, null, 2)}\n`
  );
  await assert.rejects(
    loadReferenceRun({ ...current, id: 'target' }),
    /explicit remap review is required/
  );
  const loaded = await loadReferenceRun({
    ...current,
    id: 'target',
    allowRemapCandidate: true,
    allowBoundsChange: true,
  });
  assert.equal(loaded.remapCandidate, true);
  assert.equal(loaded.boundsChanged, true);
});

test('requires an explicit review flag when the Figma source file changes', async (t) => {
  const current = fixture(t);
  current.evidence.source.file = { key: 'ReplacementFile456', name: 'Final copy' };
  writeFileSync(
    join(current.runRoot, 'evidence.json'),
    `${JSON.stringify(current.evidence, null, 2)}\n`
  );

  await assert.rejects(
    loadReferenceRun({ ...current, id: 'target' }),
    /explicit source remap review is required/
  );
  const loaded = await loadReferenceRun({
    ...current,
    id: 'target',
    allowSourceRemapCandidate: true,
  });
  assert.equal(loaded.sourceRemapCandidate, true);
  assert.equal(loaded.fileBindingCandidate, false);
});

test('rejects placeholder approvers while accepting a named reviewer', () => {
  assert.throws(() => validateReviewer('user-authorized'), /must name the human/);
  assert.throws(() => validateReviewer('product-design'), /must name the human/);
  assert.equal(validateReviewer('Emad'), 'Emad');
});

test('attributes automatic approval to the executing AI without a fixed vendor default', () => {
  assert.equal(resolveAutomaticApprover({ explicitName: 'Claude', env: {} }), 'Claude');
  assert.equal(resolveAutomaticApprover({ env: { FIGMA_AGENT_NAME: 'Cursor' } }), 'Cursor');
  assert.equal(resolveAutomaticApprover({ env: { CODEX_THREAD_ID: 'thread' } }), 'Codex');
  assert.equal(resolveAutomaticApprover({ env: {} }), 'AI agent');
  assert.throws(
    () => resolveAutomaticApprover({ explicitName: '../invalid', env: {} }),
    /must identify the AI agent/
  );
});

test('renderer evidence binds the browser, operating system, and capture configuration', () => {
  const renderer = rendererFingerprint();
  assert.match(renderer.playwright, /^\d+\.\d+\.\d+/);
  assert.equal(renderer.captureContract.browserName, 'chromium');
  assert.equal(renderer.captureContract.browserDistribution, 'playwright-managed-chromium');
  assert.equal(renderer.captureContract.colorProfile, 'srgb');
  assert.deepEqual(renderer.captureContract.launchArgs, ['--force-color-profile=srgb']);
  assert.equal(renderer.captureContract.locale, 'fa-IR');
  assert.equal(renderer.captureContract.timezoneId, 'UTC');
  assert.match(renderer.chromium.runtimeVersion, /^\d+\.\d+\.\d+\.\d+$/);
  assert.equal(renderer.chromium.runtimeVersion, renderer.chromium.manifestVersion);
  assert.match(renderer.chromium.distributionSha256, /^[a-f0-9]{64}$/);
  assert.match(renderer.chromium.executableSha256, /^[a-f0-9]{64}$/);
  assert.equal(renderer.chromium.executableRelativePath.startsWith('/'), false);
  assert.equal(JSON.stringify(renderer).includes('/Users/'), false);
  assert.match(renderer.playwrightConfigSha256, /^[a-f0-9]{64}$/);
  assert.match(renderer.viteConfigSha256, /^[a-f0-9]{64}$/);
  assert.match(renderer.dependencyLockSha256, /^[a-f0-9]{64}$/);
  assert.ok(renderer.osRelease);
});

test('seals the complete visual review surface into one run digest', (t) => {
  const current = visualFixture(t);
  const run = loadVisualEvidenceRun({
    runId: current.runId,
    id: 'target',
    mode: 'measure',
    repoRoot: current.repoRoot,
    clientRoot: current.clientRoot,
  });
  assert.match(run.reviewSha256, /^[a-f0-9]{64}$/);
  assert.equal(run.strictAudit.counts.rawDiffs, 1);
});

test('requires and seals the primary causal report for version 2 visual evidence', (t) => {
  const current = visualFixture(t);
  const diagnosisPath = join(current.runRoot, 'design-diagnosis.json');
  const diagnosisHtmlPath = join(current.runRoot, 'design-diagnosis.html');
  const diagnosis = '{"targets":[]}\n';
  const diagnosisHtml = '<!doctype html><title>Causal design diagnosis</title>\n';
  writeFileSync(diagnosisPath, diagnosis);
  writeFileSync(diagnosisHtmlPath, diagnosisHtml);
  current.evidence.schemaVersion = 2;
  current.evidence.review = {
    method: 'causal-design-diagnosis-v1',
    primaryArtifact: 'design-diagnosis.html',
    secondaryArtifact: 'diff/index.html',
  };
  current.evidence.inspections.designDiagnosisPath = relative(
    current.repoRoot,
    diagnosisPath
  );
  current.evidence.inspections.designDiagnosisSha256 = sha256(diagnosis);
  current.evidence.inspections.designDiagnosisHtmlPath = relative(
    current.repoRoot,
    diagnosisHtmlPath
  );
  current.evidence.inspections.designDiagnosisHtmlSha256 = sha256(diagnosisHtml);
  writeFileSync(current.evidencePath, `${JSON.stringify(current.evidence, null, 2)}\n`);

  const run = loadVisualEvidenceRun({
    runId: current.runId,
    id: 'target',
    mode: 'measure',
    repoRoot: current.repoRoot,
    clientRoot: current.clientRoot,
  });
  assert.equal(run.designDiagnosisHtmlPath, diagnosisHtmlPath);

  writeFileSync(diagnosisHtmlPath, `${diagnosisHtml}changed\n`);
  assert.throws(
    () =>
      loadVisualEvidenceRun({
        runId: current.runId,
        id: 'target',
        mode: 'measure',
        repoRoot: current.repoRoot,
        clientRoot: current.clientRoot,
      }),
    /Primary causal review report hash changed/
  );
});

test('rejects visual evidence without a matching post-capture runtime attestation', (t) => {
  const current = visualFixture(t);
  current.evidence.captureRuntime.postCapture.nonceSha256 = 'd'.repeat(64);
  writeFileSync(current.evidencePath, `${JSON.stringify(current.evidence, null, 2)}\n`);
  assert.throws(
    () =>
      loadVisualEvidenceRun({
        runId: current.runId,
        id: 'target',
        mode: 'measure',
        repoRoot: current.repoRoot,
        clientRoot: current.clientRoot,
      }),
    /re-attest the same runtime after capture/
  );
});

test('rejects visual evidence from a different or mutated browser runtime', (t) => {
  const current = visualFixture(t);
  current.evidence.rendererRuntime.runtimeVersion = '9.9.9.9';
  writeFileSync(current.evidencePath, `${JSON.stringify(current.evidence, null, 2)}\n`);
  assert.throws(
    () =>
      loadVisualEvidenceRun({
        runId: current.runId,
        id: 'target',
        mode: 'measure',
        repoRoot: current.repoRoot,
        clientRoot: current.clientRoot,
      }),
    /renderer contract/
  );
});

test('rejects a visual run whose strict audit changed after review', (t) => {
  const current = visualFixture(t);
  writeFileSync(current.strictPath, stableJson({ counts: { rawAboveBase: 1, rawDiffs: 1 } }));
  assert.throws(
    () =>
      loadVisualEvidenceRun({
        runId: current.runId,
        id: 'target',
        mode: 'measure',
        repoRoot: current.repoRoot,
        clientRoot: current.clientRoot,
      }),
    /Strict audit evidence hash changed/
  );
});
