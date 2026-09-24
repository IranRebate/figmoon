#!/usr/bin/env node

/**
 * Coordinates local design work in a shared worktree without creating branches
 * or changing tracked files. Leases are stored under .git and therefore never
 * become a product artifact or a source of merge conflicts.
 *
 * Usage:
 *   node scripts/design-lease.mjs acquire --id desktop-chat-active --owner integrator --mode implementation
 *   node scripts/design-lease.mjs status
 *   node scripts/design-lease.mjs release --id desktop-chat-active --owner integrator
 */

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { targetDependencyFiles } from './lib/figma-target-closure.mjs';

import { getFigmoonConfig } from '../lib/config.mjs';
const __figmoonConfig = getFigmoonConfig();
const repoRoot = __figmoonConfig.consumerRoot;
const args = process.argv.slice(2);
const command = args[0];
const validModes = new Set(['evidence', 'reference', 'implementation', 'design-system']);

function printUsage() {
  console.log(`Usage:
  node scripts/design-lease.mjs acquire --id <registry-id> --owner <owner> --mode <evidence|reference|implementation|design-system>
  node scripts/design-lease.mjs assert --id <registry-id> --owner <owner> --mode <reference|implementation|design-system>
  node scripts/design-lease.mjs release --id <registry-id> --owner <owner>
  node scripts/design-lease.mjs status`);
}

if (args.includes('--help') || args.includes('-h')) {
  printUsage();
  process.exit(0);
}

function argumentValue(flag) {
  const inline = args.find((argument) => argument.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function now() {
  return new Date();
}

function isExpired(lease) {
  return new Date(lease.expiresAt).getTime() <= Date.now();
}

function requireValue(name, value) {
  if (!value || value.startsWith('--')) throw new Error(`${name} is required.`);
  return value;
}

function validateOwner(owner) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,79}$/.test(owner)) {
    throw new Error(
      'Owner may contain only letters, numbers, ., _, :, @, /, and - (max 80 chars).'
    );
  }
  return owner;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function leasePaths() {
  const gitDir = git('rev-parse', '--git-dir');
  const root = resolve(repoRoot, gitDir, 'figmoon-design-leases');
  await mkdir(root, { recursive: true });
  return {
    root,
    state: resolve(root, 'leases.json'),
    mutex: resolve(root, '.mutex'),
  };
}

async function withMutex(action) {
  const paths = await leasePaths();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(paths.mutex);
      try {
        return await action(paths);
      } finally {
        await rm(paths.mutex, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  throw new Error(
    'Timed out waiting for the local design lease mutex. Inspect .git/figmoon-design-leases/.mutex.'
  );
}

async function readState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return { version: 1, leases: Array.isArray(parsed.leases) ? parsed.leases : [] };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, leases: [] };
    throw error;
  }
}

async function writeState(path, state) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, path);
}

async function scopesFor(id, mode) {
  const [pixelRegistry, dependencyGraph, screenRegistry] = await Promise.all([
    readJson(__figmoonConfig.registryPath),
    readJson(__figmoonConfig.dependencyGraphPath),
    readJson(__figmoonConfig.screenRegistryPath),
  ]);
  const target = pixelRegistry.items.find((item) => item.id === id);
  if (!target) throw new Error(`Unknown pixel-perfect registry target: ${id}`);
  const screen = (screenRegistry.screens ?? []).find(
    (candidate) => candidate.visualRegistryId === id
  );
  const components = (dependencyGraph.components ?? []).filter((component) =>
    component.visualCoverage?.registryIds?.includes(id)
  );
  const dependencyFiles = targetDependencyFiles({
    item: target,
    dependencyGraph,
    screenRegistry,
  });
  const evidence = [
    `registry:${id}`,
    // Measurements write only to an ignored run root. Different registry targets
    // may therefore inspect the same Playwright spec concurrently.
    `visual-evidence:${id}`,
  ];
  const reference = [
    `registry:${id}`,
    target.referencePath ? `figma-reference:${target.referencePath}` : `figma-reference:${id}`,
    'figma-reference:manifest',
  ];
  const implementation = [
    ...evidence,
    target.visualTest?.file ? `visual-test:${target.visualTest.file}` : null,
    target.snapshot ? `snapshot:${target.snapshot}` : null,
    ...[...dependencyFiles].map((file) => `file:${file}`),
    screen?.implementation?.module ? `module:${screen.implementation.module}` : null,
    ...components.flatMap((component) => [
      `component:${component.id}`,
      `module:${component.codeModule}`,
    ]),
  ];

  if (mode === 'evidence') return unique(evidence);
  if (mode === 'reference') return unique(reference);
  if (mode === 'implementation') return unique(implementation);
  return unique([...implementation, 'design-system:contract', 'design-system:generated-artifacts']);
}

