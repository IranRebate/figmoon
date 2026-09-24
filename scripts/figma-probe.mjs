#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  MANIFEST_PATH,
  REGISTRY_PATH,
  findRegistryItem,
  readJson,
  stableJson,
  validateRunId,
} from './lib/figma-reference-run.mjs';
import { loadFigmaStructure } from './lib/figma-structural-source.mjs';
import { startStructuralCaptureRuntime } from './lib/figma-structural-capture.mjs';
import { compareStructuralEvidence } from './lib/figma-structural-compare.mjs';
import { renderStructuralInspectionHtml } from './lib/figma-structural-report.mjs';
import { captureRuntimeEnvironment } from './lib/figma-capture-runtime.mjs';

import { getFigmoonConfig } from '../lib/config.mjs';
const __figmoonConfig = getFigmoonConfig();
const clientRoot = __figmoonConfig.clientRoot;
const repoRoot = __figmoonConfig.consumerRoot;
const inspectionRunsRoot = __figmoonConfig.inspectionResultsRoot
  ? join(__figmoonConfig.inspectionResultsRoot, 'runs')
  : join(clientRoot, 'e2e', 'figma-inspection-results', 'runs');
const probeRunsRoot = __figmoonConfig.probeResultsRoot
  ? join(__figmoonConfig.probeResultsRoot, 'runs')
  : join(clientRoot, 'e2e', 'figma-probe-results', 'runs');

export function parseProbeArguments(argv) {
  const result = { run: null, spec: null, runId: null, screenshot: false, json: false };
  const valueFlags = new Map([
    ['--run', 'run'],
    ['--spec', 'spec'],
    ['--run-id', 'runId'],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--screenshot' || argument === '--json') {
      const property = argument.slice(2);
      if (result[property]) throw new Error(`${argument} may be provided only once.`);
      result[property] = true;
      continue;
    }
    const equalsIndex = argument.indexOf('=');
    const flag = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
    const property = valueFlags.get(flag);
    if (!property) throw new Error(`Unsupported figma:probe argument: ${argument}`);
    if (seen.has(flag)) throw new Error(`${flag} may be provided only once.`);
    seen.add(flag);
    const value = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    result[property] = value;
  }
  if (!result.run || !result.spec) {
    throw new Error('figma:probe requires --run <inspection-run> and --spec <probe-json>.');
  }
  return result;
}

function resolveInside(value, root, label) {
  const candidates = [value, resolve(process.cwd(), value), resolve(clientRoot, value), resolve(repoRoot, value)];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`${label} does not exist: ${value}`);
  const relativePath = relative(root, path);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath.startsWith(sep)) {
    throw new Error(`${label} must resolve inside ${relative(repoRoot, root)}.`);
  }
  return path;
}

export function validateProbeSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Probe spec must be a JSON object.');
  }
  if (!Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > 12) {
    throw new Error('Probe spec requires 1 through 12 operations.');
  }
  const operations = value.operations.map((operation, index) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error(`Probe operation ${index + 1} must be an object.`);
    }
    if (typeof operation.selector !== 'string' || !operation.selector.trim() || operation.selector.length > 500) {
      throw new Error(`Probe operation ${index + 1} requires a bounded selector.`);
    }
    const styles = operation.styles ?? {};
    const attributes = operation.attributes ?? {};
    if (!styles || typeof styles !== 'object' || Array.isArray(styles) || Object.keys(styles).length > 20) {
      throw new Error(`Probe operation ${index + 1} has an invalid styles object.`);
    }
    if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes) || Object.keys(attributes).length > 10) {
      throw new Error(`Probe operation ${index + 1} has an invalid attributes object.`);
    }
    for (const [name, styleValue] of Object.entries(styles)) {
      if (!/^(?:--)?[a-z][a-z0-9-]*$/i.test(name) || typeof styleValue !== 'string' || styleValue.length > 500) {
        throw new Error(`Probe operation ${index + 1} contains an invalid style '${name}'.`);
      }
    }
    for (const [name, attributeValue] of Object.entries(attributes)) {
      if (!/^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/.test(name) || (attributeValue !== null && typeof attributeValue !== 'string')) {
        throw new Error(`Probe operation ${index + 1} contains an invalid attribute '${name}'.`);
      }
    }
    if (operation.text !== undefined && (typeof operation.text !== 'string' || operation.text.length > 1_000)) {
      throw new Error(`Probe operation ${index + 1} has invalid text.`);
    }
    return { selector: operation.selector, styles, attributes, ...(operation.text !== undefined ? { text: operation.text } : {}) };
  });
  return { label: typeof value.label === 'string' ? value.label.slice(0, 200) : null, operations };
}

