import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const signoffScript = join(scriptDir, 'figma-signoff.mjs');
const baselineScript = join(scriptDir, 'visual-update-target.mjs');
const referencePromotionScript = join(scriptDir, 'figma-promote-reference.mjs');
const attestationScript = join(scriptDir, 'figma-attest.mjs');
const measurementPreflightModule = join(
  scriptDir,
  'lib',
  'figma-measurement-preflight.mjs'
);

function run(args, script = signoffScript) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: join(scriptDir, '..'),
    encoding: 'utf8',
  });
}

test('canonical signoff rejects a staged acquisition before creating evidence', () => {
  const result = run(['--id', 'comp-message-actions', '--reference-run', 'untrusted-staged-run']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /signoff never accepts a staged reference/);
});

test('Figma evidence CLI rejects unknown arguments instead of silently ignoring them', () => {
  const result = run(['--id', 'comp-message-actions', '--typo-mode']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported Figma evidence argument/);
});

test('Figma evidence CLI rejects duplicate target selectors', () => {
  const result = run(['--id', 'comp-message-actions', '--id=desktop-chat-empty']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--id may be provided only once/);
});

test('focused measurement presents raster confirmation before the secondary diff', () => {
  const source = readFileSync(signoffScript, 'utf8');
  const diagnosisRun = source.indexOf("join(scriptDir, 'design-diagnose.mjs')");
  const rasterConfirmation = source.indexOf(
    'Raster confirmation report (after structural inspection, or as fallback):'
  );
  const secondaryDiff = source.indexOf('Secondary pixel diff:');

  assert.notEqual(diagnosisRun, -1);
  assert.ok(rasterConfirmation > diagnosisRun);
  assert.equal(source.indexOf('Diagnosis gate (read before any mutation):'), -1);
  assert.ok(secondaryDiff > rasterConfirmation);
  assert.match(source, /role: 'pixel-and-edge-confirmation-after-structural-inspection'/);
});

test('measurement runs fresh structural preflight before allocating or running raster evidence', () => {
  const source = readFileSync(signoffScript, 'utf8');
  const structuralPreflight = source.indexOf('const structuralPreflight = await inspectTarget');
  const sourceBinding = source.indexOf(
    'structuralPreflight.report.browser.captureRuntime.sourceFingerprint'
  );
  const rasterRunAllocation = source.indexOf("const runRoot = join(clientRoot, 'e2e', 'figma-audit-results'");
  const freshVisualCapture = source.indexOf("'Fresh visual capture'");

  assert.notEqual(structuralPreflight, -1);
  assert.ok(sourceBinding > structuralPreflight);
  assert.ok(rasterRunAllocation > structuralPreflight);
  assert.ok(rasterRunAllocation > sourceBinding);
  assert.ok(freshVisualCapture > structuralPreflight);
  assert.match(source, /assertStructuralMeasurementAllowed/);
  assert.match(source, /figmaSource: 'canonical'/);
});

test('measurement preflight is fail-closed until content equality and opens afterward', async () => {
  const { assertStructuralMeasurementAllowed } = await import(measurementPreflightModule);
  assert.throws(
    () =>
      assertStructuralMeasurementAllowed({
        id: 'stale-inspection',
        comparison: { schemaVersion: 1 },
      }),
    /fresh schema-v2 structural inspection evidence/
  );
  const contentRemediation = {
    schemaVersion: 2,
    workflow: {
      workflowLane: 'content-remediation',
      measurementAllowed: false,
      terminalBlocker: false,
      requiredAction: 'Fix the production-valid fixture or component model.',
    },
  };
  assert.throws(
    () =>
      assertStructuralMeasurementAllowed({
        id: 'content-mismatch',
        comparison: contentRemediation,
        reportPath: 'structural-inspection.html',
      }),
    /Workflow lane: content-remediation.*Terminal blocker: no.*Required action/
  );

  const visualRemediation = {
    schemaVersion: 2,
    workflow: {
      workflowLane: 'visual-remediation',
      measurementAllowed: true,
      terminalBlocker: false,
      requiredAction: 'Measure the bounded visual change.',
    },
  };
  assert.equal(
    assertStructuralMeasurementAllowed({
      id: 'content-equal',
      comparison: visualRemediation,
    }),
    visualRemediation.workflow
  );
});

test('measurement can diagnose a stale accepted baseline without weakening signoff', () => {
  const source = readFileSync(signoffScript, 'utf8');

  assert.match(source, /\.\.\.\(measureOnly \? \['--allow-stale-baseline'\] : \[\]\)/);
  assert.match(source, /\.\.\.\(measureOnly \? \[\] : \['--require-signoff'\]\)/);
});

test('baseline promotion rejects unknown arguments before checking mutable state', () => {
  const result = run(
    [
      '--id',
      'comp-message-actions',
      '--measurement-run',
      'measure-contract-test',
      '--approved-by',
      'Emad',
      '--lease-owner',
      'contract-test',
      '--reason',
      'Reviewed contract test evidence',
      '--update-snapshots',
    ],
    baselineScript
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported visual:update-target argument/);
});

test('baseline promotion requires the exact reviewed run digest before lease checks', () => {
  const result = run(
    [
      '--id',
      'comp-message-actions',
      '--measurement-run',
      'measure-contract-test',
      '--approved-by',
      'Emad',
      '--lease-owner',
      'contract-test',
      '--reason',
      'Reviewed exact measurement evidence',
    ],
    baselineScript
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--expected-run-sha256/);
});

test('baseline promotion repeats its mutable-input guard immediately before publication', () => {
  const source = readFileSync(baselineScript, 'utf8');
  const finalGuard = source.lastIndexOf(
    'Registry or Figma reference changed immediately before baseline publication.'
  );
  const firstPublication = source.indexOf('atomicWriteFile(REGISTRY_PATH', finalGuard);

  assert.notEqual(finalGuard, -1);
  assert.notEqual(firstPublication, -1);
  assert.ok(finalGuard < firstPublication);
  assert.equal(source.slice(finalGuard, firstPublication).includes('await '), false);
});

test('reference promotion requires the exact reviewed run digest before lease checks', () => {
  const result = run(
    [
      '--id',
      'comp-message-actions',
      '--run-id',
      'reference-contract-test',
      '--lease-owner',
      'contract-test',
      '--reason',
      'Reviewed exact acquisition evidence',
    ],
    referencePromotionScript
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--expected-run-sha256/);
});

test('reference promotion resolves the executing agent when no human reviewer is supplied', () => {
  const source = readFileSync(referencePromotionScript, 'utf8');
  assert.match(source, /resolveAutomaticApprover\(\{ explicitName: parsed\['--agent-name'\] \}\)/);
});

test('parity attestation requires the exact reviewed run digest before lease checks', () => {
  const result = run(
    [
      '--id',
      'comp-message-actions',
      '--run-id',
      'signoff-contract-test',
      '--approved-by',
      'Emad',
      '--lease-owner',
      'contract-test',
      '--reason',
      'Reviewed exact signoff evidence',
    ],
    attestationScript
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--expected-run-sha256/);
});
