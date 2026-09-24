#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  MANIFEST_PATH,
  REGISTRY_PATH,
  findRegistryItem,
  readJson,
  stableJson,
  validateRunId,
} from './lib/figma-reference-run.mjs';
import { visualProjectForTarget } from './lib/figma-visual-project.mjs';
import { exactPlaywrightSelection } from './lib/figma-playwright-selection.mjs';
import { loadFigmaStructure } from './lib/figma-structural-source.mjs';
import {
  runStructuralPlaywright,
  startStructuralCaptureRuntime,
} from './lib/figma-structural-capture.mjs';
import { compareStructuralEvidence } from './lib/figma-structural-compare.mjs';
import { renderStructuralInspectionHtml } from './lib/figma-structural-report.mjs';
import { componentCandidates } from './lib/design-diagnosis.mjs';

import { getFigmoonConfig } from '../lib/config.mjs';
const __figmoonConfig = getFigmoonConfig();
const clientRoot = __figmoonConfig.clientRoot;
const repoRoot = __figmoonConfig.consumerRoot;
const runsRoot = join(__figmoonConfig.inspectionResultsRoot ?? join(clientRoot, 'e2e', 'figma-inspection-results'), 'runs');
const graphPath = __figmoonConfig.dependencyGraphPath;

export function parseInspectArguments(argv) {
  const result = {
    id: null,
    runId: null,
    figmaSource: 'auto',
    referenceRun: null,
    json: false,
  };
  const values = new Map([
    ['--id', 'id'],
    ['--run-id', 'runId'],
    ['--figma-source', 'figmaSource'],
    ['--reference-run', 'referenceRun'],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      if (result.json) throw new Error('--json may be provided only once.');
      result.json = true;
      continue;
    }
    const equalsIndex = argument.indexOf('=');
    const flag = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
    const property = values.get(flag);
    if (!property) throw new Error(`Unsupported figma:inspect argument: ${argument}`);
    if (seen.has(flag)) throw new Error(`${flag} may be provided only once.`);
    seen.add(flag);
    const value = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    result[property] = value;
  }
  if (!result.id) throw new Error('figma:inspect requires exactly one --id <registry-id>.');
  if (!['auto', 'live', 'canonical'].includes(result.figmaSource)) {
    throw new Error('--figma-source must be auto, live, or canonical.');
  }
  if (result.referenceRun && result.figmaSource === 'live') {
    throw new Error('--reference-run cannot be combined with --figma-source live.');
  }
  return result;
}

function makeRunId(id) {
  return validateRunId(
    `inspect-${id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomBytes(3).toString('hex')}`
  );
}

function withoutVisionEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith('FIGMA_VISION_'))
  );
}