function runIdFor(targetId) {
  return validateRunId(
    `probe-${targetId}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomBytes(3).toString('hex')}`
  );
}

function findingKey(finding, index) {
  return finding.figma?.key ?? finding.browser?.key ?? `finding:${index}`;
}

function comparableFinding(finding) {
  if (!finding) return null;
  const browserStyle = finding.browser?.style ?? finding.browser?.raw?.style ?? null;
  return {
    classification: finding.classification ?? null,
    browser: finding.browser
      ? {
          key: finding.browser.key ?? null,
          text: finding.browser.text ?? '',
          rect: finding.browser.rect ?? null,
          style: browserStyle,
        }
      : null,
    differences: propertyDifferences(finding),
  };
}

function propertyDifferences(finding) {
  return Object.fromEntries(
    ['content', 'geometry', 'visual'].flatMap((category) =>
      (finding?.differences?.[category] ?? []).map((difference) => [
        `${category}:${difference.property}`,
        { category, ...difference },
      ])
    )
  );
}

function browserStyleChanges(before, after) {
  const beforeStyle = before?.browser?.style ?? {};
  const afterStyle = after?.browser?.style ?? {};
  const changes = [];
  for (const property of new Set([...Object.keys(beforeStyle), ...Object.keys(afterStyle)])) {
    const baselineValue = beforeStyle[property] ?? null;
    const probeValue = afterStyle[property] ?? null;
    if (stableJson(baselineValue) === stableJson(probeValue)) continue;
    changes.push({
      property: `browser-style:${property}`,
      change: baselineValue !== null ? (probeValue !== null ? 'changed' : 'resolved') : 'introduced',
      baseline: baselineValue,
      probe: probeValue,
    });
  }
  return changes;
}

export function summarizeProbeDelta(baseline, comparison) {
  const baselineByKey = new Map(
    (baseline?.findings ?? []).map((finding, index) => [findingKey(finding, index), finding])
  );
  const comparisonByKey = new Map(
    (comparison?.findings ?? []).map((finding, index) => [findingKey(finding, index), finding])
  );
  const changedFindings = [];
  for (const key of new Set([...baselineByKey.keys(), ...comparisonByKey.keys()])) {
    const before = baselineByKey.get(key);
    const after = comparisonByKey.get(key);
    const beforeProperties = propertyDifferences(before);
    const afterProperties = propertyDifferences(after);
    const propertyChanges = browserStyleChanges(before, after);
    for (const property of new Set([
      ...Object.keys(beforeProperties),
      ...Object.keys(afterProperties),
    ])) {
      const baselineDifference = beforeProperties[property] ?? null;
      const probeDifference = afterProperties[property] ?? null;
      if (stableJson(baselineDifference) === stableJson(probeDifference)) continue;
      propertyChanges.push({
        property,
        change: baselineDifference ? (probeDifference ? 'changed' : 'resolved') : 'introduced',
        baseline: baselineDifference,
        probe: probeDifference,
      });
    }
    if (
      before?.classification === after?.classification &&
      propertyChanges.length === 0 &&
      Boolean(before) === Boolean(after)
    ) {
      continue;
    }
    changedFindings.push({
      key,
      label:
        after?.figma?.text ??
        before?.figma?.text ??
        after?.browser?.text ??
        before?.browser?.text ??
        after?.figma?.name ??
        before?.figma?.name ??
        key,
      baselineClassification: before?.classification ?? null,
      probeClassification: after?.classification ?? null,
      propertyChanges,
    });
  }
  const baselineComparable = Object.fromEntries(
    [...baselineByKey].map(([key, finding]) => [key, comparableFinding(finding)])
  );
  const probeComparable = Object.fromEntries(
    [...comparisonByKey].map(([key, finding]) => [key, comparableFinding(finding)])
  );
  return {
    baselineCounts: baseline?.summary?.counts ?? {},
    probeCounts: comparison?.summary?.counts ?? {},
    changedFindingCount: changedFindings.length,
    changedFindings,
    structuralCaptureChanged: stableJson(baselineComparable) !== stableJson(probeComparable),
  };
}

