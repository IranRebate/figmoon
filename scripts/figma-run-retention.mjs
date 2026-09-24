#!/usr/bin/env node

/**
 * Reports disposable ignored Figma working runs. Deletion is opt-in and is
 * restricted to the two repository-owned run roots below. Durable promoted
 * artifacts are content-addressed elsewhere and are never considered here.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getFigmoonConfig } from '../lib/config.mjs';
const __figmoonConfig = getFigmoonConfig();
const clientRoot = __figmoonConfig.clientRoot;
const repoRoot = __figmoonConfig.consumerRoot;
const roots = [
  resolve(clientRoot, 'e2e', 'figma-audit-results', 'runs'),
  resolve(clientRoot, 'e2e', 'figma-reference-runs'),
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function inside(path, root) {
  const rel = relative(root, path);
  return rel && !rel.startsWith('..') && !rel.startsWith('/');
}

function checkedRoot(path) {
  const resolved = resolve(path);
  const info = lstatSync(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Retention root must be a regular directory: ${resolved}`);
  }
  return { resolved, real: realpathSync(resolved) };
}

function scanDirectory(path) {
  let total = 0;
  let modifiedAt = 0;
  const pending = [path];
  while (pending.length) {
    const current = pending.pop();
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`Retention refuses symbolic links: ${current}`);
    modifiedAt = Math.max(modifiedAt, info.mtimeMs);
    if (info.isDirectory()) {
      for (const entry of readdirSync(current)) pending.push(resolve(current, entry));
    } else total += info.size;
  }
  return { bytes: total, modifiedAt };
}

function protectedRunIds() {
  const registry = readJson(__figmoonConfig.registryPath);
  const manifest = readJson(__figmoonConfig.manifestPath);
  return new Set(
    [
      ...(registry.items ?? []).flatMap((item) => [
        item.baselineUpdate?.measurementRunId,
        item.signoff?.runId,
      ]),
      ...Object.values(manifest.items ?? {}).map((item) => item.acquisition?.runId),
    ].filter(Boolean)
  );
}

function describeRun(path, root) {
  const scan = scanDirectory(path);
  const evidencePath = resolve(path, 'evidence.json');
  const evidence = existsSync(evidencePath) ? readJson(evidencePath) : null;
  const id = evidence?.id ?? evidence?.target?.registryId ?? 'unknown';
  const mode = evidence?.mode ?? evidence?.kind ?? 'unknown';
  return {
    path,
    root,
    runId: evidence?.runId ?? basename(path),
    group: `${root}\0${id}\0${mode}`,
    modifiedAt: scan.modifiedAt,
    bytes: scan.bytes,
  };
}

export function planRetention({
  keepPerGroup = 3,
  olderThanDays = 3,
  now = Date.now(),
  runRoots = roots,
  protectedIds = protectedRunIds(),
} = {}) {
  if (!Number.isInteger(keepPerGroup) || keepPerGroup < 0) {
    throw new Error('keepPerGroup must be a non-negative integer.');
  }
  if (!Number.isInteger(olderThanDays) || olderThanDays < 0) {
    throw new Error('olderThanDays must be a non-negative integer.');
  }
  const resolvedRoots = runRoots.map((root) => resolve(root));
  const runs = resolvedRoots.flatMap((root) => {
    if (!existsSync(root)) return [];
    checkedRoot(root);
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isSymbolicLink()) {
        throw new Error(`Retention refuses symbolic links: ${resolve(root, entry.name)}`);
      }
      if (!entry.isDirectory()) return [];
      return [describeRun(resolve(root, entry.name), root)];
    });
  });
  const byGroup = new Map();
  for (const run of runs) {
    const group = byGroup.get(run.group) ?? [];
    group.push(run);
    byGroup.set(run.group, group);
  }
  const keep = new Set();
  for (const group of byGroup.values()) {
    group.sort((left, right) => right.modifiedAt - left.modifiedAt);
    for (const run of group.slice(0, keepPerGroup)) keep.add(run.path);
  }
  const cutoff = now - olderThanDays * 86_400_000;
  const candidates = runs
    .filter((run) => run.modifiedAt < cutoff && !keep.has(run.path) && !protectedIds.has(run.runId))
    .sort((left, right) => left.modifiedAt - right.modifiedAt);
  return {
    scanned: runs.length,
    candidates,
    reclaimableBytes: candidates.reduce((sum, run) => sum + run.bytes, 0),
  };
}

export function retentionPlanSha256(plan) {
  const contract = {
    scanned: plan.scanned,
    reclaimableBytes: plan.reclaimableBytes,
    candidates: plan.candidates.map(({ path, root, runId, modifiedAt, bytes }) => ({
      path: resolve(path),
      root: resolve(root),
      runId,
      modifiedAt,
      bytes,
    })),
  };
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

export function pruneRetention(plan, { allowedRoots = roots } = {}) {
  const checkedRoots = allowedRoots.map(checkedRoot);
  const resolvedRoots = checkedRoots.map((root) => root.resolved);
  const preflight = [];
  for (const candidate of plan.candidates) {
    const candidatePath = resolve(candidate.path);
    const candidateRoot = resolve(candidate.root);
    if (!resolvedRoots.includes(candidateRoot) || !inside(candidatePath, candidateRoot)) {
      throw new Error(`Retention candidate escaped an allowed root: ${candidatePath}`);
    }
    const info = lstatSync(candidatePath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Retention candidate is no longer a regular directory: ${candidatePath}`);
    }
    const allowedRoot = checkedRoots.find((root) => root.resolved === candidateRoot);
    const candidateRealPath = realpathSync(candidatePath);
    if (!allowedRoot || !inside(candidateRealPath, allowedRoot.real)) {
      throw new Error(`Retention candidate escaped an allowed root: ${candidatePath}`);
    }
    const current = scanDirectory(candidatePath);
    if (current.bytes !== candidate.bytes || current.modifiedAt !== candidate.modifiedAt) {
      throw new Error(`Retention candidate changed after review: ${candidatePath}`);
    }
    preflight.push(candidatePath);
  }
  for (const candidatePath of preflight) {
    rmSync(candidatePath, { recursive: true, force: false });
  }
}

function valueFor(argv, flag, fallback) {
  const indexes = argv.flatMap((argument, index) => (argument === flag ? [index] : []));
  if (!indexes.length) return fallback;
  if (indexes.length > 1) throw new Error(`${flag} may be provided only once.`);
  const value = Number(argv[indexes[0] + 1]);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${flag} requires a non-negative integer.`);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const summaryOnly = argv.includes('--summary');
  const supported = new Set([
    '--apply',
    '--summary',
    '--keep-per-target',
    '--older-than-days',
    '--expected-plan-sha256',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!supported.has(argument)) throw new Error(`Unsupported retention argument: ${argument}`);
    if (
      argument === '--keep-per-target' ||
      argument === '--older-than-days' ||
      argument === '--expected-plan-sha256'
    )
      index += 1;
  }
  if (apply && summaryOnly) {
    throw new Error(
      '--summary cannot be combined with --apply; deletion must print every candidate.'
    );
  }
  const keepPerGroup = valueFor(argv, '--keep-per-target', 3);
  const olderThanDays = valueFor(argv, '--older-than-days', 3);
  const plan = planRetention({ keepPerGroup, olderThanDays });
  const planSha256 = retentionPlanSha256(plan);
  console.log(
    `${apply ? 'Applying' : 'Dry run'}: ${plan.candidates.length}/${plan.scanned} ignored runs, ` +
      `${(plan.reclaimableBytes / 1024 / 1024).toFixed(1)} MiB reclaimable.`
  );
  console.log(`Plan SHA-256: ${planSha256}`);
  if (!summaryOnly) {
    for (const candidate of plan.candidates) {
      console.log(
        `  ${relative(repoRoot, candidate.path)} (${(candidate.bytes / 1024 / 1024).toFixed(1)} MiB)`
      );
    }
  }
  if (apply) {
    const digestIndex = argv.indexOf('--expected-plan-sha256');
    const expectedPlanSha256 = digestIndex === -1 ? null : argv[digestIndex + 1];
    if (!/^[a-f0-9]{64}$/.test(expectedPlanSha256 ?? '')) {
      throw new Error('--apply requires --expected-plan-sha256 <reviewed-sha256>.');
    }
    if (expectedPlanSha256 !== planSha256) {
      throw new Error(
        `Retention plan changed after review: expected ${expectedPlanSha256}, got ${planSha256}.`
      );
    }
    pruneRetention(plan);
  } else if (plan.candidates.length) {
    console.log(
      `No files removed. Re-run with --apply --expected-plan-sha256 ${planSha256} after reviewing this exact list.`
    );
  }
}
