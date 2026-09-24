#!/usr/bin/env node
/**
 * Fast Figma pixel-governance check.
 *
 * This started as a reference-path existence check. It now validates the registry
 * and reference manifest contracts that keep Figma parity work honest:
 * schema presence, stable IDs, reference provenance and authority, dimensions,
 * thresholds, waivers/signoff metadata, crop bounds, and Visual QA scenario
 * coverage.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import sharp from 'sharp';
import {
  DURABLE_EVIDENCE_ROOT,
  REFERENCE_ARTIFACTS_ROOT,
  digestNamedFiles,
  loadReferenceRun,
  resolveManifestArtifact,
} from './lib/figma-reference-run.mjs';
import { resolveDurablePointer } from './lib/figma-promotion.mjs';
import {
  baselinePromotionReceiptIssues,
  parityAttestationReceiptIssues,
  referencePromotionReceiptIssues,
} from './lib/figma-receipt-contract.mjs';
import { targetSourceState } from './lib/figma-target-closure.mjs';
import { loadVisualScenarioMetadata } from './lib/visual-scenario-contract.mjs';
import { resolveCanonicalSnapshotPath } from './lib/figma-snapshot-contract.mjs';

import { getFigmoonConfig } from '../lib/config.mjs';
const __figmoonConfig = getFigmoonConfig();
const REPO_ROOT = __figmoonConfig.consumerRoot;
const CLIENT_ROOT = __figmoonConfig.clientRoot;
const REGISTRY_PATH = __figmoonConfig.registryPath;
const REGISTRY_SCHEMA_PATH = __figmoonConfig.registrySchemaPath;
const MANIFEST_PATH = __figmoonConfig.manifestPath;
const MANIFEST_SCHEMA_PATH = __figmoonConfig.manifestSchemaPath;
const COMPONENT_INVENTORY_PATH = __figmoonConfig.componentInventoryPath;
const FIGMA_ROOT = __figmoonConfig.figmaRoot;
const SNAPSHOT_ROOT = __figmoonConfig.snapshotRoot;
const VISUAL_SCENARIOS_PATH = __figmoonConfig.visualScenariosPath;
const DEPENDENCY_GRAPH_PATH = __figmoonConfig.dependencyGraphPath;
const SCREEN_REGISTRY_PATH = __figmoonConfig.screenRegistryPath;

const VALID_STATUSES = new Set([
  'unmapped',
  'mapped',
  'in_progress',
  'figma_parity',
  'regression_locked',
  'waived',
]);
const VALID_REFERENCE_STATUSES = new Set(['missing', 'mapped', 'requires-remap', 'waived']);
const VALID_IMPLEMENTATION_STATUSES = new Set([
  'missing',
  'partial',
  'implemented',
  'not-applicable',
]);
const VALID_PARITY_STATUSES = new Set([
  'not-comparable',
  'drifting',
  'in-progress',
  'parity',
  'locked',
  'waived',
]);
const VALID_KINDS = new Set(['page', 'component', 'overlay', 'foundation']);
const VALID_VIEWPORTS = new Set(['desktop', 'mobile', 'tablet-landscape', 'tablet-portrait']);
const VALID_THEMES = new Set(['light', 'dark', 'system']);
const DEFAULT_FIGMA_FRESHNESS_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONTRADICTION_RE =
  /\b(Partial|Missing|not yet|needs calibration|missing|not implemented|does not exist|not built|not identical)\b/i;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadDurableReceipt(pointer, label, id, issues) {
  try {
    const path = resolveDurablePointer(pointer, {
      root: DURABLE_EVIDENCE_ROOT,
      extensions: ['json'],
      label,
    });
    return readJson(path);
  } catch (error) {
    addIssue(issues, id, error instanceof Error ? error.message : String(error));
    return null;
  }
}

function validateReceiptArtifacts(receipt, id, issues) {
  const resolved = {};
  for (const [name, pointer] of Object.entries(receipt?.artifacts ?? {})) {
    try {
      resolved[name] = resolveDurablePointer(pointer, {
        root: name === 'reference' ? REFERENCE_ARTIFACTS_ROOT : DURABLE_EVIDENCE_ROOT,
        extensions: name === 'reference' ? ['png'] : ['json', 'png', 'html'],
        label: `Durable ${name} evidence`,
      });
    } catch (error) {
      addIssue(issues, id, error instanceof Error ? error.message : String(error));
    }
  }

  const bundleByKind = {
    'figma-reference-promotion': [
      ['acquisitionEvidence', 'evidence.json'],
      ['node', 'node.json'],
      ['reference', 'reference.png'],
      ['variables', 'variables.json'],
      ...(receipt?.artifacts?.comparisonDiff
        ? [['comparisonDiff', 'candidate-vs-canonical.png']]
        : []),
    ],
    'figma-baseline-promotion': [
      ['capture', 'capture.png'],
      ['designDiagnosis', 'design-diagnosis.json'],
      ['designDiagnosisHtml', 'design-diagnosis.html'],
      ['diffReport', 'diff-report.html'],
      ['evidence', 'evidence.json'],
      ['strictAudit', 'strict-audit.json'],
    ],
    'figma-parity-attestation': [
      ['capture', 'capture.png'],
      ['designDiagnosis', 'design-diagnosis.json'],
      ['designDiagnosisHtml', 'design-diagnosis.html'],
      ['diffReport', 'diff-report.html'],
      ['evidence', 'evidence.json'],
      ['strictAudit', 'strict-audit.json'],
    ],
  };
  const bundle = bundleByKind[receipt?.kind];
  if (!bundle) {
    addIssue(issues, id, `Unsupported durable receipt kind '${receipt?.kind ?? 'missing'}'.`);
    return resolved;
  }
  const allowedKeys = new Set(bundle.map(([key]) => key));
  const actualKeys = Object.keys(receipt?.artifacts ?? {});
  if (
    actualKeys.length !== allowedKeys.size ||
    actualKeys.some((key) => !allowedKeys.has(key)) ||
    bundle.some(([key]) => !resolved[key])
  ) {
    addIssue(
      issues,
      id,
      'Durable receipt artifact bundle is incomplete or contains unsupported entries.'
    );
    return resolved;
  }
  try {
    const reviewSha256 = digestNamedFiles(
      bundle.map(([key, name]) => ({ name, path: resolved[key] }))
    );
    if (reviewSha256 !== receipt.reviewSha256) {
      addIssue(issues, id, 'Durable receipt artifacts do not reproduce the reviewed run digest.');
    }
  } catch (error) {
    addIssue(issues, id, error instanceof Error ? error.message : String(error));
  }
  return resolved;
}

function readReceiptArtifactJson(path, label, id, issues) {
  if (!path) return null;
  try {
    return readJson(path);
  } catch (error) {
    addIssue(
      issues,
      id,
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function validateTargetSourceBinding({
  record,
  receipt,
  receiptArtifacts,
  currentState,
  id,
  label,
  issues,
  warnings,
  allowCurrentMismatch = false,
}) {
  const recordedFingerprint = record?.targetSourceFingerprint;
  if (receipt?.contract?.targetSourceFingerprint !== recordedFingerprint) {
    addIssue(issues, id, `${label} receipt contradicts its target source/input fingerprint.`);
  }
  if (currentState && currentState.fingerprint !== recordedFingerprint) {
    const message = `${label} is stale because this target's implementation or shared visual inputs changed.`;
    if (allowCurrentMismatch) {
      warnings.push({
        id,
        message:
          message +
          ' Diagnostic measurement is allowed; refresh the accepted baseline before regression or signoff.',
      });
    } else {
      addIssue(issues, id, message);
    }
  }
  if (!receiptArtifacts?.evidence) return;
  try {
    const evidence = readJson(receiptArtifacts.evidence);
    if (
      evidence.targetSourceState?.fingerprint !== recordedFingerprint ||
      evidence.targetSourceMutationGuard?.changed !== false ||
      evidence.targetSourceMutationGuard?.beforeFingerprint !== recordedFingerprint ||
      evidence.targetSourceMutationGuard?.afterFingerprint !== recordedFingerprint
    ) {
      addIssue(
        issues,
        id,
        `${label} evidence does not bind the reviewed target source/input state.`
      );
    }
  } catch (error) {
    addIssue(issues, id, error instanceof Error ? error.message : String(error));
  }
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir || !existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) throw new Error(`Snapshot discovery must not traverse ${full}.`);
      if (info.isDirectory()) stack.push(full);
      else if (info.isFile()) out.push(full);
    }
  }
  return out;
}

function repoRel(absPath) {
  return relative(REPO_ROOT, absPath);
}

function addIssue(list, id, message, level = 'error') {
  list.push({ id, message, level });
}

function pathIsInside(child, parent) {
  const rel = relative(parent, child);
  return rel && !rel.startsWith('..') && !rel.startsWith('/');
}

function allowedBase(item, registry) {
  if (item.kind === 'component') return registry._meta.thresholds.figmaParityComponent;
  return registry._meta.thresholds.figmaParityPage;
}

function parseArgs(argv) {
  const args = {
    freshnessOnly: false,
    ids: [],
    idErrors: [],
    argumentErrors: [],
    today: null,
    requireSignoff: false,
    requireBaselineUpdate: false,
    allowStaleBaseline: false,
    referenceRun: null,
    unsupported: [],
  };

  const addId = (value) => {
    if (!value || value.startsWith('--')) {
      args.idErrors.push('Missing value for --id.');
      return false;
    }
    args.ids.push(value);
    return true;
  };

  const seenSingletons = new Set();
  const singleton = (flag, value) => {
    if (seenSingletons.has(flag)) {
      args.argumentErrors.push(`${flag} may be provided only once.`);
      return false;
    }
    seenSingletons.add(flag);
    if (!value || value.startsWith('--')) {
      args.argumentErrors.push(`Missing value for ${flag}.`);
      return false;
    }
    return true;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--freshness-only') {
      if (args.freshnessOnly)
        args.argumentErrors.push('--freshness-only may be provided only once.');
      args.freshnessOnly = true;
    } else if (arg === '--require-signoff') {
      if (args.requireSignoff)
        args.argumentErrors.push('--require-signoff may be provided only once.');
      args.requireSignoff = true;
    } else if (arg === '--require-baseline-update') {
      if (args.requireBaselineUpdate)
        args.argumentErrors.push('--require-baseline-update may be provided only once.');
      args.requireBaselineUpdate = true;
    } else if (arg === '--allow-stale-baseline') {
      if (args.allowStaleBaseline)
        args.argumentErrors.push('--allow-stale-baseline may be provided only once.');
      args.allowStaleBaseline = true;
    } else if (arg === '--reference-run') {
      const value = argv[i + 1];
      if (singleton('--reference-run', value)) {
        args.referenceRun = value;
        i++;
      }
    } else if (arg.startsWith('--reference-run=')) {
      const value = arg.slice('--reference-run='.length);
      if (singleton('--reference-run', value)) args.referenceRun = value;
    } else if (arg === '--id') {
      if (addId(argv[i + 1])) i++;
    } else if (arg.startsWith('--id=')) addId(arg.slice('--id='.length));
    else if (arg === '--today') {
      const value = argv[i + 1];
      if (singleton('--today', value)) {
        args.today = value;
        i++;
      }
    } else if (arg.startsWith('--today=')) {
      const value = arg.slice('--today='.length);
      if (singleton('--today', value)) args.today = value;
    } else args.unsupported.push(arg);
  }
  return args;
}

function hasExactPlaywrightTest(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\btest\\s*\\(\\s*[\'\\"]' + escaped + '[\'\\"]').test(source);
}

function todayIso(override) {
  if (override) return override;
  return new Date().toISOString().slice(0, 10);
}

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function daysSince(value, nowDate) {
  const date = parseIsoDate(value);
  if (!date) return null;
  return Math.floor((nowDate.getTime() - date.getTime()) / DAY_MS);
}

function findSnapshot(item) {
  if (item.snapshot) {
    const declared = resolveCanonicalSnapshotPath({
      item,
      snapshotRoot: SNAPSHOT_ROOT,
      mustExist: false,
    });
    return existsSync(declared)
      ? resolveCanonicalSnapshotPath({ item, snapshotRoot: SNAPSHOT_ROOT })
      : null;
  }

  const hints = {
    desktop: 'desktop/visual/pages.spec.ts',
    mobile: 'mobile/visual/mobile.spec.ts',
    'tablet-landscape': 'tablet-landscape/visual/tablet.spec.ts',
    'tablet-portrait': 'tablet-portrait/visual/tablet.spec.ts',
  };
  const hint =
    item.kind === 'component' ? 'desktop/visual/components.spec.ts' : hints[item.viewport];
  if (!hint) return null;
  const candidate = join(SNAPSHOT_ROOT, hint, `${item.id}.png`);
  if (existsSync(candidate)) return candidate;
  return walkFiles(SNAPSHOT_ROOT).find((file) => file.endsWith(`/${item.id}.png`)) ?? null;
}

function canCreateInitialBaseline(item, args, comparableProductState, snapshot) {
  return (
    args.requireBaselineUpdate &&
    comparableProductState &&
    Boolean(item.snapshot && item.visualTest?.file && item.visualTest?.name) &&
    item.status === 'in_progress' &&
    item.parityStatus === 'in-progress' &&
    item.designDecision?.status === 'accepted' &&
    !item.baselineUpdate &&
    !snapshot
  );
}

function loadScenarioMetadata() {
  return loadVisualScenarioMetadata(VISUAL_SCENARIOS_PATH);
}

function validateJsonSchema(schemaPath, data, label, issues) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(readJson(schemaPath));
  if (validate(data)) return;
  for (const error of validate.errors ?? []) {
    addIssue(
      issues,
      label,
      `Schema violation at ${error.instancePath || '/'}: ${error.message ?? 'invalid value'}.`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const requestedIds = [...new Set(args.ids)];
  const requestedIdSet = new Set(requestedIds);
  const hasIdFilter = requestedIds.length > 0 || args.idErrors.length > 0;
  const issues = [];
  const warnings = [];
  const today = todayIso(args.today);
  const parsedTodayDate = parseIsoDate(today);
  const todayDate = parsedTodayDate ?? new Date('1970-01-01T00:00:00.000Z');
  if (!parsedTodayDate)
    addIssue(issues, '--today', `Invalid --today date '${today}'. Use YYYY-MM-DD.`);

  for (const required of [
    REGISTRY_PATH,
    REGISTRY_SCHEMA_PATH,
    MANIFEST_PATH,
    MANIFEST_SCHEMA_PATH,
    COMPONENT_INVENTORY_PATH,
    DEPENDENCY_GRAPH_PATH,
    SCREEN_REGISTRY_PATH,
  ]) {
    if (!existsSync(required))
      addIssue(issues, repoRel(required), 'Required governance file is missing.');
  }
  if (issues.length)
    return report({
      issues,
      warnings,
      resolved: 0,
      noReference: 0,
      freshnessOnly: args.freshnessOnly,
    });

  for (const message of args.idErrors) addIssue(issues, '--id', message);
  for (const message of args.argumentErrors) addIssue(issues, 'arguments', message);
  for (const unsupported of args.unsupported)
    addIssue(issues, unsupported, `Unsupported check:figma argument '${unsupported}'.`);

  if (
    args.allowStaleBaseline &&
    (requestedIds.length !== 1 ||
      args.freshnessOnly ||
      args.requireSignoff ||
      args.requireBaselineUpdate)
  ) {
    addIssue(
      issues,
      '--allow-stale-baseline',
      '--allow-stale-baseline is diagnostic-only for one ordinary target check; it cannot be used for freshness, baseline promotion, or signoff.'
    );
  }

  const registry = readJson(REGISTRY_PATH);
  const manifest = readJson(MANIFEST_PATH);
  const dependencyGraph = readJson(DEPENDENCY_GRAPH_PATH);
  const screenRegistry = readJson(SCREEN_REGISTRY_PATH);
  let stagedReference = null;
  if (args.referenceRun) {
    if (
      requestedIds.length !== 1 ||
      args.freshnessOnly ||
      args.requireSignoff ||
      args.requireBaselineUpdate
    ) {
      addIssue(
        issues,
        '--reference-run',
        '--reference-run is diagnostic evidence for exactly one ordinary target check; it cannot be used for freshness, baseline promotion, or signoff.'
      );
    } else {
      try {
        stagedReference = await loadReferenceRun({
          runId: args.referenceRun,
          id: requestedIds[0],
          registry,
          manifest,
          allowRemapCandidate: true,
          allowNodeNameChangeCandidate: true,
          allowSourceRemapCandidate: true,
        });
      } catch (error) {
        addIssue(issues, '--reference-run', error instanceof Error ? error.message : String(error));
      }
    }
  }
  const componentInventory = readJson(COMPONENT_INVENTORY_PATH);
  const componentInventoryById = new Map(
    (componentInventory.components ?? [])
      .filter((component) => component?.id)
      .map((component) => [component.id, component])
  );
  const componentInventoryByNodeId = new Map(
    (componentInventory.components ?? [])
      .filter((component) => component?.figma?.nodeId)
      .map((component) => [component.figma.nodeId, component])
  );
  validateJsonSchema(REGISTRY_SCHEMA_PATH, registry, 'pixel-perfect-registry.json', issues);
  validateJsonSchema(MANIFEST_SCHEMA_PATH, manifest, 'reference-manifest.json', issues);
  const scenarioMetadata = loadScenarioMetadata();
  const defaultFreshnessDays =
    manifest.figmaFile?.freshnessPolicy?.maxAgeDays ?? DEFAULT_FIGMA_FRESHNESS_DAYS;
  const manifestEntries = Object.values(manifest.items ?? {});
  const manifestByReference = new Map();
  for (const [manifestId, entry] of Object.entries(manifest.items ?? {})) {
    const prior = manifestByReference.get(entry.referencePath);
    if (prior) {
      addIssue(
        issues,
        entry.referencePath,
        `Reference path is declared by multiple manifest entries: '${prior.id}' and '${manifestId}'. Shared references must use one manifest entry with multiple registryIds.`
      );
      continue;
    }
    manifestByReference.set(entry.referencePath, { id: manifestId, entry });
  }
  const manifestRegistryOwners = new Map();
  for (const [manifestId, entry] of Object.entries(manifest.items ?? {})) {
    for (const registryId of entry.registryIds ?? []) {
      const prior = manifestRegistryOwners.get(registryId);
      if (prior && prior !== manifestId) {
        addIssue(
          issues,
          registryId,
          `Registry id is owned by multiple manifest entries: '${prior}' and '${manifestId}'.`
        );
      } else {
        manifestRegistryOwners.set(registryId, manifestId);
      }
    }
  }
  const ids = new Set();
  const references = new Map();
  let resolved = 0;
  let noReference = 0;
  let lifecycleExempt = 0;

  const metaStatuses = new Set(registry._meta?.statusValues ?? []);
  for (const status of VALID_STATUSES) {
    if (!metaStatuses.has(status))
      addIssue(issues, '_meta.statusValues', `Missing status '${status}'.`);
  }
  const axes = registry._meta?.statusAxes ?? {};
  for (const status of VALID_REFERENCE_STATUSES) {
    if (!(axes.referenceStatusValues ?? []).includes(status)) {
      addIssue(issues, '_meta.statusAxes.referenceStatusValues', `Missing status '${status}'.`);
    }
  }
  for (const status of VALID_IMPLEMENTATION_STATUSES) {
    if (!(axes.implementationStatusValues ?? []).includes(status)) {
      addIssue(
        issues,
        '_meta.statusAxes.implementationStatusValues',
        `Missing status '${status}'.`
      );
    }
  }
  for (const status of VALID_PARITY_STATUSES) {
    if (!(axes.parityStatusValues ?? []).includes(status)) {
      addIssue(issues, '_meta.statusAxes.parityStatusValues', `Missing status '${status}'.`);
    }
  }

  const registryItems = registry.items ?? [];
  const itemsToValidate = hasIdFilter
    ? registryItems.filter((item) => requestedIdSet.has(item.id))
    : registryItems;
  const resolvedRegistryIds = new Set(itemsToValidate.map((item) => item.id));
  for (const id of requestedIds) {
    if (!resolvedRegistryIds.has(id)) addIssue(issues, '--id', `Unknown registry id '${id}'.`);
  }

  for (const item of itemsToValidate) {
    const id = item.id ?? '<missing-id>';
    if (ids.has(id)) addIssue(issues, id, 'Duplicate registry id.');
    ids.add(id);

    if (!VALID_STATUSES.has(item.status)) addIssue(issues, id, `Unknown status '${item.status}'.`);
    if (!VALID_REFERENCE_STATUSES.has(item.referenceStatus)) {
      addIssue(issues, id, `Unknown referenceStatus '${item.referenceStatus}'.`);
    }
    if (!VALID_IMPLEMENTATION_STATUSES.has(item.implementationStatus)) {
      addIssue(issues, id, `Unknown implementationStatus '${item.implementationStatus}'.`);
    }
    if (!VALID_PARITY_STATUSES.has(item.parityStatus)) {
      addIssue(issues, id, `Unknown parityStatus '${item.parityStatus}'.`);
    }
    if (!VALID_KINDS.has(item.kind)) addIssue(issues, id, `Unknown kind '${item.kind}'.`);
    if (item.viewport && !VALID_VIEWPORTS.has(item.viewport))
      addIssue(issues, id, `Unknown viewport '${item.viewport}'.`);
    if (item.theme && !VALID_THEMES.has(item.theme))
      addIssue(issues, id, `Unknown theme '${item.theme}'.`);
    const designDecision = item.designDecision;
    if (!designDecision?.status || !designDecision.owner || !designDecision.reason) {
      addIssue(issues, id, 'Missing structured designDecision metadata.');
    } else if (designDecision.status === 'open') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(designDecision.reviewBy ?? '')) {
        warnings.push({
          id,
          message:
            'Open designDecision has no YYYY-MM-DD reviewBy date. It remains non-certifiable until resolved.',
        });
      } else {
        warnings.push({
          id,
          message: `Open designDecision remains non-certifiable until resolved (review by ${designDecision.reviewBy}).`,
        });
      }
      if (args.requireSignoff || args.requireBaselineUpdate) {
        addIssue(
          issues,
          id,
          `Open design decision blocks ${args.requireSignoff ? 'signoff' : 'baseline update'}.`
        );
      }
    }
    if ((args.requireSignoff || args.requireBaselineUpdate) && !item.visualTest) {
      addIssue(issues, id, 'Target-specific baseline/signoff requires a registry visualTest.');
    }
    const comparableProductState =
      item.referenceStatus === 'mapped' &&
      ['partial', 'implemented'].includes(item.implementationStatus);
    const declaredSnapshot = comparableProductState ? findSnapshot(item) : null;
    const initialBaselineCapture = canCreateInitialBaseline(
      item,
      args,
      comparableProductState,
      declaredSnapshot
    );
    if (comparableProductState && !item.visualTest) {
      addIssue(
        issues,
        id,
        'Mapped partial/implemented product state requires an exact registry visualTest.'
      );
    }
    if (comparableProductState && !item.snapshot) {
      addIssue(
        issues,
        id,
        'Mapped partial/implemented product state requires an explicit baseline snapshot path.'
      );
    } else if (comparableProductState && !declaredSnapshot) {
      const message = `Declared baseline snapshot does not exist: ${item.snapshot}`;
      if (initialBaselineCapture) {
        warnings.push({
          id,
          message:
            message + ' An initial target-only baseline will be created by the approved update.',
        });
      } else {
        addIssue(issues, id, message);
      }
    }

    for (const implementationPath of item.implementationPaths ?? []) {
      const implementationAbs = resolve(REPO_ROOT, implementationPath);
      if (!pathIsInside(implementationAbs, REPO_ROOT)) {
        addIssue(issues, id, `implementationPath escapes the repository: ${implementationPath}`);
      } else if (!existsSync(implementationAbs)) {
        addIssue(issues, id, `implementationPath does not exist: ${implementationPath}`);
      }
    }
    if (item.visualTest) {
      const visualTestAbs = resolve(REPO_ROOT, item.visualTest.file);
      if (!pathIsInside(visualTestAbs, CLIENT_ROOT)) {
        addIssue(issues, id, `visualTest.file must stay under client/: ${item.visualTest.file}`);
      } else if (!existsSync(visualTestAbs)) {
        addIssue(issues, id, `visualTest.file does not exist: ${item.visualTest.file}`);
      } else {
        const testSource = readFileSync(visualTestAbs, 'utf8');
        const name = item.visualTest.name;
        if (!hasExactPlaywrightTest(testSource, name)) {
          addIssue(
            issues,
            id,
            `visualTest.name '${name}' is not declared by ${item.visualTest.file}.`
          );
        }
      }
    }

    const promoted =
      ['figma_parity', 'regression_locked'].includes(item.status) ||
      ['parity', 'locked'].includes(item.parityStatus);
    const comparable =
      item.referenceStatus === 'mapped' &&
      ['partial', 'implemented'].includes(item.implementationStatus) &&
      !['not-comparable', 'waived'].includes(item.parityStatus);
    if (args.requireBaselineUpdate && !comparable) {
      addIssue(
        issues,
        id,
        'Baseline update requires a comparable mapped Figma target; remap or restore the reference contract first.'
      );
    }
    const renderable = !['unmapped', 'waived'].includes(item.status) && Boolean(item.referencePath);
    const expectedReferenceStatus =
      item.status === 'waived' ? 'waived' : item.referencePath ? 'mapped' : 'missing';
    if (
      item.referenceStatus !== 'requires-remap' &&
      item.referenceStatus !== expectedReferenceStatus
    ) {
      addIssue(
        issues,
        id,
        `referenceStatus '${item.referenceStatus}' contradicts referencePath/status; expected '${expectedReferenceStatus}'.`
      );
    }
    if (item.referenceStatus === 'requires-remap') {
      if (!item.referencePath || item.status === 'waived') {
        addIssue(
          issues,
          id,
          "referenceStatus 'requires-remap' requires a non-waived local referencePath."
        );
      }
      if (item.parityStatus !== 'not-comparable') {
        addIssue(
          issues,
          id,
          "referenceStatus 'requires-remap' requires parityStatus 'not-comparable'."
        );
      }
      if (item.designDecision?.status !== 'open') {
        addIssue(issues, id, "referenceStatus 'requires-remap' requires an open designDecision.");
      }
    }
    if (['parity', 'locked'].includes(item.parityStatus)) {
      if (item.referenceStatus !== 'mapped' || item.implementationStatus !== 'implemented') {
        addIssue(
          issues,
          id,
          `${item.parityStatus} requires referenceStatus 'mapped' and implementationStatus 'implemented'.`
        );
      }
    }
    if (['missing', 'not-applicable'].includes(item.implementationStatus)) {
      if (!['not-comparable', 'waived'].includes(item.parityStatus)) {
        addIssue(
          issues,
          id,
          `implementationStatus '${item.implementationStatus}' cannot use parityStatus '${item.parityStatus}'.`
        );
      }
    } else if (item.referenceStatus === 'mapped' && item.parityStatus === 'not-comparable') {
      addIssue(
        issues,
        id,
        `Implemented/partial mapped surfaces must use parityStatus 'drifting', 'in-progress', 'parity', or 'locked'.`
      );
    }
    const legacyParity =
      item.status === 'waived'
        ? 'waived'
        : item.status === 'regression_locked'
          ? 'locked'
          : item.status === 'figma_parity'
            ? 'parity'
            : item.status === 'in_progress'
              ? 'in-progress'
              : null;
    if (legacyParity && item.parityStatus !== legacyParity) {
      addIssue(
        issues,
        id,
        `Deprecated status '${item.status}' contradicts parityStatus '${item.parityStatus}'.`
      );
    }
    if (item.status === 'waived' && !item.waiver)
      addIssue(issues, id, 'Waived item requires structured waiver metadata.');
    if (promoted && !item.signoff)
      addIssue(issues, id, 'Promoted item requires structured signoff metadata.');
    if (promoted && CONTRADICTION_RE.test(item.notes ?? '')) {
      addIssue(
        issues,
        id,
        'Promoted item notes still describe missing/incomplete/non-parity work.'
      );
    }
    if (item.status === 'regression_locked') {
      const signoff = item.signoff ?? {};
      if (!signoff.regressionLockedBy || !signoff.regressionLockedAt) {
        addIssue(
          issues,
          id,
          'regression_locked item requires regressionLockedBy/regressionLockedAt.'
        );
      }
    }

    if (!item.referencePath) {
      noReference++;
      if (comparable) addIssue(issues, id, 'Comparable item is missing referencePath.');
      continue;
    }

    let referenceAbs = join(REPO_ROOT, item.referencePath);
    if (!pathIsInside(referenceAbs, FIGMA_ROOT)) {
      addIssue(
        issues,
        id,
        `referencePath must stay under docs/design/figma/: ${item.referencePath}`
      );
    }
    if (!existsSync(referenceAbs)) {
      addIssue(issues, id, `Broken referencePath: ${item.referencePath}`);
      continue;
    }
    resolved++;

    const refUsers = references.get(item.referencePath) ?? [];
    refUsers.push(id);
    references.set(item.referencePath, refUsers);

    const manifestMatch = manifestByReference.get(item.referencePath);
    if (!manifestMatch) {
      addIssue(
        issues,
        id,
        `referencePath missing from reference-manifest.json: ${item.referencePath}`
      );
    } else {
      const manifestKey = manifestMatch.id;
      const manifestEntry = manifestMatch.entry;
      try {
        referenceAbs =
          stagedReference?.item.id === id
            ? stagedReference.referencePath
            : resolveManifestArtifact(manifestEntry);
      } catch (error) {
        addIssue(issues, id, error instanceof Error ? error.message : String(error));
        continue;
      }
      const lifecycle = manifestEntry.lifecycle;
      if (!lifecycle?.status || !lifecycle.owner || !lifecycle.reason) {
        addIssue(issues, id, 'Reference manifest entry is missing lifecycle metadata.');
      }
      const inventorySource = manifestEntry.figma?.nodeId
        ? componentInventoryByNodeId.get(manifestEntry.figma.nodeId)
        : null;
      if (inventorySource?.mappingStatus === 'superseded-source') {
        const sourceOnlyRegistryItem =
          item.status === 'unmapped' || item.implementationStatus === 'not-applicable';
        const canonicalComponent = inventorySource.canonicalFigmaComponentId
          ? componentInventoryById.get(inventorySource.canonicalFigmaComponentId)
          : null;
        const canonicalNode = canonicalComponent?.figma?.nodeId;
        const canonicalLabel = canonicalNode
          ? `; canonical source is '${canonicalNode}' (${canonicalComponent.figma.name})`
          : '';
        if (lifecycle?.status === 'canonical-product') {
          addIssue(
            issues,
            id,
            `Manifest calls superseded Figma node '${manifestEntry.figma.nodeId}' canonical-product${canonicalLabel}. Mark the local export superseded before any parity work.`
          );
        }
        if (!sourceOnlyRegistryItem && item.referenceStatus !== 'requires-remap') {
          addIssue(
            issues,
            id,
            `Reference uses superseded Figma node '${manifestEntry.figma.nodeId}'${canonicalLabel}. Set referenceStatus to 'requires-remap' and select/export the canonical state before comparison, baseline promotion, or signoff.`
          );
        }
      }
      if (lifecycle?.status === 'canonical-product' && !manifestEntry.figma?.nodeId) {
        addIssue(
          issues,
          id,
          'Canonical-product reference requires a durable live Figma nodeId in the manifest.'
        );
      }
      if (args.requireSignoff && lifecycle?.status !== 'canonical-product') {
        addIssue(
          issues,
          id,
          `Signoff requires lifecycle canonical-product; found '${lifecycle?.status ?? 'missing'}'.`
        );
      }
      if (!manifestEntry.registryIds?.includes(id)) {
        addIssue(issues, id, `reference manifest entry does not list registry id '${id}'.`);
      }
      const meta = await sharp(referenceAbs).metadata();
      const manifestWidth = manifestEntry.exportBounds?.width;
      const manifestHeight = manifestEntry.exportBounds?.height;
      if (meta.width !== manifestWidth || meta.height !== manifestHeight) {
        addIssue(
          issues,
          id,
          `Manifest dimensions ${manifestWidth}×${manifestHeight} do not match ${meta.width}×${meta.height}.`
        );
      }
      if (manifestEntry.assetSha256 && stagedReference?.item.id !== id) {
        const sha = createHash('sha256').update(readFileSync(referenceAbs)).digest('hex');
        if (sha !== manifestEntry.assetSha256)
          addIssue(issues, id, 'Manifest assetSha256 is stale.');
      }
      if (manifestEntry.artifactPath && !manifestEntry.acquisition) {
        addIssue(
          issues,
          id,
          'Content-addressed artifactPath requires structured acquisition provenance.'
        );
      }
      if ((args.requireSignoff || args.requireBaselineUpdate) && !manifestEntry.acquisition) {
        addIssue(
          issues,
          id,
          'Signoff/baseline promotion requires a reviewed durable reference acquisition receipt.'
        );
      }
      if (
        manifestEntry.acquisition &&
        (manifestEntry.acquisition.exportSha256 !== manifestEntry.assetSha256 ||
          manifestEntry.acquisition.nodeId !== manifestEntry.figma?.nodeId ||
          manifestEntry.acquisition.fileKey !== manifest.figmaFile?.key)
      ) {
        addIssue(
          issues,
          id,
          'Manifest acquisition provenance contradicts the canonical reference identity.'
        );
      }
      let acquisitionReceipt = null;
      if (manifestEntry.acquisition) {
        const acquisition = manifestEntry.acquisition;
        for (const [name, pointer] of [
          ['acquisition evidence', acquisition.evidence],
          ['Figma node', acquisition.node],
          ['Figma variables', acquisition.variables],
          ...(acquisition.comparisonDiff
            ? [['reference comparison diff', acquisition.comparisonDiff]]
            : []),
        ]) {
          try {
            resolveDurablePointer(pointer, {
              root: DURABLE_EVIDENCE_ROOT,
              extensions: name.includes('diff') ? ['png'] : ['json'],
              label: `Durable ${name}`,
            });
          } catch (error) {
            addIssue(issues, id, error instanceof Error ? error.message : String(error));
          }
        }
        acquisitionReceipt = loadDurableReceipt(
          acquisition.receipt,
          'Canonical reference acquisition receipt',
          id,
          issues
        );
        if (acquisitionReceipt) {
          const receiptArtifacts = validateReceiptArtifacts(acquisitionReceipt, id, issues);
          const acquisitionEvidence = readReceiptArtifactJson(
            receiptArtifacts.acquisitionEvidence,
            'Reference acquisition evidence',
            id,
            issues
          );
          for (const message of referencePromotionReceiptIssues({
            receipt: acquisitionReceipt,
            manifest,
            manifestKey,
            manifestEntry,
            acquisitionEvidence,
          })) {
            addIssue(issues, id, message);
          }
          if (
            acquisitionReceipt.kind !== 'figma-reference-promotion' ||
            acquisitionReceipt.runId !== acquisition.runId ||
            acquisitionReceipt.reviewSha256 !== acquisition.reviewSha256 ||
            acquisitionReceipt.artifacts?.acquisitionEvidence?.sha256 !==
              acquisition.evidence?.sha256 ||
            acquisitionReceipt.artifacts?.reference?.sha256 !== manifestEntry.assetSha256 ||
            acquisitionReceipt.artifacts?.node?.sha256 !== acquisition.node?.sha256 ||
            acquisitionReceipt.artifacts?.variables?.sha256 !== acquisition.variables?.sha256 ||
            (acquisition.comparisonDiff?.sha256 ?? null) !==
              (acquisitionReceipt.artifacts?.comparisonDiff?.sha256 ?? null) ||
            acquisitionReceipt.source?.export?.sha256 !== manifestEntry.assetSha256 ||
            !acquisitionReceipt.target?.registryIds?.includes(id)
          ) {
            addIssue(
              issues,
              id,
              'Durable reference acquisition receipt contradicts the manifest provenance.'
            );
          }
        }
        const acquiredDate = acquisition.acquiredAt?.slice(0, 10);
        if (
          acquiredDate !== manifestEntry.exportedAt ||
          acquiredDate !== manifestEntry.lastCheckedAt
        ) {
          addIssue(
            issues,
            id,
            'Reference freshness dates must come from acquiredAt, not promotion time.'
          );
        }
        if (Date.parse(acquisition.promotedAt) < Date.parse(acquisition.acquiredAt)) {
          addIssue(issues, id, 'Reference promotedAt predates acquiredAt.');
        }
      }

      let currentTargetSource = null;
      if (item.baselineUpdate || item.signoff) {
        try {
          currentTargetSource = targetSourceState({
            item,
            dependencyGraph,
            screenRegistry,
            repoRoot: REPO_ROOT,
          });
        } catch (error) {
          addIssue(issues, id, error instanceof Error ? error.message : String(error));
        }
      }

      if (item.baselineUpdate) {
        const update = item.baselineUpdate;
        const receipt = loadDurableReceipt(
          update.receipt,
          'Baseline promotion receipt',
          id,
          issues
        );
        if (receipt) {
          const receiptArtifacts = validateReceiptArtifacts(receipt, id, issues);
          const evidence = readReceiptArtifactJson(
            receiptArtifacts.evidence,
            'Baseline promotion evidence',
            id,
            issues
          );
          const strictAudit = readReceiptArtifactJson(
            receiptArtifacts.strictAudit,
            'Baseline promotion strict audit',
            id,
            issues
          );
          validateTargetSourceBinding({
            record: update,
            receipt,
            receiptArtifacts,
            currentState: currentTargetSource,
            id,
            label: 'Baseline promotion',
            issues,
            warnings,
            allowCurrentMismatch:
              args.requireBaselineUpdate || args.allowStaleBaseline || !args.requireSignoff,
          });
          for (const message of baselinePromotionReceiptIssues({
            receipt,
            update,
            item,
            manifestKey,
            manifestEntry,
            snapshotPath: declaredSnapshot ? repoRel(declaredSnapshot) : null,
            evidence,
            strictAudit,
          })) {
            addIssue(issues, id, message);
          }
          if (
            receipt.kind !== 'figma-baseline-promotion' ||
            receipt.runId !== update.measurementRunId ||
            receipt.reviewSha256 !== update.evidenceSha256 ||
            receipt.contract?.referenceSha256 !== manifestEntry.assetSha256 ||
            receipt.contract?.referenceAcquisitionReceiptSha256 !==
              manifestEntry.acquisition?.receipt?.sha256 ||
            receipt.contract?.afterSha256 !== update.afterSha256 ||
            receipt.contract?.captureSha256 !== update.captureSha256 ||
            receipt.artifacts?.capture?.sha256 !== receipt.contract?.captureSha256 ||
            receipt.artifacts?.capture?.sha256 !== receipt.contract?.afterSha256
          ) {
            addIssue(
              issues,
              id,
              'Durable baseline promotion receipt contradicts the target contract.'
            );
          }
        }
        if (
          update.referenceSha256 !== manifestEntry.assetSha256 ||
          update.referenceAcquisitionReceiptSha256 !== manifestEntry.acquisition?.receipt?.sha256 ||
          update.captureSha256 !== update.afterSha256
        ) {
          addIssue(
            issues,
            id,
            'Baseline promotion metadata is stale for the current reference/snapshot.'
          );
        }
        if (declaredSnapshot) {
          const currentSnapshotSha256 = createHash('sha256')
            .update(readFileSync(declaredSnapshot))
            .digest('hex');
          if (currentSnapshotSha256 !== update.afterSha256) {
            addIssue(
              issues,
              id,
              'Baseline promotion hash does not match the current target snapshot.'
            );
          }
        }
      }

      if (item.signoff) {
        const signoff = item.signoff;
        const receipt = loadDurableReceipt(signoff.receipt, 'Figma parity receipt', id, issues);
        if (receipt) {
          const receiptArtifacts = validateReceiptArtifacts(receipt, id, issues);
          const evidence = readReceiptArtifactJson(
            receiptArtifacts.evidence,
            'Figma signoff evidence',
            id,
            issues
          );
          const strictAudit = readReceiptArtifactJson(
            receiptArtifacts.strictAudit,
            'Figma signoff strict audit',
            id,
            issues
          );
          validateTargetSourceBinding({
            record: signoff,
            receipt,
            receiptArtifacts,
            currentState: currentTargetSource,
            id,
            label: 'Figma signoff',
            issues,
            warnings,
            allowCurrentMismatch:
              args.requireBaselineUpdate || args.allowStaleBaseline || !args.requireSignoff,
          });
          for (const message of parityAttestationReceiptIssues({
            receipt,
            signoff,
            baselineUpdate: item.baselineUpdate,
            item,
            manifestKey,
            manifestEntry,
            snapshotPath: declaredSnapshot ? repoRel(declaredSnapshot) : null,
            maxDiffPixelRatio: allowedBase(item, registry),
            maxBaselineReproducibilityRatio: registry._meta.thresholds.regressionBaseline,
            evidence,
            strictAudit,
          })) {
            addIssue(issues, id, message);
          }
          if (
            receipt.kind !== 'figma-parity-attestation' ||
            receipt.runId !== signoff.runId ||
            receipt.reviewSha256 !== signoff.evidenceSha256 ||
            receipt.contract?.referenceSha256 !== manifestEntry.assetSha256 ||
            receipt.contract?.referenceAcquisitionReceiptSha256 !==
              manifestEntry.acquisition?.receipt?.sha256 ||
            receipt.contract?.baselinePromotionReceiptSha256 !==
              item.baselineUpdate?.receipt?.sha256 ||
            receipt.contract?.snapshotSha256 !== signoff.snapshotSha256 ||
            receipt.contract?.captureSha256 !== signoff.captureSha256 ||
            receipt.artifacts?.capture?.sha256 !== receipt.contract?.captureSha256
          ) {
            addIssue(issues, id, 'Durable parity receipt contradicts the target contract.');
          }
        }
        if (
          signoff.referenceSha256 !== manifestEntry.assetSha256 ||
          signoff.referenceAcquisitionReceiptSha256 !==
            manifestEntry.acquisition?.receipt?.sha256 ||
          signoff.baselinePromotionReceiptSha256 !== item.baselineUpdate?.receipt?.sha256
        ) {
          addIssue(issues, id, 'Figma signoff is stale for the current reference/snapshot.');
        }
        if (declaredSnapshot) {
          const currentSnapshotSha256 = createHash('sha256')
            .update(readFileSync(declaredSnapshot))
            .digest('hex');
          if (currentSnapshotSha256 !== signoff.snapshotSha256) {
            addIssue(issues, id, 'Figma signoff hash does not match the current target snapshot.');
          }
        }
      }

      if (item.captureViewport) {
        const widthDelta = Math.abs(
          (manifestEntry.exportBounds?.width ?? 0) - item.captureViewport.width
        );
        const heightDelta = Math.abs(
          (manifestEntry.exportBounds?.height ?? 0) - item.captureViewport.height
        );
        if (widthDelta > 1 || heightDelta > 1) {
          addIssue(
            issues,
            id,
            `captureViewport ${item.captureViewport.width}×${item.captureViewport.height} must match the whole reference frame ${manifestEntry.exportBounds?.width}×${manifestEntry.exportBounds?.height}.`
          );
        }
      }

      // Historical/source-only exports remain immutable audit evidence: they have
      // no durable live Figma node and must not be "refreshed" by changing their
      // timestamp. Freshness is meaningful only for canonical product references.
      const canonicalProductReference = lifecycle?.status === 'canonical-product';
      const freshnessRequired =
        canonicalProductReference &&
        stagedReference?.item.id !== id &&
        (args.freshnessOnly ||
          args.requireSignoff ||
          (requestedIds.length > 0 &&
            manifest.figmaFile?.freshnessPolicy?.enforcement === 'all-checks') ||
          ['parity', 'locked'].includes(item.parityStatus));
      const freshnessAdvisory =
        canonicalProductReference &&
        stagedReference?.item.id !== id &&
        requestedIds.length > 0 &&
        !freshnessRequired;
      if (args.freshnessOnly && !canonicalProductReference) lifecycleExempt++;
      if (freshnessRequired) {
        const checkedAt = manifestEntry.lastCheckedAt ?? manifestEntry.exportedAt;
        const exportedAt = manifestEntry.exportedAt ?? manifestEntry.lastCheckedAt;
        const freshnessDays = manifestEntry.staleAfterDays ?? defaultFreshnessDays;
        const ageDays = daysSince(checkedAt, todayDate);
        if (!checkedAt) {
          addIssue(
            issues,
            id,
            'Manifest entry is missing lastCheckedAt/exportedAt freshness metadata.'
          );
        } else if (ageDays === null) {
          addIssue(issues, id, `Manifest freshness date '${checkedAt}' must use YYYY-MM-DD.`);
        } else if (ageDays > freshnessDays) {
          addIssue(
            issues,
            id,
            `Figma reference is stale: lastCheckedAt/exportedAt is ${checkedAt} (${ageDays} days old, max ${freshnessDays}). Refresh from live Figma and update reference-manifest.json.`
          );
        }
        const exportAgeDays = daysSince(exportedAt, todayDate);
        if (!exportedAt) {
          addIssue(issues, id, 'Manifest entry is missing exportedAt freshness metadata.');
        } else if (exportAgeDays === null) {
          addIssue(issues, id, `Manifest exportedAt date '${exportedAt}' must use YYYY-MM-DD.`);
        }
      }
      if (freshnessAdvisory) {
        const checkedAt = manifestEntry.lastCheckedAt ?? manifestEntry.exportedAt;
        const freshnessDays = manifestEntry.staleAfterDays ?? defaultFreshnessDays;
        const ageDays = daysSince(checkedAt, todayDate);
        if (ageDays === null) {
          warnings.push({
            id,
            message:
              'Reference freshness metadata is missing or invalid. Diagnostic measurement remains allowed, but signoff requires a fresh canonical reference.',
          });
        } else if (ageDays > freshnessDays) {
          warnings.push({
            id,
            message:
              `Figma reference is ${ageDays} days old (max ${freshnessDays}). ` +
              'Diagnostic measurement remains allowed; refresh it before signoff.',
          });
        }
      }

      if (
        manifestEntry.captureKind === 'full-frame' &&
        item.viewport &&
        registry._meta.viewports[item.viewport]
      ) {
        const vp = registry._meta.viewports[item.viewport];
        const widthDelta = Math.abs((manifestEntry.exportBounds?.width ?? 0) - vp.width);
        const heightDelta = Math.abs((manifestEntry.exportBounds?.height ?? 0) - vp.height);
        if (widthDelta > 1 || heightDelta > 1) {
          addIssue(
            issues,
            id,
            `Full-frame reference dimensions must match ${item.viewport} viewport within 1px, got ${manifestEntry.exportBounds?.width}×${manifestEntry.exportBounds?.height}.`
          );
        }
      }
    }

    const base = allowedBase(item, registry);
    if ((item.maxDiffPixelRatio ?? base) > base && !item.waiver) {
      addIssue(
        issues,
        id,
        `Item threshold ${item.maxDiffPixelRatio} is looser than base ${base} without waiver.`
      );
    }

    const meta = await sharp(referenceAbs).metadata();
    for (const crop of item.crops ?? []) {
      const cropId = `${id}/${crop.id}`;
      if (crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0) {
        addIssue(issues, cropId, 'Invalid crop rectangle.');
      }
      if (crop.x + crop.width > meta.width || crop.y + crop.height > meta.height) {
        addIssue(issues, cropId, `Crop is outside reference bounds ${meta.width}×${meta.height}.`);
      }
      if ((crop.maxDiffPixelRatio ?? base) > base && !crop.waiver) {
        addIssue(
          issues,
          cropId,
          `Crop threshold ${crop.maxDiffPixelRatio} is looser than base ${base} without waiver.`
        );
      }
    }

    if (renderable && item.mockScenario && !scenarioMetadata.has(item.mockScenario)) {
      addIssue(
        issues,
        id,
        `mockScenario '${item.mockScenario}' is not defined in visualScenarios.ts.`
      );
    }
    const fixtureType = item.mockScenario ? scenarioMetadata.get(item.mockScenario) : null;
    if (promoted && fixtureType && fixtureType !== 'app-dom') {
      addIssue(
        issues,
        id,
        `Promoted item cannot use fixture type '${fixtureType}' (scenario '${item.mockScenario}').`
      );
    }
    if (args.requireSignoff) {
      const resolvedFixtureType = fixtureType ?? 'unknown';
      if (resolvedFixtureType !== 'app-dom') {
        addIssue(
          issues,
          id,
          `Signoff requires an app-DOM fixture; found '${resolvedFixtureType}'.`
        );
      }
      if (item.implementationStatus !== 'implemented') {
        addIssue(issues, id, 'Signoff requires implementationStatus implemented.');
      }
      if (!item.baselineUpdate) {
        addIssue(
          issues,
          id,
          'Signoff requires a reviewed durable baseline promotion for the current target snapshot.'
        );
      }
    }
    const captureRequired =
      requestedIds.length > 0 || ['parity', 'locked'].includes(item.parityStatus);
    const snapshot = comparable && captureRequired ? declaredSnapshot : null;
    if (comparable && captureRequired && !snapshot) {
      if (!initialBaselineCapture) {
        addIssue(issues, id, 'Comparable item is missing a Playwright snapshot.');
      }
    } else if (snapshot) {
      const [referenceMeta, snapshotMeta] = await Promise.all([
        sharp(referenceAbs).metadata(),
        sharp(snapshot).metadata(),
      ]);
      if (
        referenceMeta.width !== snapshotMeta.width ||
        referenceMeta.height !== snapshotMeta.height
      ) {
        const message =
          `Snapshot dimensions ${snapshotMeta.width}×${snapshotMeta.height} do not match reference ` +
          `${referenceMeta.width}×${referenceMeta.height}.`;
        if (args.requireBaselineUpdate) {
          warnings.push({
            id,
            message:
              message + ' Accepted only while the target-specific baseline update is in progress.',
          });
        } else {
          addIssue(issues, id, message);
        }
      }
    }
  }

  if (args.freshnessOnly) {
    return report({
      issues,
      warnings,
      resolved,
      noReference,
      lifecycleExempt,
      freshnessOnly: true,
    });
  }

  for (const [referencePath, users] of references) {
    if (users.length <= 1) continue;
    const manifestEntry = manifestByReference.get(referencePath)?.entry;
    if (
      !manifestEntry?.sharesReferenceWith &&
      !manifestEntry?.derivedFrom &&
      !manifestEntry?.reason
    ) {
      addIssue(
        issues,
        referencePath,
        `Duplicate reference used by ${users.join(', ')} without manifest reason.`
      );
    }
  }

  const registryById = new Map((registry.items ?? []).map((item) => [item.id, item]));
  for (const entry of manifestEntries) {
    for (const id of entry.registryIds ?? []) {
      const registryItem = registryById.get(id);
      if (!registryItem) {
        addIssue(issues, entry.referencePath, `Manifest references unknown registry id '${id}'.`);
      } else if (registryItem.referencePath !== entry.referencePath) {
        addIssue(
          issues,
          id,
          `Manifest ownership is stale: registry referencePath is '${registryItem.referencePath ?? 'null'}' but manifest owns '${entry.referencePath}'.`
        );
      }
    }
    if (/channel/i.test(JSON.stringify(entry))) {
      addIssue(issues, entry.referencePath, 'Manifest must not store session channel IDs.');
    }
  }

  report({ issues, warnings, resolved, noReference });
}

function report({
  issues,
  warnings,
  resolved,
  noReference,
  lifecycleExempt = 0,
  freshnessOnly = false,
}) {
  console.log(
    freshnessOnly
      ? '\n── Figma Freshness Check ─────────────────────────────────────────\n'
      : '\n── Figma Governance Check ────────────────────────────────────────\n'
  );
  console.log(`  ✅ Resolved references: ${resolved}`);
  console.log(`  ⚪ No reference:        ${noReference}`);
  if (freshnessOnly) console.log(`  ⚪ Lifecycle-exempt:    ${lifecycleExempt}`);
  console.log(`  ⚠️  Warnings:           ${warnings.length}`);
  console.log(`  ❌ Errors:             ${issues.length}`);

  if (warnings.length) {
    console.log('\nWarnings:\n');
    for (const warning of warnings) console.log(`  • ${warning.id}: ${warning.message}`);
  }
  if (issues.length) {
    console.log('\nErrors:\n');
    for (const issue of issues) console.log(`  • ${issue.id}: ${issue.message}`);
    console.log(
      '\nFix the registry/manifest/fixture contract above before claiming Figma parity.\n'
    );
    process.exit(1);
  }
  console.log(
    freshnessOnly
      ? '\nAll canonical Figma product references are within the manifest freshness window. ✓\n'
      : '\nFigma registry, references, manifest, and visual scenario contracts are valid. ✓\n'
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