function runProbePlaywright({
  runtime,
  contract,
  runRoot,
  screenshotPath,
  baselineStructuralOutputRoot,
  baselineDesignOwnershipRoot,
  structuralOutputRoot,
  designOwnershipRoot,
}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
        'test',
        '--config',
        'playwright.structural-probe.config.ts',
      ],
      {
        cwd: clientRoot,
        env: {
          ...process.env,
          PLAYWRIGHT_BASE_URL: runtime.baseUrl,
          PLAYWRIGHT_REUSE_SERVER: '1',
          ...captureRuntimeEnvironment(runtime.identity),
          PLAYWRIGHT_VISUAL_OUTPUT_DIR: join(runRoot, 'playwright-results'),
          FIGMA_PROBE_CONTRACT: JSON.stringify(contract),
          FIGMA_PROBE_BASELINE_STRUCTURE_DIR: baselineStructuralOutputRoot,
          FIGMA_PROBE_BASELINE_OWNERSHIP_DIR: baselineDesignOwnershipRoot,
          FIGMA_PROBE_STRUCTURE_DIR: structuralOutputRoot,
          FIGMA_PROBE_OWNERSHIP_DIR: designOwnershipRoot,
          ...(screenshotPath ? { FIGMA_PROBE_SCREENSHOT_PATH: screenshotPath } : {}),
        },
        stdio: 'inherit',
      }
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`Structural probe failed${signal ? ` (${signal})` : ` (exit ${code})`}.`));
    });
  });
}

