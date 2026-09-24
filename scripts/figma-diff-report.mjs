#!/usr/bin/env node
/**
 * Generates a 3-way visual diff report comparing each registry item's:
 *   1. Figma reference (from `referencePath`)
 *   2. Current Playwright snapshot
 *   3. Pixel-highlighted, dimension-preserving perceptual diff between the two
 *
 * Optional per-item `crops` in the registry produce additional detail rows from
 * the exact full comparison, e.g.:
 *   "crops": [{ "id": "chat-input", "x": 360, "y": 820, "width": 720, "height": 160 }]
 *
 * Outputs:
 *   client/e2e/figma-diff-report/diffs/<id>-diff.png   (per item)
 *   client/e2e/figma-diff-report/index.html            (self-contained sortable summary)
 *
 * Usage:
 *   cd client && npm run figma:diff -- --id <registry-id>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { basename, resolve, dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import {
  REFERENCE_RUNS_ROOT,
  pathIsWithin,
  resolveManifestArtifact,
} from './lib/figma-reference-run.mjs';

import { getFigmoonConfig } from '../lib/config.mjs';
const __figmoonConfig = getFigmoonConfig();
const REPO_ROOT = __figmoonConfig.consumerRoot;
const CLIENT_ROOT = __figmoonConfig.clientRoot;
const REGISTRY_PATH = __figmoonConfig.registryPath;
const MANIFEST_PATH = __figmoonConfig.manifestPath;
let SNAPSHOT_ROOT = __figmoonConfig.snapshotRoot;
let SNAPSHOT_ROOT_OVERRIDDEN = false;
let REPORT_ROOT = __figmoonConfig.diffReportRoot;
let DIFFS_DIR = join(REPORT_ROOT, 'diffs');
let FIGMA_DIR = join(REPORT_ROOT, 'figma');
let SNAPS_DIR = join(REPORT_ROOT, 'snapshots');
let REFERENCE_OVERRIDE = null;
let MANIFEST_BY_REFERENCE = new Map();

const THRESHOLDS = { parityPage: 0.005, parityComponent: 0.002, minor: 0.05 };
const PIXELMATCH_THRESHOLD = 0.1;

const SNAPSHOT_HINTS = {
  // Mobile spec lives at e2e/visual/mobile.spec.ts → snapshots under mobile.spec.ts
  mobile: 'mobile/visual/mobile.spec.ts',
  desktop: 'desktop/visual/pages.spec.ts',
  component: 'desktop/visual/components.spec.ts',
  'tablet-landscape': 'tablet-landscape/visual/tablet.spec.ts',
  'tablet-portrait': 'tablet-portrait/visual/tablet.spec.ts',
};

function classify(ratio, parityThreshold = THRESHOLDS.parityPage, parityStatus = 'drifting') {
  if (['parity', 'locked'].includes(parityStatus) && ratio >= parityThreshold) {
    return { label: '❌ false_parity_claim', cls: 'major' };
  }
  if (ratio < parityThreshold) return { label: '🔎 perceptual_match', cls: 'ok' };
  if (ratio < THRESHOLDS.minor) return { label: '⚠️ perceptual_drift', cls: 'minor' };
  return { label: '❌ perceptual_major_drift', cls: 'major' };
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveClientPath(value, flag) {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path.`);
  return resolve(CLIENT_ROOT, value);
}

function parseArgs(argv) {
  const filters = { id: null, crop: null, snapshotRoot: null, outDir: null, referencePath: null };
  let idCount = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--id') {
      idCount += 1;
      filters.id = argv[++i] ?? null;
    } else if (arg.startsWith('--id=')) {
      idCount += 1;
      filters.id = arg.slice('--id='.length);
    } else if (arg === '--crop') filters.crop = argv[++i] ?? null;
    else if (arg.startsWith('--crop=')) filters.crop = arg.slice('--crop='.length);
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
    else throw new Error(`Unsupported figma:diff argument: ${arg}`);
  }
  if (idCount !== 1 || !filters.id || filters.id.startsWith('--')) {
    throw new Error(
      'figma:diff requires exactly one --id <registry-id>; broad and grep-based reports are prohibited.'
    );
  }
  return filters;
}

function itemMatchesFilters(item, filters) {
  if (item.id !== filters.id) return false;
  if (filters.crop && !item.crops?.some((crop) => String(crop.id) === filters.crop)) return false;
  return true;
}

function focusedSlug(filters) {
  const parts = [];
  if (filters.id) parts.push(filters.id);
  if (filters.crop) parts.push(filters.crop);
  return (
    parts
      .join('--')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || null
  );
}

async function svgDiagnostics(figmaAbs) {
  if (!figmaAbs.toLowerCase().endsWith('.png')) return null;
  const svgAbs = figmaAbs.replace(/\.png$/i, '.svg');
  if (!existsSync(svgAbs)) return null;

  const [pngMeta, svgMeta] = await Promise.all([
    sharp(figmaAbs).metadata(),
    sharp(svgAbs).metadata(),
  ]);
  const diag = {
    svgPath: relative(REPO_ROOT, svgAbs),
    pngDimensions: `${pngMeta.width ?? '?'}×${pngMeta.height ?? '?'}`,
    svgDimensions: `${svgMeta.width ?? '?'}×${svgMeta.height ?? '?'}`,
    dimensionsMatch: pngMeta.width === svgMeta.width && pngMeta.height === svgMeta.height,
    rasterDiffRatio: null,
    error: null,
  };

  if (
    !pngMeta.width ||
    !pngMeta.height ||
    !svgMeta.width ||
    !svgMeta.height ||
    !diag.dimensionsMatch
  ) {
    return diag;
  }

  try {
    const [png, svg] = await Promise.all([
      loadAndNormalize(figmaAbs, pngMeta.width, pngMeta.height),
      loadAndNormalize(svgAbs, pngMeta.width, pngMeta.height),
    ]);
    const diff = new PNG({ width: pngMeta.width, height: pngMeta.height });
    const mismatched = pixelmatch(png.data, svg.data, diff.data, pngMeta.width, pngMeta.height, {
      threshold: PIXELMATCH_THRESHOLD,
      includeAA: true,
    });
    diag.rasterDiffRatio = mismatched / (pngMeta.width * pngMeta.height);
  } catch (error) {
    diag.error = error.message;
  }

  return diag;
}

async function loadAndNormalize(absPath, targetW, targetH) {
  // Rasterize at the source's exact dimensions. Callers reject dimension mismatches first.
  const buffer = await sharp(absPath)
    .resize(targetW, targetH, { fit: 'fill' })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();
  return PNG.sync.read(buffer);
}

async function alphaDiagnostics(absPath, width, height) {
  const { data, info } = await sharp(absPath)
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let transparent = 0;
  let translucent = 0;
  for (let offset = 3; offset < data.length; offset += info.channels) {
    if (data[offset] === 0) transparent++;
    else if (data[offset] < 255) translucent++;
  }
  const pixels = width * height;
  return {
    transparentRatio: transparent / pixels,
    translucentRatio: translucent / pixels,
  };
}

function findSnapshot(item) {
  if (item.snapshot) {
    const relativeSnapshot = item.snapshot
      .replace(/^client\/e2e\/visual-snapshots\//, '')
      .replace(/^e2e\/visual-snapshots\//, '');
    const explicit = join(SNAPSHOT_ROOT, relativeSnapshot);
    if (existsSync(explicit)) return explicit;
    // An isolated capture must never silently compare the canonical baseline.
    if (SNAPSHOT_ROOT_OVERRIDDEN) return null;
  }
  // Snapshot path: e2e/visual-snapshots/{viewport}/visual/{spec}/{id}.png
  const hint = item.kind === 'component' ? SNAPSHOT_HINTS.component : SNAPSHOT_HINTS[item.viewport];
  if (!hint) return null;
  // Try standard path
  const candidate = join(SNAPSHOT_ROOT, hint, `${item.id}.png`);
  if (existsSync(candidate)) return candidate;

  const stack = [SNAPSHOT_ROOT];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !existsSync(current)) continue;
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
      } else if (entry === `${item.id}.png`) {
        return full;
      }
    }
  }
  return null;
}

function comparePngs(figmaPng, snapPng, width, height) {
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(figmaPng.data, snapPng.data, diff.data, width, height, {
    threshold: PIXELMATCH_THRESHOLD,
    includeAA: true,
  });
  return {
    mismatched,
    totalPixels: width * height,
    ratio: mismatched / (width * height),
    dy: 0,
    figma: figmaPng,
    snapshot: snapPng,
    diff,
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

function pngDataUri(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function writeComparisonArtifacts(id, comparison) {
  ensureDir(DIFFS_DIR);
  ensureDir(FIGMA_DIR);
  ensureDir(SNAPS_DIR);

  const diffOut = join(DIFFS_DIR, `${id}-diff.png`);
  const figmaOut = join(FIGMA_DIR, `${id}.png`);
  const snapOut = join(SNAPS_DIR, `${id}.png`);
  // Sidecars and the signed review HTML must represent the exact same bytes.
  const diffBytes = PNG.sync.write(colorizeDiff(comparison));
  const figmaBytes = PNG.sync.write(comparison.figma);
  const snapshotBytes = PNG.sync.write(comparison.snapshot);
  writeFileSync(diffOut, diffBytes);
  writeFileSync(figmaOut, figmaBytes);
  writeFileSync(snapOut, snapshotBytes);
  return {
    diffPath: relative(REPORT_ROOT, diffOut),
    figmaThumb: relative(REPORT_ROOT, figmaOut),
    snapshotThumb: relative(REPORT_ROOT, snapOut),
    diffImageSrc: pngDataUri(diffBytes),
    figmaImageSrc: pngDataUri(figmaBytes),
    snapshotImageSrc: pngDataUri(snapshotBytes),
  };
}

// Keep mismatch pixels visually distinct by surface family. The pixel count is
// unchanged; only the overlay hue changes so adjacent diff images are easier
// to scan without mistaking every issue for the same source.
function colorizeDiff(comparison) {
  const { diff, figma, snapshot } = comparison;
  const out = new PNG({ width: diff.width, height: diff.height });
  // Keep matching pixels neutral so the issue colors remain legible across
  // large backgrounds. Pixelmatch writes a purple diff canvas for matches;
  // that is useful for its native view but obscures the directional overlay.
  out.data.fill(255);
  for (let i = 0; i < out.data.length; i += 4) {
    if (
      diff.data[i + 3] === 0 ||
      (diff.data[i] === 255 && diff.data[i + 1] === 255 && diff.data[i + 2] === 255) ||
      (diff.data[i] === 0 && diff.data[i + 1] === 255 && diff.data[i + 2] === 0)
    )
      continue;
    const figmaLight = isNearWhite(figma.data, i);
    const snapshotLight = isNearWhite(snapshot.data, i);
    const color =
      figmaLight && !snapshotLight
        ? [0, 82, 255] // current-only: blue
        : !figmaLight && snapshotLight
          ? [255, 0, 48] // Figma-only: red
          : [0, 170, 55]; // both present, but different: green
    out.data[i] = color[0];
    out.data[i + 1] = color[1];
    out.data[i + 2] = color[2];
  }
  return out;
}

function isNearWhite(data, index) {
  return (
    data[index + 3] === 0 || (data[index] > 245 && data[index + 1] > 245 && data[index + 2] > 245)
  );
}

function processCrop(item, crop, figmaAligned, snapAligned) {
  const cropId = String(crop.id ?? `crop-${item.crops.indexOf(crop) + 1}`);
  const artifactId = `${item.id}--${cropId}`;
  const out = {
    id: cropId,
    artifactId,
    parentId: item.id,
    title: crop.title ?? cropId,
    viewport: item.viewport,
    ratio: null,
    classification: null,
    figmaThumb: null,
    snapshotThumb: null,
    diffPath: null,
    figmaImageSrc: null,
    snapshotImageSrc: null,
    diffImageSrc: null,
    error: null,
    crop: null,
    dy: null,
  };

  try {
    const normalizedCrop = normalizeCrop(crop, figmaAligned.width, figmaAligned.height);
    const figmaCrop = cropPng(figmaAligned, normalizedCrop);
    const snapCrop = cropPng(snapAligned, normalizedCrop);
    const comparison = comparePngs(
      figmaCrop,
      snapCrop,
      normalizedCrop.width,
      normalizedCrop.height
    );
    const artifacts = writeComparisonArtifacts(artifactId, comparison);
    out.crop = normalizedCrop;
    out.dy = comparison.dy;
    out.ratio = comparison.ratio;
    out.classification = classify(
      out.ratio,
      crop.maxDiffPixelRatio ?? item.maxDiffPixelRatio ?? baseThreshold(item),
      item.parityStatus
    );
    out.figmaThumb = artifacts.figmaThumb;
    out.snapshotThumb = artifacts.snapshotThumb;
    out.diffPath = artifacts.diffPath;
    out.figmaImageSrc = artifacts.figmaImageSrc;
    out.snapshotImageSrc = artifacts.snapshotImageSrc;
    out.diffImageSrc = artifacts.diffImageSrc;
  } catch (e) {
    out.error = e.message;
    out.classification = { label: '❌ crop_error', cls: 'major' };
  }

  return out;
}

async function processItem(item, filters = {}) {
  const out = {
    id: item.id,
    title: item.title,
    viewport: item.viewport,
    status: item.status,
    parityStatus: item.parityStatus,
    referencePath: item.referencePath,
    snapshotPath: null,
    diffPath: null,
    figmaThumb: null,
    snapshotThumb: null,
    diffImageSrc: null,
    figmaImageSrc: null,
    snapshotImageSrc: null,
    ratio: null,
    classification: null,
    error: null,
    notes: item.notes ?? '',
    dy: null,
    dims: null,
    crops: [],
    svgDiagnostics: null,
    alphaDiagnostics: null,
  };

  if (item.parityStatus === 'waived' || !item.referencePath) {
    out.error = 'waived';
    out.classification = { label: '⚪ waived', cls: 'waived' };
    return out;
  }

  const manifestEntry = MANIFEST_BY_REFERENCE.get(item.referencePath);
  const figmaAbs =
    REFERENCE_OVERRIDE ??
    resolveManifestArtifact(manifestEntry ?? { referencePath: item.referencePath });
  out.resolvedReferencePath = relative(REPO_ROOT, figmaAbs);
  const snapAbs = findSnapshot(item);
  if (!existsSync(figmaAbs)) {
    out.error = 'figma_missing';
    out.classification = { label: '❌ figma_missing', cls: 'major' };
    return out;
  }
  if (!snapAbs) {
    out.error = 'snapshot_missing';
    out.classification = { label: '⚠️ snapshot_missing', cls: 'minor' };
    return out;
  }
  out.snapshotPath = snapAbs;

  const [figmaMeta, snapshotMeta] = await Promise.all([
    sharp(figmaAbs).metadata(),
    sharp(snapAbs).metadata(),
  ]);
  out.dims = {
    figma: `${figmaMeta.width ?? '?'}×${figmaMeta.height ?? '?'}`,
    snapshot: `${snapshotMeta.width ?? '?'}×${snapshotMeta.height ?? '?'}`,
  };
  out.svgDiagnostics = await svgDiagnostics(figmaAbs);

  if (
    !figmaMeta.width ||
    !figmaMeta.height ||
    !snapshotMeta.width ||
    !snapshotMeta.height ||
    figmaMeta.width !== snapshotMeta.width ||
    figmaMeta.height !== snapshotMeta.height
  ) {
    out.error = `dimension_mismatch: Figma ${out.dims.figma}, snapshot ${out.dims.snapshot}`;
    out.classification = { label: '❌ dimension_mismatch', cls: 'major' };
    return out;
  }

  const dims = { w: figmaMeta.width, h: figmaMeta.height };

  try {
    const [figma, snapshot] = await Promise.all([
      alphaDiagnostics(figmaAbs, dims.w, dims.h),
      alphaDiagnostics(snapAbs, dims.w, dims.h),
    ]);
    out.alphaDiagnostics = { figma, snapshot };
  } catch (error) {
    out.alphaDiagnostics = { error: error instanceof Error ? error.message : String(error) };
  }

  let figmaPng, snapPng;
  try {
    [figmaPng, snapPng] = await Promise.all([
      loadAndNormalize(figmaAbs, dims.w, dims.h),
      loadAndNormalize(snapAbs, dims.w, dims.h),
    ]);
  } catch (e) {
    out.error = `load_error: ${e.message}`;
    out.classification = { label: '❌ load_error', cls: 'major' };
    return out;
  }

  const comparison = comparePngs(figmaPng, snapPng, dims.w, dims.h);
  out.ratio = comparison.ratio;
  out.dy = comparison.dy;
  out.classification = classify(
    out.ratio,
    item.maxDiffPixelRatio ?? baseThreshold(item),
    item.parityStatus
  );

  const artifacts = writeComparisonArtifacts(item.id, comparison);
  out.diffPath = artifacts.diffPath;
  out.figmaThumb = artifacts.figmaThumb;
  out.snapshotThumb = artifacts.snapshotThumb;
  out.diffImageSrc = artifacts.diffImageSrc;
  out.figmaImageSrc = artifacts.figmaImageSrc;
  out.snapshotImageSrc = artifacts.snapshotImageSrc;

  if (Array.isArray(item.crops) && item.crops.length > 0) {
    const crops = filters.crop
      ? item.crops.filter((crop) => String(crop.id) === filters.crop)
      : item.crops;
    out.crops = crops.map((crop) => processCrop(item, crop, comparison.figma, comparison.snapshot));
  }

  return out;
}

function baseThreshold(item) {
  return item.kind === 'component' ? THRESHOLDS.parityComponent : THRESHOLDS.parityPage;
}

function renderThumbs(r) {
  const figma = r.figmaImageSrc
    ? `<figure><img src="${escapeHtml(r.figmaImageSrc)}" alt="" loading="lazy"/><figcaption>Figma</figcaption></figure>`
    : '<em>—</em>';
  const snap = r.snapshotImageSrc
    ? `<figure><img src="${escapeHtml(r.snapshotImageSrc)}" alt="" loading="lazy"/><figcaption>Current</figcaption></figure>`
    : '<em>—</em>';
  const diffImg = r.diffImageSrc
    ? `<figure><img src="${escapeHtml(r.diffImageSrc)}" alt="" loading="lazy"/><figcaption>Diff</figcaption></figure>`
    : '<em>—</em>';
  return { figma, snap, diffImg };
}

function renderRow(r, { crop = false } = {}) {
  const drift = r.ratio == null ? '—' : (r.ratio * 100).toFixed(3) + '%';
  const { figma, snap, diffImg } = renderThumbs(r);
  const err = r.error ? `<div class="err">${escapeHtml(r.error)}</div>` : '';
  const cropMeta = r.crop
    ? `<div class="crop-meta">${r.crop.x},${r.crop.y} · ${r.crop.width}×${r.crop.height}</div>`
    : '';
  const dyMeta = r.dy != null ? `<div class="crop-meta">best dy: ${r.dy}px</div>` : '';
  const cropBadge =
    !crop && r.crops?.length ? `<span class="crop-badge">${r.crops.length} crops</span>` : '';
  const svgMeta =
    !crop && r.svgDiagnostics
      ? `<div class="crop-meta">SVG: ${escapeHtml(r.svgDiagnostics.svgDimensions)} vs PNG ${escapeHtml(r.svgDiagnostics.pngDimensions)}${r.svgDiagnostics.dimensionsMatch ? ' · dimensions match' : ' · dimensions differ'}${r.svgDiagnostics.rasterDiffRatio == null ? '' : ` · raster diff ${(r.svgDiagnostics.rasterDiffRatio * 100).toFixed(3)}%`}${r.svgDiagnostics.error ? ` · ${escapeHtml(r.svgDiagnostics.error)}` : ''}</div>`
      : '';
  const alpha =
    !crop && r.alphaDiagnostics && !r.alphaDiagnostics.error
      ? `<div class="crop-meta">alpha: Figma ${(r.alphaDiagnostics.figma.transparentRatio * 100).toFixed(2)}% transparent, ${(r.alphaDiagnostics.figma.translucentRatio * 100).toFixed(2)}% translucent · snapshot ${(r.alphaDiagnostics.snapshot.transparentRatio * 100).toFixed(2)}% transparent, ${(r.alphaDiagnostics.snapshot.translucentRatio * 100).toFixed(2)}% translucent</div>`
      : !crop && r.alphaDiagnostics?.error
        ? `<div class="crop-meta">alpha diagnostic: ${escapeHtml(r.alphaDiagnostics.error)}</div>`
        : '';
  return `<tr class="${crop ? 'crop-row' : ''}">
  <td>
    <div class="id">${crop ? '↳ ' : ''}${escapeHtml(crop ? `${r.parentId} / ${r.id}` : r.id)} ${cropBadge}</div>
    <div class="title">${escapeHtml(r.title ?? '')}</div>
    ${cropMeta}${dyMeta}${svgMeta}${alpha}${err}
  </td>
  <td><span class="vp">${escapeHtml(crop ? 'crop' : r.viewport)}</span></td>
  <td>${figma}</td>
  <td>${snap}</td>
  <td>${diffImg}</td>
  <td class="ratio ${r.classification.cls}">${drift}</td>
  <td class="classification ${r.classification.cls}">${escapeHtml(r.classification.label)}</td>
</tr>`;
}

function renderHtml(rows) {
  const counts = rows.reduce(
    (acc, r) => {
      acc[r.classification.cls] = (acc[r.classification.cls] ?? 0) + 1;
      return acc;
    },
    { ok: 0, minor: 0, major: 0, waived: 0 }
  );
  const cropCounts = rows.reduce(
    (acc, r) => {
      for (const crop of r.crops ?? []) {
        acc.total++;
        acc[crop.classification.cls] = (acc[crop.classification.cls] ?? 0) + 1;
      }
      return acc;
    },
    { total: 0, ok: 0, minor: 0, major: 0, waived: 0 }
  );

  // Sort by drift descending, errors first, then waived last. Crops stay nested under parent rows.
  rows.sort((a, b) => {
    if (a.classification.cls === 'waived' && b.classification.cls !== 'waived') return 1;
    if (b.classification.cls === 'waived' && a.classification.cls !== 'waived') return -1;
    return (b.ratio ?? 1) - (a.ratio ?? 1);
  });

  const generatedAt = new Date().toISOString();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Figma Dimension-Preserving Diff Report — Figmoon</title>
<style>
  :root {
    --bg: #0f172a; --panel: #1e293b; --text: #f1f5f9; --muted: #94a3b8;
    --ok: #16a34a; --minor: #d97706; --major: #dc2626; --waived: #64748b;
    --border: #334155; --crop: #38bdf8;
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font: 13px/1.4 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 24px; }
  .summary { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .pill { padding: 8px 16px; border-radius: 8px; background: var(--panel); border: 1px solid var(--border); }
  .pill .n { font-size: 22px; font-weight: 700; display: block; }
  .pill.ok .n { color: var(--ok); }
  .pill.minor .n { color: var(--minor); }
  .pill.major .n { color: var(--major); }
  .pill.waived .n { color: var(--waived); }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  th, td { padding: 12px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { background: rgba(255,255,255,.03); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
  tr:last-child td { border-bottom: none; }
  tr.crop-row td { background: rgba(56, 189, 248, 0.045); border-bottom-color: rgba(56, 189, 248, 0.18); }
  tr.crop-row .id { color: var(--crop); }
  td.ratio { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; font-weight: 600; }
  td.classification { font-weight: 600; }
  .ok { color: var(--ok); }
  .minor { color: var(--minor); }
  .major { color: var(--major); }
  .waived { color: var(--waived); }
  .thumbs { display: flex; gap: 8px; }
  .thumbs figure { margin: 0; flex: 1; }
  .thumbs figcaption { font-size: 10px; color: var(--muted); text-align: center; margin-top: 4px; }
  .thumbs img { width: 100%; max-width: 320px; height: auto; display: block; border: 1px solid var(--border); border-radius: 4px; cursor: zoom-in; transition: transform .2s; }
  .thumbs img:hover { transform: scale(1.5); position: relative; z-index: 100; }
  .id { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }
  .title, .crop-meta { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .crop-badge { display: inline-block; margin-left: 6px; padding: 1px 5px; border-radius: 999px; background: rgba(56,189,248,.12); color: var(--crop); font-size: 10px; }
  .vp { display: inline-block; padding: 2px 6px; border-radius: 3px; background: var(--bg); font-size: 10px; text-transform: uppercase; }
  .err { color: var(--major); font-size: 11px; }
  .legend { font-size: 11px; color: var(--muted); margin-top: 16px; }
  .legend code { background: var(--panel); padding: 2px 4px; border-radius: 3px; }
</style>
</head>
<body>
<h1>Figma Dimension-Preserving Diff Report</h1>
<div class="meta">Generated ${generatedAt} · No resizing, crop-fit, vertical alignment, or border masking is applied. The ratio uses Pixelmatch's perceptual threshold ${PIXELMATCH_THRESHOLD}; direct source/pixel evidence is still required for tiny palette or antialiasing adjustments. Dimension mismatches are blocking comparison errors.</div>

<div class="summary">
  <div class="pill ok"><span class="n">${counts.ok}</span> perceptual matches</div>
  <div class="pill minor"><span class="n">${counts.minor}</span> perceptual drift</div>
  <div class="pill major"><span class="n">${counts.major}</span> perceptual major drift / errors</div>
  <div class="pill waived"><span class="n">${counts.waived}</span> waived</div>
  <div class="pill"><span class="n">${cropCounts.total}</span> crop diagnostics (${cropCounts.ok} ok / ${cropCounts.minor} minor / ${cropCounts.major} major)</div>
</div>

<table>
<thead>
<tr>
  <th>ID / Title</th>
  <th>Viewport</th>
  <th>Figma</th>
  <th>Current</th>
  <th>Diff</th>
  <th>Drift</th>
  <th>Status</th>
</tr>
</thead>
<tbody>
${rows
  .map((r) =>
    [renderRow(r), ...(r.crops ?? []).map((crop) => renderRow(crop, { crop: true }))].join('\n')
  )
  .join('\n')}
</tbody>
</table>

<p class="legend">
  Hover any thumbnail to zoom · Diff highlights pixel mismatches in red ·
  Use this report to locate drift quickly. Promotion still requires a targeted
  strict sign-off bound to one registry item and durable Figma node metadata.
</p>

</body>
</html>`;
}

async function main() {
  const filters = parseArgs(process.argv.slice(2));
  if (filters.referencePath) {
    if (
      !pathIsWithin(filters.referencePath, REFERENCE_RUNS_ROOT) ||
      filters.referencePath === REFERENCE_RUNS_ROOT ||
      basename(filters.referencePath) !== 'reference.png'
    ) {
      throw new Error(
        '--reference-path must be an immutable figma-reference-runs/<run-id>/reference.png artifact.'
      );
    }
    if (!existsSync(filters.referencePath))
      throw new Error(`Staged reference does not exist: ${filters.referencePath}`);
    REFERENCE_OVERRIDE = filters.referencePath;
  }
  if (filters.snapshotRoot) {
    SNAPSHOT_ROOT = filters.snapshotRoot;
    SNAPSHOT_ROOT_OVERRIDDEN = true;
  }
  if (filters.outDir) {
    REPORT_ROOT = filters.outDir;
    DIFFS_DIR = join(REPORT_ROOT, 'diffs');
    FIGMA_DIR = join(REPORT_ROOT, 'figma');
    SNAPS_DIR = join(REPORT_ROOT, 'snapshots');
  }
  const slug = focusedSlug(filters);
  if (slug && !filters.outDir) {
    REPORT_ROOT = join(REPORT_ROOT, 'focused', slug);
    DIFFS_DIR = join(REPORT_ROOT, 'diffs');
    FIGMA_DIR = join(REPORT_ROOT, 'figma');
    SNAPS_DIR = join(REPORT_ROOT, 'snapshots');
  }

  ensureDir(DIFFS_DIR);
  ensureDir(FIGMA_DIR);
  ensureDir(SNAPS_DIR);

  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  MANIFEST_BY_REFERENCE = new Map(
    Object.values(manifest.items ?? {}).map((entry) => [entry.referencePath, entry])
  );
  const { items } = registry;
  THRESHOLDS.parityPage = registry._meta.thresholds.figmaParityPage;
  THRESHOLDS.parityComponent = registry._meta.thresholds.figmaParityComponent;
  const selectedItems = items.filter((item) => itemMatchesFilters(item, filters));
  if (selectedItems.length !== 1) {
    throw new Error(`Unknown or non-unique registry id '${filters.id}'.`);
  }
  if (filters.crop && !selectedItems[0].crops?.some((crop) => String(crop.id) === filters.crop)) {
    throw new Error(`Registry item '${filters.id}' has no crop '${filters.crop}'.`);
  }
  console.log(
    `\n── Generating Figma Dimension-Preserving Diff Report (${selectedItems.length}/${items.length} items) ─────────\n`
  );
  console.log(
    `  Dimension-preserving comparison: no resizing or crops; Pixelmatch perceptual threshold ${PIXELMATCH_THRESHOLD}.\n`
  );
  const rows = [];
  for (const item of selectedItems) {
    process.stdout.write(`  ${item.id} … `);
    try {
      const r = await processItem(item, filters);
      rows.push(r);
      const drift = r.ratio == null ? (r.error ?? 'n/a') : (r.ratio * 100).toFixed(2) + '%';
      console.log(`${drift}  ${r.classification.label}`);
      for (const crop of r.crops ?? []) {
        const cropDrift =
          crop.ratio == null ? (crop.error ?? 'n/a') : (crop.ratio * 100).toFixed(2) + '%';
        console.log(`    ↳ ${crop.id} … ${cropDrift}  ${crop.classification.label}`);
      }
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      rows.push({
        id: item.id,
        title: item.title,
        viewport: item.viewport,
        status: item.status,
        referencePath: item.referencePath,
        error: e.message,
        crops: [],
        classification: { label: '❌ error', cls: 'major' },
      });
    }
  }

  const html = renderHtml(rows);
  ensureDir(REPORT_ROOT);
  writeFileSync(join(REPORT_ROOT, 'index.html'), html);

  // Summary stats
  const counts = rows.reduce(
    (a, r) => {
      a[r.classification.cls] = (a[r.classification.cls] ?? 0) + 1;
      return a;
    },
    { ok: 0, minor: 0, major: 0, waived: 0 }
  );
  const cropCount = rows.reduce((sum, r) => sum + (r.crops?.length ?? 0), 0);
  console.log('\n── Summary ───────────────────────────────────────────────────────\n');
  console.log(`  🔎 perceptual matches:         ${counts.ok}`);
  console.log(`  ⚠️ perceptual drift:           ${counts.minor}`);
  console.log(`  ❌ perceptual major/errors:    ${counts.major}`);
  console.log(`  ⚪ waived:         ${counts.waived}`);
  console.log(`  🔎 crops:          ${cropCount}`);
  console.log(`\nReport: ${join(REPORT_ROOT, 'index.html')}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