function formattedLease(lease) {
  return {
    ...lease,
    state: isExpired(lease) ? 'expired' : 'active',
  };
}

async function acquire() {
  const id = requireValue('--id', argumentValue('--id'));
  const owner = validateOwner(requireValue('--owner', argumentValue('--owner')));
  const mode = argumentValue('--mode') ?? 'implementation';
  if (!validModes.has(mode))
    throw new Error(`--mode must be one of: ${[...validModes].join(', ')}`);
  const ttl = Number(argumentValue('--ttl-minutes') ?? 90);
  if (!Number.isInteger(ttl) || ttl < 5 || ttl > 240) {
    throw new Error('--ttl-minutes must be an integer from 5 through 240.');
  }
  const scopes = await scopesFor(id, mode);

  return withMutex(async ({ state: statePath }) => {
    const state = await readState(statePath);
    const expired = state.leases.filter(isExpired);
    if (expired.length) {
      throw new Error(
        `Expired lease(s) require explicit release --force-expired: ${expired.map((lease) => lease.id).join(', ')}`
      );
    }
    const conflicts = state.leases.filter((lease) =>
      lease.scopes.some((scope) => scopes.includes(scope))
    );
    if (conflicts.length) {
      throw new Error(
        `Lease conflict with ${conflicts.map((lease) => `${lease.id} (${lease.owner})`).join(', ')}.`
      );
    }
    const startedAt = now();
    const lease = {
      id,
      owner,
      mode,
      scopes,
      createdAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + ttl * 60_000).toISOString(),
      gitHead: git('rev-parse', 'HEAD'),
    };
    state.leases.push(lease);
    await writeState(statePath, state);
    return lease;
  });
}

async function release() {
  const id = requireValue('--id', argumentValue('--id'));
  const owner = validateOwner(requireValue('--owner', argumentValue('--owner')));
  const forceExpired = args.includes('--force-expired');

  return withMutex(async ({ state: statePath }) => {
    const state = await readState(statePath);
    const lease = state.leases.find((candidate) => candidate.id === id);
    if (!lease) throw new Error(`No lease exists for ${id}.`);
    if (lease.owner !== owner && !(forceExpired && isExpired(lease))) {
      throw new Error('Only the lease owner can release an active lease.');
    }
    if (forceExpired && !isExpired(lease)) {
      throw new Error('--force-expired only releases an expired lease.');
    }
    state.leases = state.leases.filter((candidate) => candidate.id !== id);
    await writeState(statePath, state);
    return lease;
  });
}

async function status() {
  const paths = await leasePaths();
  const state = await readState(paths.state);
  return state.leases.map(formattedLease);
}

async function assertLease() {
  const id = requireValue('--id', argumentValue('--id'));
  const owner = validateOwner(requireValue('--owner', argumentValue('--owner')));
  const mode = argumentValue('--mode') ?? 'implementation';
  if (!validModes.has(mode))
    throw new Error(`--mode must be one of: ${[...validModes].join(', ')}`);
  const requiredScopes = await scopesFor(id, mode);
  const compatibleModes = mode === 'implementation' ? new Set(['implementation', 'design-system']) : new Set([mode]);

  return withMutex(async ({ state: statePath }) => {
    const state = await readState(statePath);
    const lease = state.leases.find(
      (candidate) =>
        candidate.id === id &&
        candidate.owner === owner &&
        !isExpired(candidate) &&
        compatibleModes.has(candidate.mode)
    );
    if (!lease) {
      throw new Error(
        `No active ${mode} lease exists for '${id}' owned by '${owner}'. Acquire it before mutating a baseline.`
      );
    }
    const missingScopes = requiredScopes.filter((scope) => !lease.scopes.includes(scope));
    if (missingScopes.length) {
      throw new Error(
        `Lease '${id}' does not cover required ${mode} scopes: ${missingScopes.join(', ')}.`
      );
    }
    return lease;
  });
}

if (!['acquire', 'release', 'status', 'assert'].includes(command)) {
  printUsage();
  throw new Error('design-lease requires acquire, release, status, or assert.');
}

const result =
  command === 'acquire'
    ? await acquire()
    : command === 'release'
      ? await release()
      : command === 'assert'
        ? await assertLease()
        : await status();
if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else if (command === 'status') {
  if (!result.length) console.log('No active or expired local design leases.');
  else
    for (const lease of result)
      console.log(
        `${lease.state}  ${lease.id}  ${lease.owner}  ${lease.mode}  expires ${lease.expiresAt}`
      );
} else if (command === 'assert') {
  console.log(`Verified active lease for ${result.id} (${result.owner}, ${result.mode}).`);
} else {
  console.log(
    `${command === 'acquire' ? 'Acquired' : 'Released'} lease for ${result.id} (${result.owner}, ${result.mode}).`
  );
}