function discoverExactTest(item, project, environment) {
  const result = spawnSync(
    process.execPath,
    [
      join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test',
      item.visualTest.file.replace(/^client\//, ''),
      '--project',
      project,
      '--grep',
      `${item.visualTest.name.replace(/[.*+?^$\{()|[\]\\]/g, '\\$&')}$`,
      '--list',
      '--reporter=json',
    ],
    { cwd: clientRoot, env: environment, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`Playwright test discovery failed for ${item.id}: ${result.stderr.trim()}`);
  }
  return exactPlaywrightSelection({
    report: JSON.parse(result.stdout),
    testName: item.visualTest.name,
    testFile: item.visualTest.file,
    project,
  });
}

function assertInspectable(item, referenceRun) {
  if (!item.visualTest?.file || !item.visualTest?.name) {
    throw new Error(`Structural inspection requires a registered Playwright visual test for '${item.id}'.`);
  }
  if (!['partial', 'implemented'].includes(item.implementationStatus)) {
    throw new Error(`'${item.id}' has no inspectable production implementation.`);
  }
  if (!referenceRun && !['mapped', 'requires-remap'].includes(item.referenceStatus)) {
    throw new Error(`'${item.id}' has no mapped structural Figma source.`);
  }
}

export function itemForStructuralComparison(item, referenceRun) {
  if (!referenceRun) return item;
  return {
    ...item,
    referenceStatus: 'mapped',
    parityStatus: item.parityStatus === 'not-comparable' ? 'drifting' : item.parityStatus,
  };
}

function relatedProductDecisions(registry, item) {
  const implementationPaths = new Set(item.implementationPaths ?? []);
  return registry.items
    .filter(
      (candidate) =>
        candidate.id !== item.id &&
        candidate.designDecision?.status === 'open' &&
        (candidate.implementationPaths ?? []).some((path) => implementationPaths.has(path))
    )
    .map((candidate) => ({
      ...candidate.designDecision,
      registryId: candidate.id,
      sharedImplementationPaths: (candidate.implementationPaths ?? []).filter((path) =>
        implementationPaths.has(path)
      ),
    }));
}

function enrichSourceCandidates(comparison, graph, id) {
  const candidates = componentCandidates(id, graph);
  const byReactName = new Map(
    candidates.map((component) => [component.codeModule.split('/').at(-1).replace(/\.[^.]+$/, ''), component.codeModule])
  );
  for (const finding of comparison.findings) {
    if (!finding.browser) continue;
    finding.browser.sourceCandidates = [
      ...new Set([
        ...(finding.browser.sourceCandidates ?? []),
        ...(finding.browser.reactStack ?? []).flatMap((name) => (byReactName.has(name) ? [byReactName.get(name)] : [])),
      ]),
    ];
  }
  comparison.verificationTargets = [
    ...new Set(candidates.flatMap((component) => component.verificationTargets ?? [])),
  ].sort();
  comparison.componentCandidates = candidates;
}

export async function inspectTarget(parsed = parseInspectArguments(process.argv.slice(2))) {
  const registry = readJson(REGISTRY_PATH);
  const manifest = readJson(MANIFEST_PATH);
  const graph = readJson(graphPath);
  const item = findRegistryItem(registry, parsed.id);
  assertInspectable(item, parsed.referenceRun);
  const project = visualProjectForTarget(item);
  if (!project) throw new Error(`No Playwright project is registered for '${item.id}'.`);
  const runId = validateRunId(parsed.runId ?? makeRunId(item.id));
  const runRoot = join(runsRoot, runId);
  if (existsSync(runRoot)) throw new Error(`Structural inspection run already exists: ${runId}`);
  const browserRoot = join(runRoot, 'browser');
  const structuralRoot = join(runRoot, 'structure');
  const ownershipRoot = join(runRoot, 'design-ownership');
  mkdirSync(browserRoot, { recursive: true });
  mkdirSync(structuralRoot, { recursive: true });
  mkdirSync(ownershipRoot, { recursive: true });

  let figmaResult;
  let figmaError;
  const figmaPromise = loadFigmaStructure({
    id: item.id,
    registry,
    manifest,
    source: parsed.figmaSource,
    referenceRun: parsed.referenceRun,
  }).then(
    (value) => {
      figmaResult = value;
      return value;
    },
    (error) => {
      figmaError = error;
      return null;
    }
  );
  const runtime = await startStructuralCaptureRuntime({
    clientRoot,
    environment: withoutVisionEnvironment(),
  });
  let browser;
  let figma;
  let selection;
  try {
    const environment = {
      ...withoutVisionEnvironment(),
      PLAYWRIGHT_BASE_URL: runtime.baseUrl,
      PLAYWRIGHT_REUSE_SERVER: '1',
      FIGMA_STRUCTURAL_INSPECTION: '1',
      FIGMA_STRUCTURAL_INSPECTION_DIR: structuralRoot,
      FIGMA_DESIGN_DIAGNOSTICS_DIR: ownershipRoot,
    };
    selection = discoverExactTest(item, project, environment);
    await runStructuralPlaywright({
      repoRoot,
      clientRoot,
      item,
      project,
      runtime,
      outputRoot: browserRoot,
      structuralOutputRoot: structuralRoot,
      designOwnershipRoot: ownershipRoot,
      extraEnvironment: withoutVisionEnvironment(),
    });
    browser = readJson(join(structuralRoot, `${item.id}.browser-structure.json`));
    await figmaPromise;
    if (figmaError) throw figmaError;
    figma = figmaResult;
  } finally {
    await runtime.stop();
  }

  const productDecisions = relatedProductDecisions(registry, item);
  const comparison = compareStructuralEvidence({
    figma: figma.node,
    browser,
    item: itemForStructuralComparison(item, parsed.referenceRun),
    productDecisions,
  });
  comparison.relatedProductDecisions = productDecisions;
  enrichSourceCandidates(comparison, graph, item.id);
  const report = {
    schemaVersion: 2,
    kind: 'figma-structural-inspection',
    id: item.id,
    runId,
    createdAt: new Date().toISOString(),
    claim: 'Development diagnosis only. Structural inspection is not pixel parity, baseline approval, or canonical reference evidence.',
    target: {
      title: item.title,
      route: item.route,
      viewport: item.viewport,
      captureViewport: item.captureViewport ?? figma.entry.exportBounds,
      theme: item.theme,
      mockScenario: item.mockScenario,
      referenceStatus: item.referenceStatus,
      implementationStatus: item.implementationStatus,
      parityStatus: item.parityStatus,
      designDecision: item.designDecision ?? null,
      implementationPaths: item.implementationPaths ?? [],
      visualTest: item.visualTest,
    },
    figmaSource: {
      ...figma.source,
      path: figma.source.path ? relative(repoRoot, figma.source.path) : undefined,
      manifestKey: figma.manifestKey,
      nodeId: figma.node.id,
      nodeName: figma.node.name,
      nodeType: figma.node.type,
      bounds: figma.node.bounds,
    },
    browser: {
      url: browser.url,
      title: browser.title,
      viewport: browser.viewport,
      captureRect: browser.captureRect,
      structuralArtifact: relative(repoRoot, join(structuralRoot, `${item.id}.browser-structure.json`)),
      ownershipArtifact: relative(repoRoot, join(ownershipRoot, `${item.id}.design-ownership.json`)),
      captureRuntime: runtime.attestation,
      playwrightSelection: selection,
    },
    comparison,
  };
  const jsonPath = join(runRoot, 'structural-inspection.json');
  const htmlPath = join(runRoot, 'structural-inspection.html');
  writeFileSync(jsonPath, stableJson(report));
  writeFileSync(htmlPath, renderStructuralInspectionHtml(report));
  return { report, runRoot, jsonPath, htmlPath };
}

async function main() {
  const parsed = parseInspectArguments(process.argv.slice(2));
  const result = await inspectTarget(parsed);
  if (parsed.json) {
    console.log(JSON.stringify(result.report, null, 2));
    return;
  }
  const counts = result.report.comparison.summary.counts;
  console.log('\n── Structural Figma Inspection ─────────────────────────────────');
  console.log(`${result.report.id} · ${result.report.figmaSource.kind}`);
  console.log(
    `  ${result.report.comparison.summary.matchedPairs} matched · ${counts['visual-difference']} visual · ${counts['content-difference']} content · ${counts['product-authority-conflict']} authority conflict · ${counts.unresolved} unresolved`
  );
  const workflow = result.report.comparison.workflow;
  console.log(`  Workflow lane: ${workflow.workflowLane}`);
  console.log(`  Raster measurement: ${workflow.measurementAllowed ? 'allowed' : 'held until remediation'}`);
  console.log(`  Required action: ${workflow.requiredAction}`);
  if (workflow.terminalBlocker) {
    console.log(`  EXTERNAL DECISION BLOCKER: ${result.report.comparison.authority.reason ?? 'authority/mapping conflict'}`);
  }
  console.log(`Structural report: ${result.htmlPath}`);
  console.log(`Structural JSON: ${result.jsonPath}`);
  console.log(
    workflow.measurementAllowed
      ? 'Pixel evidence not run. Use figma:measure after an accepted bounded code change.'
      : 'Pixel evidence not run. Complete the required remediation and rerun figma:inspect.'
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