export async function runProbe(parsed = parseProbeArguments(process.argv.slice(2))) {
  const inspectionRun = resolveInside(parsed.run, inspectionRunsRoot, 'Inspection run');
  const inspectionPath = join(inspectionRun, 'structural-inspection.json');
  if (!existsSync(inspectionPath)) throw new Error(`Inspection run is missing structural-inspection.json: ${inspectionRun}`);
  const specPath = [
    resolve(process.cwd(), parsed.spec),
    resolve(clientRoot, parsed.spec),
    resolve(repoRoot, parsed.spec),
  ].find((candidate) => existsSync(candidate));
  if (!specPath) throw new Error(`Probe spec does not exist: ${parsed.spec}`);
  const inspection = readJson(inspectionPath);
  if (inspection.kind !== 'figma-structural-inspection') throw new Error('Probe input is not a structural inspection run.');
  const spec = validateProbeSpec(JSON.parse(readFileSync(specPath, 'utf8')));
  const registry = readJson(REGISTRY_PATH);
  const manifest = readJson(MANIFEST_PATH);
  const item = findRegistryItem(registry, inspection.id);
  const runId = validateRunId(parsed.runId ?? runIdFor(item.id));
  const runRoot = join(probeRunsRoot, runId);
  if (existsSync(runRoot)) throw new Error(`Structural probe run already exists: ${runId}`);
  mkdirSync(runRoot, { recursive: true });
  const screenshotPath = parsed.screenshot ? join(runRoot, 'probe.png') : null;
  const baselineStructuralOutputRoot = join(runRoot, 'baseline-structure');
  const baselineDesignOwnershipRoot = join(runRoot, 'baseline-design-ownership');
  const structuralOutputRoot = join(runRoot, 'structure');
  const designOwnershipRoot = join(runRoot, 'design-ownership');
  for (const outputRoot of [
    baselineStructuralOutputRoot,
    baselineDesignOwnershipRoot,
    structuralOutputRoot,
    designOwnershipRoot,
  ]) {
    mkdirSync(outputRoot, { recursive: true });
  }
  const viewport = item.captureViewport ?? inspection.target.captureViewport;
  const contract = {
    id: item.id,
    route: item.route,
    scenario: item.mockScenario ?? inspection.target.mockScenario,
    viewport,
    operations: spec.operations,
  };
  const runtime = await startStructuralCaptureRuntime({ clientRoot });
  try {
    await runProbePlaywright({
      runtime,
      contract,
      runRoot,
      screenshotPath,
      baselineStructuralOutputRoot,
      baselineDesignOwnershipRoot,
      structuralOutputRoot,
      designOwnershipRoot,
    });
  } finally {
    await runtime.stop();
  }

  const figma = await loadFigmaStructure({
    id: item.id,
    registry,
    manifest,
    source: inspection.figmaSource.kind === 'live-connect' ? 'auto' : 'canonical',
  });
  const baselineBrowserStructurePath = join(
    baselineStructuralOutputRoot,
    `${item.id}.browser-structure.json`
  );
  const browserStructurePath = join(structuralOutputRoot, `${item.id}.browser-structure.json`);
  for (const evidencePath of [baselineBrowserStructurePath, browserStructurePath]) {
    if (!existsSync(evidencePath)) {
      throw new Error(`Structural probe did not emit browser evidence: ${evidencePath}`);
    }
  }
  const baselineBrowser = readJson(baselineBrowserStructurePath);
  const probedBrowser = readJson(browserStructurePath);
  const baselineComparison = compareStructuralEvidence({
    figma: figma.node,
    browser: baselineBrowser,
    item,
    productDecisions: inspection.comparison.relatedProductDecisions ?? [],
  });
  const comparison = compareStructuralEvidence({
    figma: figma.node,
    browser: probedBrowser,
    item,
    productDecisions: inspection.comparison.relatedProductDecisions ?? [],
  });
  comparison.componentCandidates = inspection.comparison.componentCandidates ?? [];
  comparison.verificationTargets = inspection.comparison.verificationTargets ?? [];
  comparison.relatedProductDecisions = inspection.comparison.relatedProductDecisions ?? [];
  const report = {
    schemaVersion: 1,
    kind: 'figma-structural-probe',
    id: item.id,
    runId,
    createdAt: new Date().toISOString(),
    claim: 'Temporary browser-only diagnostic. This probe is never an acceptable product fix or parity artifact.',
    inputInspection: relative(repoRoot, inspectionPath),
    label: spec.label,
    operations: spec.operations,
    target: inspection.target,
    figmaSource: figma.source,
    browser: {
      url: probedBrowser.url,
      screenshot: screenshotPath ? relative(repoRoot, screenshotPath) : null,
      baselineStructuralArtifact: relative(repoRoot, baselineBrowserStructurePath),
      structuralArtifact: relative(repoRoot, browserStructurePath),
      ownershipArtifact: relative(
        repoRoot,
        join(designOwnershipRoot, `${item.id}.design-ownership.json`)
      ),
      captureRuntime: runtime.attestation,
    },
    baseline: baselineComparison,
    comparison,
    beforeAfter: summarizeProbeDelta(baselineComparison, comparison),
    inputInspectionBaseline: inspection.comparison,
  };
  const jsonPath = join(runRoot, 'structural-probe.json');
  writeFileSync(jsonPath, stableJson(report));
  const htmlReport = {
    ...inspection,
    runId,
    comparison,
    browser: report.browser,
    claim: report.claim,
  };
  const htmlPath = join(runRoot, 'structural-probe.html');
  writeFileSync(
    htmlPath,
    renderStructuralInspectionHtml(htmlReport).replace(
      '</main>',
      `<div class="blocker"><b>Temporary probe only:</b> ${spec.operations.length} browser override(s) changed ${report.beforeAfter.changedFindingCount} structural finding(s). Inspect ${screenshotPath ? 'probe.png and ' : ''}the before/after JSON; no source, fixture, baseline, registry, manifest, or Figma node was changed.</div></main>`
    )
  );
  return { report, runRoot, jsonPath, htmlPath };
}

async function main() {
  const parsed = parseProbeArguments(process.argv.slice(2));
  const result = await runProbe(parsed);
  if (parsed.json) console.log(JSON.stringify(result.report, null, 2));
  else {
    console.log(`Probe report: ${result.htmlPath}`);
    console.log(`Probe JSON: ${result.jsonPath}`);
    console.log('Diagnostic only; implement no probe override directly in production code.');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
