#!/usr/bin/env node
/**
 * Strict Figma parity audit.
 *
 * This script is intentionally less forgiving than figma-diff-report.mjs. It is
 * meant for sign-off hygiene, not visual triage:
 * - flags registry items whose status contradicts their notes
 * - flags per-item thresholds looser than the global policy
 * - computes a raw, no-alignment pixel diff for the selected target (or any
 *   available captures when producing a repository report)
 * - gates parity on the same raw geometry with anti-alias-only pixels excluded,
 *   while retaining the fully raw ratio as a renderer diagnostic
 * - records test-only DOM/CSS patches that can mask product drift
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import pixelmatch from 'pixelmatch';
import {
  REFERENCE_RUNS_ROOT,
  pathIsWithin,
  resolveManifestArtifact,
} from './lib/figma-reference-run.mjs';
import { auditTargetMaskingFiles } from './lib/figma-masking-audit.mjs';
import { STRUCTURAL_EDGE_METRIC, structuralEdgeDiff } from './lib/figma-structural-diff.mjs';
import { findingBelongsToTarget, targetDependencyFiles } from './lib/figma-target-closure.mjs';
import { loadVisualScenarioMetadata } from './lib/visual-scenario-contract.mjs';
import { resolveCanonicalSnapshotPath } from './lib/figma-snapshot-contract.mjs';
import { PNG } from 'pngjs';
import sharp from 'sharp';

const ACCEPTANCE_METRIC = 'pixelmatch-aa-excluded-v1';

import { getFigmoonConfig } from '../lib/config.mjs';
const __figmoonConfig = getFigmoonConfig();
const REPO_ROOT = __figmoonConfig.consumerRoot;
const CLIENT_ROOT = __figmoonConfig.clientRoot;
const REGISTRY_PATH = __figmoonConfig.registryPath;
const MANIFEST_PATH = __figmoonConfig.manifestPath;
const VISUAL_QA_EXCEPTIONS_PATH = __figmoonConfig.visualQaExceptionsPath;
const VISUAL_SCENARIOS_PATH = __figmoonConfig.visualScenariosPath;
const DEPENDENCY_GRAPH_PATH = __figmoonConfig.dependencyGraphPath;
const SCREEN_REGISTRY_PATH = __figmoonConfig.screenRegistryPath;
let SNAPSHOT_ROOT = __figmoonConfig.snapshotRoot;
let OUT_DIR = __figmoonConfig.auditResultsRoot;
let OUT_JSON = join(OUT_DIR, 'strict-audit.json');
let OUT_MD = join(OUT_DIR, 'STRICT_AUDIT.md');
let REFERENCE_OVERRIDE = null;

function writeFileAtomic(path, contents) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, contents);
  renameSync(temporaryPath, path);
}

const SNAPSHOT_HINTS = {
  mobile: 'mobile/visual/mobile.spec.ts',
  desktop: 'desktop/visual/pages.spec.ts',
  component: 'desktop/visual/components.spec.ts',
  'tablet-landscape': 'tablet-landscape/visual/tablet.spec.ts',
  'tablet-portrait': 'tablet-portrait/visual/tablet.spec.ts',
};

const CONTRADICTION_RE =
  /\b(Partial|Missing|not yet|needs calibration|missing|not implemented|does not exist|not built|not identical)\b/i;

function getParityStatus(item) {
  if (item.parityStatus) return item.parityStatus;
  if (item.status === 'waived') return 'waived';
  if (item.status === 'regression_locked') return 'locked';
  if (item.status === 'figma_parity') return 'parity';
  if (item.status === 'in_progress') return 'in-progress';
  return item.referencePath ? 'drifting' : 'not-comparable';
}

function isComparable(item) {
  const stagedRemapDiagnostic =
    Boolean(REFERENCE_OVERRIDE) && item.referenceStatus === 'requires-remap';
  return (
    (item.referenceStatus === 'mapped' || stagedRemapDiagnostic) &&
    ['partial', 'implemented'].includes(item.implementationStatus) &&
    getParityStatus(item) !== 'waived' &&
    (stagedRemapDiagnostic || getParityStatus(item) !== 'not-comparable')
  );
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir || !existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) throw new Error(`Strict audit must not traverse ${full}.`);
      if (info.isDirectory()) stack.push(full);
      else if (info.isFile()) out.push(full);
    }
  }
  return out;
}

const visualScenarioMetadata = loadVisualScenarioMetadata(VISUAL_SCENARIOS_PATH);

function fixtureTypeForScenario(scenario) {
  return scenario ? (visualScenarioMetadata.get(scenario) ?? null) : null;
}

function resolveClientPath(value, flag) {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path.`);
  return resolve(CLIENT_ROOT, value);
}

// Recorded filters and console output must stay machine-portable: sealed
// evidence is content-addressed and shared through git, so absolute checkout
// paths would leak a single machine's filesystem layout into the repository.
function toRepoRelativePath(value) {
  if (!value || !isAbsolute(value)) return value;
  const relativePath = relative(REPO_ROOT, value);
  return relativePath.startsWith('..') ? value : relativePath;
}

function parseArgs(argv) {
  const filters = {
    id: null,
    crop: null,
    grep: null,
    mode: 'report',
    snapshotRoot: null,
    outDir: null,
    referencePath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--id') filters.id = argv[++i] ?? null;
    else if (arg.startsWith('--id=')) filters.id = arg.slice('--id='.length);
    else if (arg === '--crop') filters.crop = argv[++i] ?? null;
    else if (arg.startsWith('--crop=')) filters.crop = arg.slice('--crop='.length);
    else if (arg === '--grep') filters.grep = argv[++i] ?? null;
    else if (arg.startsWith('--grep=')) filters.grep = arg.slice('--grep='.length);
    else if (arg === '--mode') filters.mode = argv[++i] ?? 'report';
    else if (arg.startsWith('--mode=')) filters.mode = arg.slice('--mode='.length);
    else if (arg === '--snapshot-root')
      filters.snapshotRoot = resolveClientPath(argv[++i], '--snapshot-root');
    else if (arg.startsWith('--snapshot-root='))
      filters.snapshotRoot = resolveClientPath(
        arg.slice('--snapshot-root='.length),
        '--snapshot-root'
      );
    else if (arg === '--out-dir') filters.outDir = resolveClientPath(argv[++i], '--out-dir');
    else if (arg.startsWith('--out-dir='))
      filters.outDir = resolveClientPath(arg.slice('--out-dir='.length), '--out-dir');
    else if (arg === '--reference-path')
      filters.referencePath = resolveClientPath(argv[++i], '--reference-path');
    else if (arg.startsWith('--reference-path='))
      filters.referencePath = resolveClientPath(
        arg.slice('--reference-path='.length),
        '--reference-path'
      );
    else if (!filters.grep && !arg.startsWith('--')) filters.grep = arg;
  }
  if (!['report', 'governance', 'signoff', 'ci'].includes(filters.mode)) {
    throw new Error(`Unknown strict audit mode: ${filters.mode}`);
  }
  if (filters.referencePath && (filters.mode !== 'report' || !filters.id || filters.grep)) {
    throw new Error('--reference-path is allowed only for one target in report mode.');
  }
  return filters;
}

function itemMatchesFilters(item, filters) {
  if (filters.id && item.id !== filters.id) return false;
  if (filters.crop && !item.crops?.some((crop) => String(crop.id) === filters.crop)) return false;
  if (filters.grep) {
    const haystack = JSON.stringify(item).toLowerCase();
    if (!haystack.includes(filters.grep.toLowerCase())) return false;
  }
  return true;
}

function focusedSlug(filters) {
  const parts = [];
  if (filters.id) parts.push(filters.id);
  if (filters.crop) parts.push(filters.crop);
  if (filters.grep) parts.push(`grep-${filters.grep}`);
  return (
    parts
      .join('--')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || null
  );
}

function findSnapshot(item) {
  if (item.snapshot) {
    const declared = resolveCanonicalSnapshotPath({
      item,
      snapshotRoot: SNAPSHOT_ROOT,
      mustExist: false,
    });
    if (existsSync(declared)) {
      return resolveCanonicalSnapshotPath({ item, snapshotRoot: SNAPSHOT_ROOT });
    }
    return null;
  }

  const hint = item.kind === 'component' ? SNAPSHOT_HINTS.component : SNAPSHOT_HINTS[item.viewport];
  if (hint) {
    const candidate = join(SNAPSHOT_ROOT, hint, `${item.id}.png`);
    if (existsSync(candidate)) return candidate;
  }

  return walkFiles(SNAPSHOT_ROOT).find((file) => file.endsWith(`/${item.id}.png`)) ?? null;
}

async function loadPng(absPath) {
  const buffer = await sharp(absPath).ensureAlpha().png().toBuffer();
  return PNG.sync.read(buffer);
}

function alphaMismatch(pngA, pngB) {
  let mismatched = 0;
  for (let index = 3; index < pngA.data.length; index += 4) {
    if (pngA.data[index] !== pngB.data[index]) mismatched += 1;
  }
  return {
    alphaMismatched: mismatched,
    alphaMismatchRatio: mismatched / (pngA.width * pngA.height),
  };
}

async function rawDiffRatio(figmaAbs, snapshotAbs) {
  const [figmaMeta, snapshotMeta] = await Promise.all([
    sharp(figmaAbs).metadata(),
    sharp(snapshotAbs).metadata(),
  ]);
  const width = figmaMeta.width;
  const height = figmaMeta.height;
  const snapshotWidth = snapshotMeta.width;
  const snapshotHeight = snapshotMeta.height;
  if (!width || !height) throw new Error(`Cannot read dimensions for ${figmaAbs}`);
  if (!snapshotWidth || !snapshotHeight)
    throw new Error(`Cannot read dimensions for ${snapshotAbs}`);

  if (width !== snapshotWidth || height !== snapshotHeight) {
    return {
      ratio: 1,
      mismatched: null,
      acceptanceRatio: 1,
      acceptanceMismatched: null,
      acceptanceMetric: ACCEPTANCE_METRIC,
      structuralRatio: 1,
      structuralMismatched: null,
      structuralEdgeUnionPixels: null,
      structuralCanvasRatio: 1,
      structuralMetric: STRUCTURAL_EDGE_METRIC,
      totalPixels: width * height,
      width,
      height,
      snapshotWidth,
      snapshotHeight,
      dimensionMismatch: true,
      figmaPng: null,
      snapshotPng: null,
    };
  }

  const [figma, snapshot] = await Promise.all([loadPng(figmaAbs), loadPng(snapshotAbs)]);
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(figma.data, snapshot.data, diff.data, width, height, {
    threshold: 0.1,
    includeAA: true,
    // Playwright screenshots are normally opaque. Compare the rendered result
    // on white while retaining original alpha for separate diagnostics.
    checkerboard: false,
  });
  const acceptanceDiff = new PNG({ width, height });
  const acceptanceMismatched = pixelmatch(
    figma.data,
    snapshot.data,
    acceptanceDiff.data,
    width,
    height,
    {
      threshold: 0.1,
      includeAA: false,
      checkerboard: false,
    }
  );
  const alpha = alphaMismatch(figma, snapshot);
  const structural = structuralEdgeDiff(figma, snapshot);

  return {
    ratio: mismatched / (width * height),
    mismatched,
    acceptanceRatio: acceptanceMismatched / (width * height),
    acceptanceMismatched,
    acceptanceMetric: ACCEPTANCE_METRIC,
    structuralRatio: structural.ratio,
    structuralMismatched: structural.mismatched,
    structuralEdgeUnionPixels: structural.edgeUnionPixels,
    structuralCanvasRatio: structural.canvasRatio,
    structuralMetric: structural.metric,
    totalPixels: width * height,
    width,
    height,
    snapshotWidth,
    snapshotHeight,
    dimensionMismatch: false,
    alphaComparable: Boolean(figmaMeta.hasAlpha && snapshotMeta.hasAlpha),
    alphaDiagnosticOnly: Boolean(figmaMeta.hasAlpha && !snapshotMeta.hasAlpha),
    ...alpha,
    figmaPng: figma,
    snapshotPng: snapshot,
  };
}

function normalizeCrop(crop, maxW, maxH) {
  const x = Math.round(Number(crop.x));
  const y = Math.round(Number(crop.y));
  const width = Math.round(Number(crop.width));
  const height = Math.round(Number(crop.height));

  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error('invalid crop rectangle');
  }
  if (x < 0 || y < 0 || x + width > maxW || y + height > maxH) {
    throw new Error(`crop outside image bounds (${x},${y},${width},${height}) for ${maxW}×${maxH}`);
  }
  return { x, y, width, height };
}

function cropPng(source, crop) {
  const out = new PNG({ width: crop.width, height: crop.height });
  for (let y = 0; y < crop.height; y++) {
    const sourceIdx = (source.width * (crop.y + y) + crop.x) << 2;
    const outIdx = (crop.width * y) << 2;
    source.data.copy(out.data, outIdx, sourceIdx, sourceIdx + (crop.width << 2));
  }
  return out;
}

function rawCropDiffRatio(figmaPng, snapshotPng, crop, alphaComparable) {
  const norm = normalizeCrop(crop, figmaPng.width, figmaPng.height);
  const figmaCrop = cropPng(figmaPng, norm);
  const snapCrop = cropPng(snapshotPng, norm);
  const diff = new PNG({ width: norm.width, height: norm.height });
  const mismatched = pixelmatch(figmaCrop.data, snapCrop.data, diff.data, norm.width, norm.height, {
    threshold: 0.1,
    includeAA: true,
    checkerboard: false,
  });
  const acceptanceDiff = new PNG({ width: norm.width, height: norm.height });
  const acceptanceMismatched = pixelmatch(
    figmaCrop.data,
    snapCrop.data,
    acceptanceDiff.data,
    norm.width,
    norm.height,
    {
      threshold: 0.1,
      includeAA: false,
      checkerboard: false,
    }
  );
  const alpha = alphaMismatch(figmaCrop, snapCrop);
  const structural = structuralEdgeDiff(figmaCrop, snapCrop);
  return {
    ratio: mismatched / (norm.width * norm.height),
    mismatched,
    acceptanceRatio: acceptanceMismatched / (norm.width * norm.height),
    acceptanceMismatched,
    acceptanceMetric: ACCEPTANCE_METRIC,
    structuralRatio: structural.ratio,
    structuralMismatched: structural.mismatched,
    structuralEdgeUnionPixels: structural.edgeUnionPixels,
    structuralCanvasRatio: structural.canvasRatio,
    structuralMetric: structural.metric,
    totalPixels: norm.width * norm.height,
    alphaComparable,
    ...alpha,
  };
}

function allowedBase(item, registry) {
  if (item.kind === 'component') return registry._meta.thresholds.figmaParityComponent;
  return registry._meta.thresholds.figmaParityPage;
}

function lineList(items, formatter, limit = 200) {
  if (!items.length) return '- none\n';
  return items.slice(0, limit).map(formatter).join('\n') + '\n';
}

async function main() {
  const filters = parseArgs(process.argv.slice(2));
  if (filters.referencePath) {
    if (
      !pathIsWithin(filters.referencePath, REFERENCE_RUNS_ROOT) ||
      filters.referencePath === REFERENCE_RUNS_ROOT ||
      basename(filters.referencePath) !== 'reference.png' ||
      !existsSync(filters.referencePath)
    ) {
      throw new Error(
        '--reference-path must resolve to an existing immutable figma-reference-runs/<run-id>/reference.png artifact.'
      );
    }
    REFERENCE_OVERRIDE = filters.referencePath;
  }
  if (filters.snapshotRoot) {
    SNAPSHOT_ROOT = filters.snapshotRoot;
  }
  if (filters.outDir) {
    OUT_DIR = filters.outDir;
    OUT_JSON = join(OUT_DIR, 'strict-audit.json');
    OUT_MD = join(OUT_DIR, 'STRICT_AUDIT.md');
  }
  // From here on the filter paths are only recorded, never resolved.
  filters.snapshotRoot = toRepoRelativePath(filters.snapshotRoot);
  filters.outDir = toRepoRelativePath(filters.outDir);
  filters.referencePath = toRepoRelativePath(filters.referencePath);
  const slug = focusedSlug(filters);
  if (slug && !filters.outDir) {
    OUT_DIR = join(OUT_DIR, 'focused', slug);
    OUT_JSON = join(OUT_DIR, 'strict-audit.json');
    OUT_MD = join(OUT_DIR, 'STRICT_AUDIT.md');
  }

  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const dependencyGraph = JSON.parse(readFileSync(DEPENDENCY_GRAPH_PATH, 'utf8'));
  const screenRegistry = JSON.parse(readFileSync(SCREEN_REGISTRY_PATH, 'utf8'));
  const allItems = registry.items;
  const focused = Boolean(slug);
  const items = allItems.filter((item) => itemMatchesFilters(item, filters));

  if (filters.mode === 'signoff') {
    if (!filters.id) throw new Error('Signoff mode requires --id <registry-id>.');
    if (filters.grep)
      throw new Error('Signoff mode does not accept --grep; select exactly one --id.');
    if (items.length !== 1) {
      throw new Error(`Signoff must resolve exactly one registry item; matched ${items.length}.`);
    }
    const [item] = items;
    if (!item.referencePath || !isComparable(item) || item.implementationStatus !== 'implemented') {
      throw new Error(
        `Registry item '${item.id}' is not eligible for signoff (reference: ${item.referenceStatus}, implementation: ${item.implementationStatus}, parity: ${item.parityStatus}).`
      );
    }
  }

  const manifestByReference = new Map(
    Object.values(manifest.items ?? {}).map((entry) => [entry.referencePath, entry])
  );
  if (filters.mode === 'signoff') {
    const [item] = items;
    const manifestEntry = manifestByReference.get(item.referencePath);
    if (!manifestEntry) throw new Error(`No manifest entry exists for '${item.referencePath}'.`);
    if (!manifestEntry.figma?.nodeId) {
      throw new Error(`Signoff requires a durable Figma node id for '${item.id}'.`);
    }
    const fixtureType = fixtureTypeForScenario(item.mockScenario);
    if (fixtureType && fixtureType !== 'app-dom') {
      throw new Error(`Signoff cannot use fixture type '${fixtureType}' for '${item.id}'.`);
    }
  }

  const contradictoryParity = items.filter(
    (item) =>
      ['parity', 'locked'].includes(getParityStatus(item)) &&
      CONTRADICTION_RE.test(item.notes ?? '')
  );
  const looseThresholds = items
    .filter((item) => getParityStatus(item) !== 'waived')
    .flatMap((item) => {
      const base = allowedBase(item, registry);
      const rows = [{ item, crop: null, base, allowed: item.maxDiffPixelRatio ?? base }];
      for (const crop of item.crops ?? []) {
        rows.push({ item, crop, base, allowed: crop.maxDiffPixelRatio ?? base });
      }
      return rows;
    })
    .filter(({ allowed, base, item, crop }) => allowed > base && !(crop?.waiver || item.waiver));

  const snapshotMissing = [];
  const registeredUnmapped = [];
  const rawDiffs = [];
  for (const item of items) {
    if (getParityStatus(item) === 'waived' || !item.referencePath) continue;
    if (!isComparable(item)) {
      registeredUnmapped.push(item);
      continue;
    }
    const auditRawPixels =
      focused || filters.mode === 'report' || ['parity', 'locked'].includes(getParityStatus(item));
    if (!auditRawPixels) continue;
    const manifestEntry = manifestByReference.get(item.referencePath);
    const figmaAbs =
      REFERENCE_OVERRIDE ??
      resolveManifestArtifact(manifestEntry ?? { referencePath: item.referencePath });
    const snapshotAbs = findSnapshot(item);
    if (!snapshotAbs) {
      // A drifting or partial surface is allowed to be an inventory item before
      // it receives its own focused capture. Missing captures only block a
      // promoted item or an explicitly selected audit target.
      if (focused || ['parity', 'locked'].includes(getParityStatus(item))) {
        snapshotMissing.push(item);
      }
      continue;
    }
    const base = allowedBase(item, registry);
    const structuralThreshold = registry._meta.thresholds.structuralEdgeJaccard;
    const diff = await rawDiffRatio(figmaAbs, snapshotAbs);
    const { figmaPng, snapshotPng, ...diffResult } = diff;
    // Process crops!
    const cropResults = [];
    if (!diffResult.dimensionMismatch && item.crops && item.crops.length > 0) {
      for (const crop of item.crops) {
        try {
          if (filters.crop && String(crop.id) !== filters.crop) continue;
          const cropDiff = rawCropDiffRatio(
            figmaPng,
            snapshotPng,
            crop,
            diffResult.alphaComparable
          );
          const cropThreshold =
            filters.mode === 'signoff' ? base : (crop.maxDiffPixelRatio ?? base);
          cropResults.push({
            id: crop.id,
            title: crop.title,
            ratio: cropDiff.ratio,
            mismatched: cropDiff.mismatched,
            acceptanceRatio: cropDiff.acceptanceRatio,
            acceptanceMismatched: cropDiff.acceptanceMismatched,
            acceptanceMetric: cropDiff.acceptanceMetric,
            structuralRatio: cropDiff.structuralRatio,
            structuralMismatched: cropDiff.structuralMismatched,
            structuralEdgeUnionPixels: cropDiff.structuralEdgeUnionPixels,
            structuralCanvasRatio: cropDiff.structuralCanvasRatio,
            structuralMetric: cropDiff.structuralMetric,
            structuralThreshold,
            totalPixels: cropDiff.totalPixels,
            alphaMismatched: cropDiff.alphaMismatched,
            alphaMismatchRatio: cropDiff.alphaMismatchRatio,
            alphaComparable: cropDiff.alphaComparable,
            threshold: cropThreshold,
            aboveThreshold:
              cropDiff.acceptanceRatio > cropThreshold ||
              cropDiff.structuralRatio > structuralThreshold ||
              (cropDiff.alphaComparable && cropDiff.alphaMismatchRatio > cropThreshold),
          });
        } catch (err) {
          cropResults.push({
            id: crop.id,
            title: crop.title,
            error: err.message,
          });
        }
      }
    }

    rawDiffs.push({
      id: item.id,
      title: item.title,
      kind: item.kind,
      viewport: item.viewport,
      status: item.status,
      parityStatus: getParityStatus(item),
      referencePath: item.referencePath,
      captureKind: manifestEntry?.captureKind ?? null,
      snapshotPath: relative(REPO_ROOT, snapshotAbs),
      baseThreshold: base,
      structuralThreshold,
      itemThreshold: filters.mode === 'signoff' ? base : (item.maxDiffPixelRatio ?? base),
      ...diffResult,
      crops: cropResults,
      aboveRawBase: diffResult.dimensionMismatch || diffResult.ratio > base,
      aboveStructuralBase:
        diffResult.dimensionMismatch || diffResult.structuralRatio > structuralThreshold,
      aboveBase:
        diffResult.dimensionMismatch ||
        diffResult.structuralRatio > structuralThreshold ||
        (diffResult.alphaComparable && diffResult.alphaMismatchRatio > base) ||
        (filters.crop
          ? cropResults.some((c) => c.aboveThreshold || c.error)
          : diffResult.acceptanceRatio > base ||
            cropResults.some((c) => c.aboveThreshold || c.error)),
    });
  }

  if (filters.mode === 'signoff' && rawDiffs.length !== 1) {
    throw new Error(`Signoff requires one comparable snapshot; found ${rawDiffs.length}.`);
  }

  rawDiffs.sort((a, b) => b.ratio - a.ratio);
  const rawAboveBase = rawDiffs.filter((row) => row.aboveRawBase);
  const acceptanceAboveBase = rawDiffs.filter((row) => row.aboveBase);
  const structuralAboveBase = rawDiffs.filter((row) => row.aboveStructuralBase);
  const falseParity = acceptanceAboveBase.filter((row) =>
    ['parity', 'locked'].includes(row.parityStatus)
  );

  const productVisualFiles = [
    ...walkFiles(join(CLIENT_ROOT, 'e2e', 'visual')).filter((file) => file.endsWith('.ts')),
    ...walkFiles(join(CLIENT_ROOT, 'src', 'components')).filter(
      (file) =>
        /\.(ts|tsx)$/.test(file) &&
        !/\.test\.(ts|tsx)$/.test(file) &&
        !/\/VisualQA(?:Bootstrap|Components)\.tsx$/.test(file)
    ),
    join(CLIENT_ROOT, 'src', 'App.tsx'),
  ];
  // Test harnesses may seed state and API fixtures, but must never rewrite the
  // product DOM or inject snapshot-only styling. Inspect them separately so
  // ordinary VISUAL_QA setup is not treated as product masking.
  const testHarnessFiles = [
    ...walkFiles(join(CLIENT_ROOT, 'e2e')).filter((file) => file.endsWith('.ts')),
    ...walkFiles(join(CLIENT_ROOT, 'src')).filter((file) => /\.(test|spec)\.(ts|tsx)$/.test(file)),
  ];
  const visualTestRoots = [join(CLIENT_ROOT, 'e2e', 'visual'), join(CLIENT_ROOT, 'e2e', 'helpers')];
  const patchPatterns = [
    'addStyleTag',
    'isVisualQA()',
    'getVisualScenario()',
    'VISUAL_QA',
    'docs/design/figma',
    '/figma-refs/',
  ];
  const exceptionRegistry = JSON.parse(readFileSync(VISUAL_QA_EXCEPTIONS_PATH, 'utf8'));
  const allowedExceptionCategories = new Set(exceptionRegistry.policy?.allowedCategories ?? []);
  const exceptionBySignal = new Map();
  const exceptionMatchCounts = new Map();
  const referenceImageExceptions = exceptionRegistry.referenceImageExceptions ?? [];
  const referenceImageMatchCounts = new Map();
  const exceptionPolicyErrors = [];
  for (const exception of exceptionRegistry.exceptions ?? []) {
    const key = `${exception.file}\n${exception.source}`;
    if (exceptionBySignal.has(key)) {
      exceptionPolicyErrors.push(
        `Duplicate exception signal: ${exception.file} :: ${exception.source}`
      );
      continue;
    }
    if (!allowedExceptionCategories.has(exception.category)) {
      exceptionPolicyErrors.push(
        `Invalid exception category for ${exception.id}: ${exception.category}`
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.reviewBy ?? '')) {
      exceptionPolicyErrors.push(
        `Invalid reviewBy for ${exception.id}: ${exception.reviewBy ?? 'missing'}`
      );
    } else if (exception.reviewBy < new Date().toISOString().slice(0, 10)) {
      exceptionPolicyErrors.push(
        `Expired Visual QA exception: ${exception.id} (${exception.reviewBy})`
      );
    }
    exceptionBySignal.set(key, exception);
    exceptionMatchCounts.set(exception.id, 0);
  }
  for (const exception of referenceImageExceptions) {
    if (
      !exception.id ||
      !exception.file ||
      !exception.sourceContains ||
      !exception.owner ||
      !exception.reason
    ) {
      exceptionPolicyErrors.push(
        'Reference-image exception is missing id, ownership, or source metadata.'
      );
      continue;
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(exception.reviewBy ?? '') ||
      exception.reviewBy < new Date().toISOString().slice(0, 10)
    ) {
      exceptionPolicyErrors.push(`Invalid or expired reference-image exception: ${exception.id}.`);
    }
    referenceImageMatchCounts.set(exception.id, 0);
  }
  const testPatches = [];
  const testDomRewrites = [];
  const referenceImageSubstitutions = [];
  const visualMaskingSignals = [];
  const inspectedReferenceFiles = new Set();
  for (const file of productVisualFiles) {
    inspectedReferenceFiles.add(file);
    const rel = relative(REPO_ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (
        /(?:src|srcSet)\s*=\s*["'`][^"'`]*\/images\/[^"'`]*figma[^"'`]*(?:static|snapshot|reference)[^"'`]*["'`]/i.test(
          line
        )
      ) {
        const referenceException = referenceImageExceptions.find(
          (exception) => exception.file === rel && line.includes(exception.sourceContains)
        );
        if (referenceException) {
          referenceImageMatchCounts.set(
            referenceException.id,
            (referenceImageMatchCounts.get(referenceException.id) ?? 0) + 1
          );
          visualMaskingSignals.push({
            file: rel,
            line: idx + 1,
            text: line.trim(),
            exceptionId: referenceException.id,
            category: 'intentional-design-deviation',
            rationale: referenceException.reason,
            reviewBy: referenceException.reviewBy,
            allowedByPolicy: true,
          });
        } else {
          referenceImageSubstitutions.push({ file: rel, line: idx + 1, text: line.trim() });
        }
      }
      const screenshotMask =
        visualTestRoots.some((root) => file.startsWith(`${root}/`)) && /\bmask\s*:/.test(line);
      if (!screenshotMask && !patchPatterns.some((pattern) => line.includes(pattern))) return;
      const row = { file: rel, line: idx + 1, text: line.trim() };
      if (row.text.startsWith('//') || row.text.startsWith('*')) return;
      const exception = exceptionBySignal.get(`${rel}\n${row.text}`);
      if (!exception) {
        testPatches.push(row);
        return;
      }
      exceptionMatchCounts.set(exception.id, (exceptionMatchCounts.get(exception.id) ?? 0) + 1);
      visualMaskingSignals.push({
        ...row,
        exceptionId: exception.id,
        category: exception.category,
        rationale: exception.rationale,
        reviewBy: exception.reviewBy,
        allowedByPolicy: true,
      });
    });
  }
  for (const file of testHarnessFiles) {
    if (inspectedReferenceFiles.has(file)) continue;
    const rel = relative(REPO_ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      const text = line.trim();
      if (text.startsWith('//') || text.startsWith('*')) return;
      if (
        /(?:src|srcSet)\s*=\s*["'`][^"'`]*\/images\/[^"'`]*figma[^"'`]*(?:static|snapshot|reference)[^"'`]*["'`]/i.test(
          line
        )
      ) {
        referenceImageSubstitutions.push({ file: rel, line: idx + 1, text });
      }
      const isVisualTestHarness = visualTestRoots.some((root) => file.startsWith(root + '/'));
      const prohibitedTestMutation =
        isVisualTestHarness &&
        (exceptionRegistry.policy?.prohibitedTestDomMutations ?? []).some((pattern) =>
          line.includes(pattern)
        );
      if (
        prohibitedTestMutation ||
        (exceptionRegistry.policy?.prohibitedDomPatches ?? []).some((pattern) =>
          line.includes(pattern)
        )
      ) {
        testDomRewrites.push({ file: rel, line: idx + 1, text });
      }
    });
  }
  for (const exception of exceptionRegistry.exceptions ?? []) {
    const actual = exceptionMatchCounts.get(exception.id) ?? 0;
    const expected = exception.expectedMatches ?? 1;
    if (actual !== expected) {
      exceptionPolicyErrors.push(
        `Exception ${exception.id} expected ${expected} signal match(es), found ${actual}.`
      );
    }
  }
  for (const exception of referenceImageExceptions) {
    const actual = referenceImageMatchCounts.get(exception.id) ?? 0;
    const expected = exception.expectedMatches ?? 1;
    if (actual !== expected) {
      exceptionPolicyErrors.push(
        `Reference-image exception ${exception.id} matched ${actual} source line(s); expected ${expected}.`
      );
    }
  }

  const targetOwnedMasking = [];
  let targetMaskingAudit = null;
  // A focused measurement is still review evidence. Scan the same complete
  // target closure as signoff; only the pixel-threshold claim differs by mode.
  if (filters.id && items.length === 1 && ['report', 'signoff'].includes(filters.mode)) {
    const targetFiles = targetDependencyFiles({
      item: items[0],
      dependencyGraph,
      screenRegistry,
    });
    const targetScanFiles = new Set(targetFiles);
    targetScanFiles.add('client/playwright.config.ts');
    for (const helperFile of walkFiles(join(CLIENT_ROOT, 'e2e', 'helpers'))) {
      if (/\.[cm]?[jt]sx?$/.test(helperFile)) {
        targetScanFiles.add(relative(REPO_ROOT, helperFile));
      }
    }
    targetMaskingAudit = auditTargetMaskingFiles({
      repoRoot: REPO_ROOT,
      files: targetScanFiles,
      exceptionRegistry,
    });
    const targetFindingKeys = new Set();
    const targetScannedLocations = new Set();
    const appendTargetFinding = (finding, fromTargetScan = false) => {
      const location = `${finding.file}\n${finding.line}\n${finding.text}`;
      if (!fromTargetScan && targetScannedLocations.has(location)) return;
      if (fromTargetScan) targetScannedLocations.add(location);
      const key = `${finding.kind}\n${location}`;
      if (targetFindingKeys.has(key)) return;
      targetFindingKeys.add(key);
      targetOwnedMasking.push(finding);
    };
    for (const finding of targetMaskingAudit.findings) appendTargetFinding(finding, true);
    for (const [kind, findings] of [
      ['test-patch', testPatches],
      ['test-dom-rewrite', testDomRewrites],
      ['reference-image-substitution', referenceImageSubstitutions],
      ['visual-masking-exception', visualMaskingSignals],
    ]) {
      for (const finding of findings) {
        if (findingBelongsToTarget(finding, targetFiles)) {
          appendTargetFinding({ kind, ...finding });
        }
      }
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    filters,
    focused,
    counts: {
      registryItems: items.length,
      totalRegistryItems: allItems.length,
      contradictoryParity: contradictoryParity.length,
      looseThresholds: looseThresholds.length,
      snapshotMissing: snapshotMissing.length,
      registeredUnmapped: registeredUnmapped.length,
      rawDiffs: rawDiffs.length,
      rawAboveBase: rawAboveBase.length,
      acceptanceAboveBase: acceptanceAboveBase.length,
      structuralAboveBase: structuralAboveBase.length,
      dimensionMismatches: rawDiffs.filter((row) => row.dimensionMismatch).length,
      falseParity: falseParity.length,
      testPatchSignals: testPatches.length,
      testDomRewrites: testDomRewrites.length,
      referenceImageSubstitutions: referenceImageSubstitutions.length,
      visualMaskingSignals: visualMaskingSignals.length,
      targetMaskingFiles: targetMaskingAudit?.inspectedFiles.length ?? 0,
      targetOwnedMasking: targetOwnedMasking.length,
      exceptionPolicyErrors: exceptionPolicyErrors.length,
    },
    contradictoryParity: contradictoryParity.map((item) => ({
      id: item.id,
      status: item.status,
      notes: item.notes ?? '',
    })),
    looseThresholds: looseThresholds.map(({ item, crop, base, allowed }) => ({
      id: crop ? `${item.id}/${crop.id}` : item.id,
      kind: item.kind,
      baseThreshold: base,
      itemThreshold: allowed,
    })),
    snapshotMissing: snapshotMissing.map((item) => item.id),
    registeredUnmapped: registeredUnmapped.map((item) => ({
      id: item.id,
      referencePath: item.referencePath,
      notes: item.notes ?? '',
    })),
    rawDiffs,
    falseParity: falseParity.map((row) => ({
      id: row.id,
      status: row.status,
      ratio: row.ratio,
      acceptanceRatio: row.acceptanceRatio,
      acceptanceMetric: row.acceptanceMetric,
      baseThreshold: row.baseThreshold,
      referencePath: row.referencePath,
      snapshotPath: row.snapshotPath,
    })),
    testPatches,
    testDomRewrites,
    referenceImageSubstitutions,
    visualMaskingSignals,
    targetMaskingAudit: targetMaskingAudit
      ? { inspectedFiles: targetMaskingAudit.inspectedFiles }
      : null,
    targetOwnedMasking,
    exceptionPolicyErrors,
  };

  ensureDir(OUT_DIR);
  writeFileAtomic(OUT_JSON, JSON.stringify(result, null, 2) + '\n');

  const md = `# Strict Figma Audit

Generated: ${result.generatedAt}
${focused ? `\nFocused filters: ${JSON.stringify(filters)}\n` : ''}
## Counts

- Registry items: ${result.counts.registryItems}${focused ? `/${result.counts.totalRegistryItems}` : ''}
- figma_parity items with contradictory notes: ${result.counts.contradictoryParity}
- Items with thresholds looser than global policy: ${result.counts.looseThresholds}
- Missing snapshots: ${result.counts.snapshotMissing}
- Registered unmapped Figma surfaces: ${result.counts.registeredUnmapped}
- Raw diagnostic diffs above base threshold: ${result.counts.rawAboveBase}/${result.counts.rawDiffs}
- Canonical parity diffs above base threshold: ${result.counts.acceptanceAboveBase}/${result.counts.rawDiffs}
- Structural edge diffs above base threshold: ${result.counts.structuralAboveBase}/${result.counts.rawDiffs}
- Dimension mismatches: ${result.counts.dimensionMismatches}
- False parity claims: ${result.counts.falseParity}
- Test patch signals: ${result.counts.testPatchSignals}
- Test DOM rewrites: ${result.counts.testDomRewrites}
- Figma reference image substitutions: ${result.counts.referenceImageSubstitutions}
- Allowed app-side Visual QA masking signals: ${result.counts.visualMaskingSignals}
- Target closure files scanned: ${result.counts.targetMaskingFiles}
- Target-owned masking signals: ${result.counts.targetOwnedMasking}
- Visual QA exception policy errors: ${result.counts.exceptionPolicyErrors}

## Contradictory figma_parity Items

${lineList(result.contradictoryParity, (row) => `- ${row.id}: ${row.notes}`)}
## Loose Thresholds

${lineList(result.looseThresholds, (row) => `- ${row.id}: ${row.itemThreshold} > ${row.baseThreshold}`)}
## Top Raw Diffs

${lineList(
  rawDiffs.slice(0, 40),
  (row) => {
    if (row.dimensionMismatch) {
      return `- DIMENSION MISMATCH ${row.id}: Figma ${row.width}x${row.height}, snapshot ${row.snapshotWidth}x${row.snapshotHeight}`;
    }
    let line = `- ${(row.ratio * 100).toFixed(2)}% ${row.id} (base ${(row.baseThreshold * 100).toFixed(2)}%, item ${(row.itemThreshold * 100).toFixed(2)}%)`;
    if (row.crops && row.crops.length > 0) {
      row.crops.forEach((c) => {
        if (c.error) {
          line += `\n  - [Crop Error] ${c.id}: ${c.error}`;
        } else {
          line += `\n  - [Crop] ${c.id}: ${(c.ratio * 100).toFixed(2)}% (threshold ${(c.threshold * 100).toFixed(2)}%${c.aboveThreshold ? ' ❌' : ' ✓'})`;
        }
      });
    }
    return line;
  },
  40
)}
## False Parity Claims

${lineList(result.falseParity, (row) => `- ${row.id}: ${(row.ratio * 100).toFixed(2)}% > ${(row.baseThreshold * 100).toFixed(2)}% (${row.status})`)}
## Registered Unmapped Surfaces

${lineList(result.registeredUnmapped, (row) => `- ${row.id}: ${row.referencePath}`)}
## Test Patch Signals

${lineList(testPatches, (row) => `- ${row.file}:${row.line} ${row.text}`)}
## Test DOM Rewrites

${lineList(testDomRewrites, (row) => `- ${row.file}:${row.line} ${row.text}`)}
## Figma Reference Image Substitutions

${lineList(referenceImageSubstitutions, (row) => `- ${row.file}:${row.line} ${row.text}`)}
## Allowed App-Side Visual QA Masking Signals

${lineList(visualMaskingSignals, (row) => `- ${row.file}:${row.line} ${row.text}`)}
## Visual QA Exception Policy Errors

${lineList(exceptionPolicyErrors, (message) => `- ${message}`)}
## Target-Owned Signoff Masking

${lineList(targetOwnedMasking, (row) => `- ${row.kind}: ${row.file}:${row.line} ${row.text}`)}
`;

  writeFileAtomic(OUT_MD, md);

  console.log('\n── Strict Figma Audit ────────────────────────────────────────────\n');
  console.log(
    `  Registry items:                     ${result.counts.registryItems}${focused ? `/${result.counts.totalRegistryItems}` : ''}`
  );
  console.log(`  Contradictory figma_parity notes:    ${result.counts.contradictoryParity}`);
  console.log(`  Loose thresholds:                    ${result.counts.looseThresholds}`);
  console.log(`  Missing snapshots:                   ${result.counts.snapshotMissing}`);
  console.log(`  Registered unmapped surfaces:        ${result.counts.registeredUnmapped}`);
  console.log(
    `  Raw diagnostic diffs above base:     ${result.counts.rawAboveBase}/${result.counts.rawDiffs}`
  );
  console.log(
    `  Canonical parity diffs above base:    ${result.counts.acceptanceAboveBase}/${result.counts.rawDiffs}`
  );
  console.log(
    `  Structural edge diffs above base:    ${result.counts.structuralAboveBase}/${result.counts.rawDiffs}`
  );
  console.log(`  Dimension mismatches:                 ${result.counts.dimensionMismatches}`);
  console.log(`  False parity claims:                 ${result.counts.falseParity}`);
  console.log(`  Test patch signals:                  ${result.counts.testPatchSignals}`);
  console.log(`  Test DOM rewrites:                   ${result.counts.testDomRewrites}`);
  console.log(
    `  Figma reference image substitutions: ${result.counts.referenceImageSubstitutions}`
  );
  console.log(`  Allowed Visual QA masking signals:   ${result.counts.visualMaskingSignals}`);
  console.log(`  Target closure files scanned:        ${result.counts.targetMaskingFiles}`);
  console.log(`  Target-owned masking signals:        ${result.counts.targetOwnedMasking}`);
  console.log(`  Visual QA exception policy errors:   ${result.counts.exceptionPolicyErrors}`);
  console.log(`  Mode:                                ${filters.mode}`);
  console.log(`\nReports:\n  ${OUT_MD}\n  ${OUT_JSON}\n`);

  const targetContractIssues =
    result.counts.contradictoryParity > 0 ||
    result.counts.looseThresholds > 0 ||
    result.counts.snapshotMissing > 0 ||
    result.counts.falseParity > 0;
  const globalGovernanceIssues =
    targetContractIssues ||
    result.counts.testPatchSignals > 0 ||
    result.counts.testDomRewrites > 0 ||
    result.counts.referenceImageSubstitutions > 0 ||
    result.counts.exceptionPolicyErrors > 0;
  const signoffIssues =
    result.counts.acceptanceAboveBase > 0 || result.counts.targetOwnedMasking > 0;
  const hasBlockingIssues =
    filters.mode === 'report'
      ? false
      : filters.mode === 'governance' || filters.mode === 'ci'
        ? globalGovernanceIssues
        : targetContractIssues || signoffIssues;

  if (hasBlockingIssues) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
