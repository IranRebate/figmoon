#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  analyzeVisualPair,
  buildExperimentPlan,
  clusterVisualSignatures,
  componentCandidates,
  measureRectCoverage,
  rankHypotheses,
  sharedCauseGroups,
} from './lib/design-diagnosis.mjs';

import { getFigmoonConfig } from '../lib/config.mjs';
const __figmoonConfig = getFigmoonConfig();
const repoRoot = __figmoonConfig.consumerRoot;
const clientRoot = __figmoonConfig.clientRoot;
const argv = process.argv.slice(2);

function value(flag) {
  const inline = argv.find((argument) => argument.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function resolveRunPath(input) {
  const candidates = [
    input,
    resolve(process.cwd(), input),
    resolve(clientRoot, input),
    resolve(repoRoot, input),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

async function rgba(path, width, height) {
  return await sharp(path)
    .resize(width, height, { fit: 'fill' })
    .flatten({ background: '#fff' })
    .ensureAlpha()
    .raw()
    .toBuffer();
}

const runInput = value('--run');
if (!runInput) throw new Error('design:diagnose requires --run <measurement-run-directory>.');
const runDir = resolveRunPath(runInput);
if (!runDir) throw new Error(`Measurement run does not exist: ${runInput}`);
const strictPath = join(runDir, 'strict-audit', 'strict-audit.json');
if (!existsSync(strictPath)) throw new Error(`Missing strict-audit evidence: ${strictPath}`);

const strict = JSON.parse(readFileSync(strictPath, 'utf8'));
const graph = JSON.parse(readFileSync(__figmoonConfig.dependencyGraphPath, 'utf8'));
const registry = JSON.parse(readFileSync(__figmoonConfig.registryPath, 'utf8'));
const diagnoses = [];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function embeddedPng(path) {
  return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
}

function overlapRatio(region, rect) {
  const width = Math.max(
    0,
    Math.min(region.x + region.width, rect.x + rect.width) - Math.max(region.x, rect.x)
  );
  const height = Math.max(
    0,
    Math.min(region.y + region.height, rect.y + rect.height) - Math.max(region.y, rect.y)
  );
  return (width * height) / Math.max(region.width * region.height, 1);
}

function semanticSuspects(region, semanticElements) {
  return semanticElements
    .map((element) => ({
      tag: element.tag,
      role: element.role,
      testId: element.testId,
      owner: element.owner,
      reactStack: element.reactStack ?? [],
      rect: element.rect,
      style: element.style,
      overlap: overlapRatio(region, element.rect),
    }))
    .filter((element) => element.overlap >= 0.08)
    .sort((left, right) => right.overlap - left.overlap)
    .slice(0, 6);
}

for (const raw of strict.rawDiffs ?? []) {
  // Analyze the immutable reference copy emitted by the same diff step that
  // produced this run. `raw.referencePath` is a registry identifier and can
  // point at a legacy filename while strict-audit compares the manifest artifact
  // (or a staged reference-run override). Mixing those sources makes diagnosis
  // disagree with the measured result and can send remediation to the wrong UI.
  const capturedReferencePath = join(runDir, 'diff', 'figma', `${raw.id}.png`);
  const referencePath = existsSync(capturedReferencePath)
    ? capturedReferencePath
    : resolve(repoRoot, raw.referencePath);
  const snapshotPath = resolve(repoRoot, raw.snapshotPath);
  if (!existsSync(referencePath) || !existsSync(snapshotPath) || raw.dimensionMismatch) continue;
  const [reference, snapshot] = await Promise.all([
    rgba(referencePath, raw.width, raw.height),
    rgba(snapshotPath, raw.width, raw.height),
  ]);
  const analysis = analyzeVisualPair(reference, snapshot, raw.width, raw.height);
  const registryItem = registry.items.find((item) => item.id === raw.id);
  const components = componentCandidates(raw.id, graph);
  const ownershipPath = join(runDir, 'design-ownership', `${raw.id}.design-ownership.json`);
  const ownership = existsSync(ownershipPath)
    ? JSON.parse(readFileSync(ownershipPath, 'utf8'))
    : { owners: [], semanticElements: [] };
  const ownerCoverage = measureRectCoverage(
    reference,
    snapshot,
    raw.width,
    raw.height,
    (ownership.owners ?? []).map((owner, index) => ({
      kind: 'component',
      id: owner.owner,
      instance: index + 1,
      rect: owner.rect,
    }))
  );
  const elementCoverage = measureRectCoverage(
    reference,
    snapshot,
    raw.width,
    raw.height,
    (ownership.semanticElements ?? []).map((element, index) => ({
      kind: 'element',
      id: element.owner ?? element.testId ?? element.role ?? element.tag,
      instance: index + 1,
      tag: element.tag,
      role: element.role,
      testId: element.testId,
      owner: element.owner,
      reactStack: element.reactStack ?? [],
      rect: element.rect,
    }))
  );
  analysis.regions.forEach((region) => {
    region.semanticSuspects = semanticSuspects(region, ownership.semanticElements ?? []);
  });
  const sourcePool = [
    ...new Set([
      ...(registryItem?.implementationPaths ?? []),
      ...components.map((component) => component.codeModule),
    ]),
  ];
  analysis.regions.forEach((region) => {
    const matches = sourcePool.flatMap((module) => {
      const basename = module
        .split('/')
        .at(-1)
        ?.replace(/\.[^.]+$/, '');
      if (!basename) return [];
      const depths = region.semanticSuspects
        .map((suspect) => suspect.reactStack.indexOf(basename))
        .filter((index) => index >= 0);
      return depths.length ? [{ module, stackDepth: Math.min(...depths) }] : [];
    });
    const nearestDepth = Math.min(...matches.map((match) => match.stackDepth));
    region.sourceAttribution = matches.sort((left, right) => left.stackDepth - right.stackDepth);
    region.sourceCandidates = matches
      .filter((match) => match.stackDepth === nearestDepth)
      .map((match) => match.module);
  });
  const verifiedOwners = components.flatMap((component) => {
    const instances = ownership.owners
      .filter((owner) => owner.owner === component.id)
      .map((owner) => ({
        rect: owner.rect,
        style: owner.style,
        overlappingRegions: analysis.regions
          .map((region, index) => ({ index: index + 1, overlap: overlapRatio(region, owner.rect) }))
          .filter((entry) => entry.overlap >= 0.15),
      }))
      .filter((instance) => instance.overlappingRegions.length > 0);
    return instances.length ? [{ ...component, instances }] : [];
  });
  const attributedRegionIndexes = [
    ...new Set(
      verifiedOwners.flatMap((component) =>
        component.instances.flatMap((instance) =>
          instance.overlappingRegions.map((entry) => entry.index)
        )
      )
    ),
  ].sort((left, right) => left - right);
  const attributedMismatchShare = attributedRegionIndexes.reduce(
    (total, index) => total + (analysis.regions[index - 1]?.share ?? 0),
    0
  );
  diagnoses.push({
    id: raw.id,
    title: raw.title,
    route: registryItem?.route ?? null,
    ratio: analysis.ratio,
    spatialPyramid: analysis.spatialPyramid,
    artifacts: {
      reference: existsSync(join(runDir, 'diff', 'figma', `${raw.id}.png`))
        ? `diff/figma/${raw.id}.png`
        : relative(runDir, referencePath),
      snapshot: existsSync(join(runDir, 'diff', 'snapshots', `${raw.id}.png`))
        ? `diff/snapshots/${raw.id}.png`
        : relative(runDir, snapshotPath),
      diff: existsSync(join(runDir, 'diff', 'diffs', `${raw.id}-diff.png`))
        ? `diff/diffs/${raw.id}-diff.png`
        : null,
    },
    regions: analysis.regions,
    hypotheses: rankHypotheses(analysis, raw.width, raw.height),
    components,
    verifiedOwners,
    ownershipEvidence: existsSync(ownershipPath) ? relative(repoRoot, ownershipPath) : null,
    coverage: {
      statusContract: {
        matched: 'checked with zero perceptual mismatch inside bounds',
        'minor-drift': 'checked with up to 3% perceptual mismatch inside bounds',
        drift: 'checked with more than 3% perceptual mismatch inside bounds',
        unresolved: 'bounds unavailable or outside the captured viewport',
      },
      components: ownerCoverage,
      elements: elementCoverage,
      checkedCount: ownerCoverage.length + elementCoverage.length,
      unresolvedCount: [...ownerCoverage, ...elementCoverage].filter(
        (entry) => entry.status === 'unresolved'
      ).length,
    },
    attribution: {
      attributedRegionIndexes,
      attributedMismatchShare,
      unresolvedRegionIndexes: analysis.regions
        .map((_, index) => index + 1)
        .filter((index) => !attributedRegionIndexes.includes(index)),
    },
    pageOwners: registryItem?.implementationPaths ?? [],
    dominantSourceCandidates: analysis.regions[0]?.sourceCandidates ?? [],
    recommendedVerificationTargets: [
      ...new Set(verifiedOwners.flatMap((component) => component.verificationTargets)),
    ].sort(),
  });
}

for (const diagnosis of diagnoses) diagnosis.experiment = buildExperimentPlan(diagnosis);

const shared = sharedCauseGroups(diagnoses);
const visualClusters = clusterVisualSignatures(diagnoses);
const output = {
  schemaVersion: 3,
  generatedAt: new Date().toISOString(),
  run: relative(repoRoot, runDir),
  policy: {
    inference:
      'Ranked diagnostic evidence, not permission to mutate code, Figma, fixtures, references, or baselines.',
    mutation:
      'Prefer the highest shared owner that explains compatible regions; verify its complete impact matrix.',
  },
  shared,
  visualClusters,
  targets: diagnoses,
};

const outputPath = join(runDir, 'design-diagnosis.json');
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

function renderHtml(report, artifactRoot) {
  const targetCards = report.targets
    .map((target) => {
      const referenceImage = embeddedPng(resolve(artifactRoot, target.artifacts.reference));
      const snapshotImage = embeddedPng(resolve(artifactRoot, target.artifacts.snapshot));
      const diffImage = target.artifacts.diff
        ? embeddedPng(resolve(artifactRoot, target.artifacts.diff))
        : null;
      const overlays = target.regions
        .map(
          (region, index) =>
            `<div class="region" style="left:${region.normalized.centerX * 100 - (region.normalized.width * 100) / 2}%;top:${region.normalized.centerY * 100 - (region.normalized.height * 100) / 2}%;width:${region.normalized.width * 100}%;height:${region.normalized.height * 100}%"><span>${index + 1}</span></div>`
        )
        .join('');
      const hypotheses = target.hypotheses
        .slice(0, 4)
        .map(
          (hypothesis) =>
            `<li><b>${Math.round(hypothesis.confidence * 100)}% ${escapeHtml(hypothesis.cause)}</b><span>${escapeHtml(hypothesis.reason)}</span></li>`
        )
        .join('');
      const regions = target.regions
        .slice(0, 5)
        .map(
          (region, index) =>
            `<tr><td>${index + 1}</td><td>${(region.share * 100).toFixed(1)}%</td><td>${(region.density * 100).toFixed(1)}%</td><td>${(region.edgeRatio * 100).toFixed(1)}%</td><td>${(region.colorConsistency * 100).toFixed(1)}%</td><td>${region.semanticSuspects.map((suspect) => escapeHtml([suspect.tag, suspect.role, suspect.testId].filter(Boolean).join(':'))).join(', ') || 'unresolved'}</td><td>${region.x}, ${region.y}, ${region.width}×${region.height}</td></tr>`
        )
        .join('');
      const coverageRows = [...target.coverage.components, ...target.coverage.elements]
        .map((entry) => {
          const stack = entry.reactStack?.[0] ? ` · ${entry.reactStack[0]}` : '';
          const label = `${entry.kind === 'component' ? entry.id : entry.tag || entry.id} #${entry.instance}${stack}`;
          return `<tr><td>${escapeHtml(label)}</td><td><span class="status ${escapeHtml(entry.status)}">${escapeHtml(entry.status)}</span></td><td>${(entry.ratio * 100).toFixed(2)}%</td><td>${entry.mismatchPixels}</td><td>${entry.rect.x}, ${entry.rect.y}, ${entry.rect.width}×${entry.rect.height}</td></tr>`;
        })
        .join('');
      return `<section><header><div><h2>${escapeHtml(target.id)}</h2><p>${escapeHtml(target.title)} · ${(target.ratio * 100).toFixed(2)}% drift</p></div><div class="coverage">${target.coverage.checkedCount} checked · ${target.coverage.unresolvedCount} unresolved</div></header><p class="hint"><b>Raster confirmation / fallback:</b> use structural inspection to qualify authority and exact properties first; use these regions, coverage, and edge/pixel evidence to confirm a bounded hypothesis or diagnose structure that could not be matched.</p><div class="visuals"><figure><div class="canvas"><img src="${referenceImage}">${overlays}</div><figcaption>Figma + diagnosed regions</figcaption></figure><figure><div class="canvas"><img src="${snapshotImage}">${overlays}</div><figcaption>Current render + same regions</figcaption></figure></div><div class="grid"><article><h3>Ranked hypotheses</h3><ol>${hypotheses}</ol></article><article><h3>Next causal experiment</h3><p><b>${escapeHtml(target.experiment.hypothesis)}</b> · leverage ${(target.experiment.expectedLeverage * 100).toFixed(1)}%</p><p>Scope: ${target.experiment.mutationScope.map(escapeHtml).join(', ') || 'resolve owner first'}</p><p>Witnesses: ${target.experiment.witnessTargets.map(escapeHtml).join(', ')}</p><p>Controls: ${target.experiment.controlTargets.map(escapeHtml).join(', ') || 'none registered'}</p></article></div><h3 class="section-title">Complete component and element coverage</h3><p class="hint">Every captured bound is checked independently of the ranked Top-8 mismatch regions. Matched is diagnostic evidence, not parity signoff.</p><div class="table-scroll"><table><thead><tr><th>Component / element</th><th>Checked status</th><th>Bound drift</th><th>Mismatch pixels</th><th>Bounds</th></tr></thead><tbody>${coverageRows}</tbody></table></div><h3 class="section-title">Ranked mismatch regions</h3><div class="table-scroll"><table><thead><tr><th>Region</th><th>Mismatch share</th><th>Density</th><th>Edge score</th><th>Color consistency</th><th>Semantic suspects</th><th>Bounds</th></tr></thead><tbody>${regions}</tbody></table></div>${diffImage ? `<details><summary>Secondary pixel evidence — never mutation authority by itself</summary><figure><div class="canvas"><img src="${diffImage}"></div><figcaption>Perceptual diff</figcaption></figure></details>` : ''}</section>`;
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Design diagnosis</title><style>:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0b1020;color:#e9edff}*{box-sizing:border-box}body{margin:0;padding:32px;background:radial-gradient(circle at top,#182445,#0b1020 45%)}main{max-width:1500px;margin:auto}h1{margin:0 0 8px;font-size:28px}main>p,.hint{color:#9eabd0;margin:0 0 24px}section{background:#11182b;border:1px solid #293657;border-radius:20px;padding:22px;margin:0 0 24px;box-shadow:0 20px 60px #05081280}header{display:flex;justify-content:space-between;gap:16px;align-items:center}h2,h3{margin:0}header p{color:#9eabd0}.coverage{background:#192b47;color:#8bc5ff;border:1px solid #31557f;border-radius:999px;padding:8px 12px}.visuals{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:20px 0}figure{margin:0;background:#090e1c;border-radius:14px;padding:10px}.canvas{position:relative;line-height:0}.canvas img{width:100%;height:auto}.region{position:absolute;border:2px solid #ff4d75;background:#ff35551c;box-shadow:0 0 0 1px #fff6}.region span{position:absolute;top:-20px;left:-2px;background:#ff315d;color:white;font:700 11px/18px monospace;padding:0 5px;border-radius:4px}figcaption{line-height:1.4;color:#91a0c5;font-size:12px;margin-top:8px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.grid article{background:#0c1325;border:1px solid #263354;border-radius:14px;padding:16px}ol{padding-left:22px}li{margin:12px 0}li span{display:block;color:#99a6c7;margin-top:4px}.section-title{margin-top:24px}.hint{margin:8px 0 0}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}th,td{text-align:left;padding:10px;border-bottom:1px solid #263354;white-space:nowrap}th{color:#8fa0c9}.status{display:inline-block;border-radius:999px;padding:4px 8px;font-weight:700}.status.matched{background:#133b31;color:#72e0b3}.status.minor-drift{background:#463b17;color:#ffd66b}.status.drift{background:#4a2030;color:#ff91af}.status.unresolved{background:#30364a;color:#b6bfd8}details{margin-top:24px;background:#0c1325;border:1px solid #263354;border-radius:14px;padding:14px}summary{cursor:pointer;color:#ffd66b;font-weight:700}@media(max-width:900px){body{padding:14px}.visuals,.grid{grid-template-columns:1fr}}</style></head><body><main><h1>Raster confirmation and fallback diagnosis</h1><p>${escapeHtml(report.run)} · pixel/edge evidence after structural inspection, never automatic mutation authority</p>${targetCards}</main></body></html>`;
}

const htmlPath = join(runDir, 'design-diagnosis.html');
writeFileSync(htmlPath, renderHtml(output, runDir));

if (argv.includes('--json')) {
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

console.log('\n── Design Diagnosis ────────────────────────────────────────────\n');
for (const target of diagnoses) {
  console.log(`${target.id} · ${(target.ratio * 100).toFixed(2)}% drift`);
  console.log(
    `  Coverage: ${target.coverage.checkedCount} captured bounds checked · ${target.coverage.unresolvedCount} unresolved`
  );
  for (const component of target.coverage.components)
    console.log(
      `    ${component.id} #${component.instance}: ${component.status} · ${(component.ratio * 100).toFixed(2)}% bound drift`
    );
  for (const [index, region] of target.regions.slice(0, 3).entries()) {
    console.log(
      `  Region ${index + 1}: x${region.x} y${region.y} ${region.width}×${region.height} · ${(region.share * 100).toFixed(1)}% of mismatch`
    );
    if (region.semanticSuspects.length)
      console.log(
        `    Semantic suspects: ${region.semanticSuspects.map((suspect) => [suspect.tag, suspect.role, suspect.testId].filter(Boolean).join(':')).join(', ')}${region.sourceCandidates.length ? ` → ${region.sourceCandidates.join(', ')}` : ''}`
      );
  }
  for (const hypothesis of target.hypotheses.slice(0, 3)) {
    console.log(
      `  Hypothesis ${(hypothesis.confidence * 100).toFixed(0)}%: ${hypothesis.cause} — ${hypothesis.reason}`
    );
  }
  if (target.verifiedOwners.length)
    console.log(
      `  Geometry-verified owners: ${target.verifiedOwners
        .map((component) => {
          const regions = [
            ...new Set(
              component.instances.flatMap((instance) =>
                instance.overlappingRegions.map((entry) => entry.index)
              )
            ),
          ];
          return `${component.id} (${component.codeModule}) → region ${regions.join(', ')}`;
        })
        .join(', ')}`
    );
  else if (target.components.length)
    console.log(
      `  Registered candidates (not geometry-attributed): ${target.components.map((component) => component.id).join(', ')}`
    );
  else console.log(`  Page owners: ${target.pageOwners.join(', ') || 'unregistered'}`);
  console.log(
    `  Attribution coverage: ${(target.attribution.attributedMismatchShare * 100).toFixed(1)}% of mismatch regions; unresolved regions ${target.attribution.unresolvedRegionIndexes.join(', ') || 'none'}`
  );
  if (target.recommendedVerificationTargets.length)
    console.log(`  Verify together: ${target.recommendedVerificationTargets.join(', ')}`);
  console.log('');
}
if (shared.components.length)
  console.log(
    `Cross-target component candidates: ${shared.components.map((entry) => `${entry.id} [${entry.targets.join(', ')}]`).join('; ')}`
  );
if (shared.tokens.length)
  console.log(
    `Cross-target token candidates: ${shared.tokens.map((entry) => `${entry.id} [${entry.targets.join(', ')}]`).join('; ')}`
  );
if (visualClusters.length)
  console.log(
    `Visual-signature clusters: ${visualClusters.map((cluster) => cluster.members.map((member) => `${member.id} ${(member.similarity * 100).toFixed(0)}%`).join(' ↔ ')).join('; ')}`
  );
console.log(`\nEvidence: ${outputPath}`);
console.log(`Visual report: ${htmlPath}`);
