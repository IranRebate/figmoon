#!/usr/bin/env node

/**
 * Executes the safe portion of a design-impact report. Measurements use a
 * run-scoped capture root, while this command owns one temporary Vite server
 * for the whole affected-target matrix.
 *
 * Usage:
 *   node scripts/verify-design-impact.mjs --files client/src/components/chat/ChatInput.tsx
 *   node scripts/verify-design-impact.mjs --base origin/main --measure --viewport mobile --max-parallel 2 --fail-fast
 *   node scripts/verify-design-impact.mjs --files client/src/components/shared/Button.tsx --measure --id comp-button-primary
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureRuntimeEnvironment,
  captureRuntimeIdentityFromEnvironment,
  createCaptureRuntimeIdentity,
  verifyCaptureRuntime,
} from './lib/figma-capture-runtime.mjs';
import { workspaceFingerprint } from './lib/figma-reference-run.mjs';

const modulePath = fileURLToPath(import.meta.url);
const scriptDir = dirname(modulePath);
import { getFigmoonConfig, npmWorkspaceArgs } from '../lib/config.mjs';
const __figmoonConfig = getFigmoonConfig();
const clientRoot = __figmoonConfig.clientRoot;
const repoRoot = __figmoonConfig.consumerRoot;
const workspaceArgs = npmWorkspaceArgs(__figmoonConfig);
const workspaceLabel = workspaceArgs[0] ? ` ${workspaceArgs[0]}` : '';
const usage = `Usage:
  node scripts/verify-design-impact.mjs [--base <revision> | --files <paths...>] [options]

Options:
  --base <revision>               Compare changed files with a Git revision (default: HEAD).
  --files <paths...>              Verify an explicit set of changed repository paths.
  --id <registry-id>              Limit verification to an affected target; repeatable.
  --measure                       Capture measurable affected targets.
  --report-only                   Report coverage gaps without failing on them.
  --require-fresh-references      Fail when a selected reference is stale.
  --viewport <viewport>           Limit targets to desktop, mobile, tablet-landscape, or tablet-portrait.
  --max-parallel <1-4>            Limit concurrent measurements (default: 2).
  --fail-fast                     Stop assigning measurements after the first failure.
  --today <YYYY-MM-DD>            Override the reference-freshness date.
  --help                          Print this help without running verification.`;

export function parseVerifyArguments(
  argumentsToParse,
  { defaultToday = new Date().toISOString().slice(0, 10) } = {}
) {
  const booleanArguments = new Map([
    ['--measure', 'measure'],
    ['--report-only', 'reportOnly'],
    ['--require-fresh-references', 'requireFreshReferences'],
    ['--fail-fast', 'failFast'],
    ['--help', 'showHelp'],
  ]);
  const singletonArguments = new Set(['--base', '--today', '--max-parallel', '--viewport']);
  const seenBooleans = new Set();
  const seenSingletons = new Set();
  const singletonValues = new Map();
  const selectedIds = [];
  const impactArgs = [];
  const parsedBooleans = Object.fromEntries(
    [...booleanArguments.values()].map((property) => [property, false])
  );

  function requiredValue(flag, argument, index, description = 'a value') {
    if (argument.startsWith(`${flag}=`)) {
      const value = argument.slice(flag.length + 1);
      if (!value) throw new Error(`${flag} requires ${description}.`);
      return { value, nextIndex: index };
    }
    const value = argumentsToParse[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires ${description}.`);
    }
    return { value, nextIndex: index + 1 };
  }

  for (let index = 0; index < argumentsToParse.length; index += 1) {
    const argument = argumentsToParse[index];
    let consumed = false;

    for (const [flag, property] of booleanArguments) {
      if (argument.startsWith(`${flag}=`)) {
        throw new Error(`${flag} does not accept a value.`);
      }
      if (argument !== flag) continue;
      if (seenBooleans.has(flag)) throw new Error(`${flag} may be passed once.`);
      seenBooleans.add(flag);
      parsedBooleans[property] = true;
      consumed = true;
      break;
    }
    if (consumed) continue;

    const singletonFlag = [...singletonArguments].find(
      (flag) => argument === flag || argument.startsWith(`${flag}=`)
    );
    if (singletonFlag) {
      if (seenSingletons.has(singletonFlag)) {
        throw new Error(`${singletonFlag} may be passed once.`);
      }
      seenSingletons.add(singletonFlag);
      const { value, nextIndex } = requiredValue(singletonFlag, argument, index);
      singletonValues.set(singletonFlag, value);
      index = nextIndex;
      if (singletonFlag === '--base') impactArgs.push('--base', value);
      continue;
    }

    if (argument === '--id' || argument.startsWith('--id=')) {
      const { value, nextIndex } = requiredValue('--id', argument, index, 'a registry id');
      selectedIds.push(value);
      index = nextIndex;
      continue;
    }

    if (argument === '--files') {
      const files = [];
      while (argumentsToParse[index + 1] && !argumentsToParse[index + 1].startsWith('--')) {
        files.push(argumentsToParse[++index]);
      }
      if (!files.length) throw new Error('--files requires at least one changed path.');
      impactArgs.push('--files', ...files);
      continue;
    }
    if (argument.startsWith('--files=')) {
      const file = argument.slice('--files='.length);
      if (!file) throw new Error('--files requires at least one changed path.');
      impactArgs.push('--files', file);
      continue;
    }

    throw new Error(`Unknown argument: ${argument}.`);
  }

  const referenceToday = singletonValues.get('--today') ?? defaultToday;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceToday)) {
    throw new Error('--today must use YYYY-MM-DD.');
  }
  const maxParallel = Number(singletonValues.get('--max-parallel') ?? 2);
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 4) {
    throw new Error('--max-parallel must be an integer from 1 through 4.');
  }
  const viewport = singletonValues.get('--viewport') ?? null;
  const validViewports = new Set(['desktop', 'mobile', 'tablet-landscape', 'tablet-portrait']);
  if (viewport && !validViewports.has(viewport)) {
    throw new Error(`--viewport must be one of: ${[...validViewports].join(', ')}.`);
  }

  return {
    ...parsedBooleans,
    selectedIds,
    referenceToday,
    maxParallel,
    viewport,
    impactArgs,
  };
}

const {
  measure,
  reportOnly,
  requireFreshReferences,
  failFast,
  showHelp,
  selectedIds,
  referenceToday,
  maxParallel,
  viewport,
  impactArgs,
} = parseVerifyArguments(process.argv.slice(2));
const referenceManifest = JSON.parse(
  readFileSync(__figmoonConfig.manifestPath, 'utf8')
);
const pixelRegistry = JSON.parse(
  readFileSync(__figmoonConfig.registryPath, 'utf8')
);

function withoutVisionEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith('FIGMA_VISION_'))
  );
}

const nonVisionEnvironment = withoutVisionEnvironment();

function childIsRunning(child) {
  return child && child.exitCode == null && child.signalCode == null;
}

function waitForChildExit(child, timeoutMilliseconds) {
  if (!childIsRunning(child)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMilliseconds);
    child.once('exit', onExit);
  });
}

export function createChildSupervisor({
  spawnChild = spawn,
  terminationTimeoutMilliseconds = 5_000,
} = {}) {
  const children = new Set();
  const useProcessGroups = process.platform !== 'win32';
  let acceptingChildren = true;
  let stopAllPromise = null;

  function signalProcessGroup(child, signal) {
    if (!useProcessGroups || !child?.pid) return false;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
    return true;
  }

  function signalChild(child, signal) {
    if (!childIsRunning(child)) return;
    if (!signalProcessGroup(child, signal)) child.kill(signal);
  }

  function spawnTracked(command, args, options = {}) {
    if (!acceptingChildren) {
      throw new Error('Design verification is shutting down; refusing to start another child.');
    }
    const child = spawnChild(command, args, {
      ...options,
      detached: useProcessGroups ? true : options.detached,
    });
    children.add(child);
    const release = () => {
      children.delete(child);
      // npm can exit before Vite or Playwright. Once the tracked group leader is
      // gone, no descendant is allowed to survive as an orphan.
      signalProcessGroup(child, 'SIGKILL');
    };
    child.once('error', release);
    child.once('exit', release);
    return child;
  }

  async function stopChild(child) {
    if (!childIsRunning(child)) return;
    const exited = waitForChildExit(child, terminationTimeoutMilliseconds);
    signalChild(child, 'SIGTERM');
    if (await exited) return;
    signalChild(child, 'SIGKILL');
    await waitForChildExit(child, terminationTimeoutMilliseconds);
  }

  async function stopAll() {
    if (stopAllPromise) return stopAllPromise;
    acceptingChildren = false;
    stopAllPromise = Promise.all([...children].map((child) => stopChild(child))).then(
      () => undefined
    );
    return stopAllPromise;
  }

  function stopAllSync() {
    acceptingChildren = false;
    for (const child of children) {
      try {
        // The exit event cannot await a grace period, so kill the whole group
        // synchronously instead of leaving npm grandchildren behind.
        signalChild(child, 'SIGKILL');
      } catch {
        // The process is already exiting; the asynchronous shutdown path reports errors.
      }
    }
  }

  return {
    spawn: spawnTracked,
    stopChild,
    stopAll,
    stopAllSync,
    activeCount: () => children.size,
  };
}

export function installChildLifecycleGuards(supervisor, hostProcess = process) {
  const signalExitCodes = new Map([
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]);
  let signalExitCode = null;
  let signalCleanup = Promise.resolve();
  const signalHandlers = new Map();

  for (const [signal, exitCode] of signalExitCodes) {
    const handler = () => {
      if (signalExitCode !== null) return;
      signalExitCode = exitCode;
      hostProcess.exitCode = exitCode;
      signalCleanup = supervisor.stopAll();
    };
    signalHandlers.set(signal, handler);
    hostProcess.once(signal, handler);
  }
  const exitHandler = () => supervisor.stopAllSync();
  hostProcess.once('exit', exitHandler);

  return {
    signalExitCode: () => signalExitCode,
    waitForSignalCleanup: () => signalCleanup,
    remove() {
      for (const [signal, handler] of signalHandlers) {
        hostProcess.removeListener(signal, handler);
      }
      hostProcess.removeListener('exit', exitHandler);
    },
  };
}

const childSupervisor = createChildSupervisor();

function run(command, args, label, environment = nonVisionEnvironment) {
  return new Promise((resolveRun, reject) => {
    const startedAt = Date.now();
    const child = childSupervisor.spawn(command, args, {
      cwd: repoRoot,
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun({ label, milliseconds: Date.now() - startedAt });
      else reject(new Error(`${label} failed${signal ? ` (${signal})` : ` (exit ${code})`}.`));
    });
  });
}

function capture(command, args) {
  return new Promise((resolveCapture, reject) => {
    let stdout = '';
    let stderr = '';
    const child = childSupervisor.spawn(command, args, {
      cwd: repoRoot,
      env: nonVisionEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveCapture(stdout);
      else
        reject(
          new Error(`Design impact failed${signal ? ` (${signal})` : ` (exit ${code})`}: ${stderr}`)
        );
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function daysSince(dateString, today = new Date().toISOString().slice(0, 10)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString ?? '')) return null;
  const start = new Date(`${dateString}T00:00:00Z`);
  const end = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return null;
  return Math.floor((end - start) / 86_400_000);
}

function referenceFreshness(target) {
  const entry =
    referenceManifest.items?.[target.id] ??
    Object.values(referenceManifest.items ?? {}).find((candidate) =>
      candidate.registryIds?.includes(target.id)
    );
  if (!entry) {
    return {
      blocking: true,
      reason: `No reference-manifest entry exists for '${target.id}'.`,
    };
  }
  if (entry.lifecycle?.status !== 'canonical-product') return null;

  const checkedAt =
    entry.acquisition?.acquiredAt?.slice(0, 10) ?? entry.lastCheckedAt ?? entry.exportedAt;
  const ageDays = daysSince(checkedAt, referenceToday);
  if (ageDays === null) {
    return { blocking: true, reason: 'Reference freshness metadata is missing or invalid.' };
  }

  const maxAgeDays =
    entry.staleAfterDays ?? referenceManifest.figmaFile?.freshnessPolicy?.maxAgeDays ?? 14;
  if (ageDays > maxAgeDays) {
    return {
      blocking:
        requireFreshReferences ||
        referenceManifest.figmaFile?.freshnessPolicy?.enforcement === 'all-checks',
      reason: `Figma reference is stale: ${checkedAt} is ${ageDays} days old (max ${maxAgeDays}).`,
    };
  }
  return null;
}

function allocatePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a local visual-capture port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function waitForCaptureRuntime(
  baseUrl,
  child,
  identity,
  currentSourceFingerprint,
  timeoutMilliseconds = 60_000
) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError = null;
  while (Date.now() < deadline) {
    if (!childIsRunning(child)) {
      throw new Error(
        `Visual capture server exited before becoming ready${lastError ? `: ${lastError.message}` : '.'}`
      );
    }
    try {
      return await verifyCaptureRuntime({
        baseUrl,
        identity,
        currentSourceFingerprint,
        timeoutMilliseconds: 1_000,
      });
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for an attested visual capture runtime at ${baseUrl}${lastError ? `: ${lastError.message}` : '.'}`
  );
}

async function stopServer(server) {
  if (!server?.owned || server.child.exitCode != null) return;
  await childSupervisor.stopChild(server.child);
}

async function startVisualServer() {
  const sourceState = workspaceFingerprint();
  const existingBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
  if (existingBaseUrl) {
    const identity = captureRuntimeIdentityFromEnvironment(process.env);
    if (!identity) {
      throw new Error(
        'An external PLAYWRIGHT_BASE_URL requires Figma capture runtime nonce and source fingerprint credentials.'
      );
    }
    await verifyCaptureRuntime({
      baseUrl: existingBaseUrl,
      identity,
      currentSourceFingerprint: sourceState.fingerprint,
    });
    return { baseUrl: existingBaseUrl, owned: false, child: null, identity, sourceState };
  }

  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const identity = createCaptureRuntimeIdentity(sourceState.fingerprint);
  let output = '';
  const child = childSupervisor.spawn(
    'npm',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: clientRoot,
      env: { ...nonVisionEnvironment, ...captureRuntimeEnvironment(identity) },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  try {
    await waitForCaptureRuntime(baseUrl, child, identity, sourceState.fingerprint);
    return { baseUrl, owned: true, child, identity, sourceState };
  } catch (error) {
    await stopServer({ owned: true, child });
    throw new Error(`${error.message}\n${output.trim()}`.trim());
  }
}

function batchId() {
  return `impact-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
}

export async function runWithLimit(
  items,
  limit,
  work,
  { failFast: stopAfterFailure = false } = {}
) {
  const results = [];
  const failures = [];
  let nextIndex = 0;
  let stopped = false;
  async function worker() {
    while (!stopped && nextIndex < items.length) {
      const item = items[nextIndex++];
      try {
        results.push(await work(item));
      } catch (error) {
        failures.push({ item, error: error instanceof Error ? error.message : String(error) });
        if (stopAfterFailure) stopped = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return { results, failures };
}

async function verifyDesignImpact() {
  const impactOutput = await capture(process.execPath, [
    resolve(scriptDir, 'design-impact.mjs'),
    '--json',
    ...impactArgs,
  ]);
  const impact = JSON.parse(impactOutput);
  const visualTargets = (impact.verification.visualTargets ?? []).map((target) => ({
    ...target,
    viewport: pixelRegistry.items?.find((item) => item.id === target.id)?.viewport ?? null,
  }));
  const targetById = new Map(visualTargets.map((target) => [target.id, target]));
  const unknownSelectedIds = selectedIds.filter((id) => !targetById.has(id));
  if (unknownSelectedIds.length) {
    throw new Error(
      `--id must select an affected target. Not affected: ${unknownSelectedIds.join(', ')}.`
    );
  }
  const idSelectedTargets = selectedIds.length
    ? [...new Map(selectedIds.map((id) => [id, targetById.get(id)])).values()]
    : visualTargets;
  const viewportMismatches = viewport
    ? idSelectedTargets.filter((target) => target.viewport !== viewport)
    : [];
  if (selectedIds.length && viewportMismatches.length) {
    throw new Error(
      `Selected target(s) do not match --viewport ${viewport}: ${viewportMismatches
        .map((target) => `${target.id} (${target.viewport ?? 'unknown'})`)
        .join(', ')}.`
    );
  }
  const requestedTargets = viewport
    ? idSelectedTargets.filter((target) => target.viewport === viewport)
    : idSelectedTargets;
  const unmeasurableTargets = requestedTargets.filter((target) => !target.measurable);
  if (measure && selectedIds.length && unmeasurableTargets.length) {
    throw new Error(
      `Selected target(s) do not have comparable visual coverage: ${unmeasurableTargets
        .map((target) => `${target.id} (${target.reason})`)
        .join(', ')}.`
    );
  }
  const measureTargets = requestedTargets.filter((target) => target.measurable);
  const referenceFreshnessResults = measureTargets
    .map((target) => ({ target, result: referenceFreshness(target) }))
    .filter(({ result }) => result);
  const referenceCoverageGaps = referenceFreshnessResults
    .filter(({ result }) => result.blocking)
    .map(({ target, result }) => ({ ...target, reason: result.reason }));
  const referenceFreshnessWarnings = referenceFreshnessResults
    .filter(({ result }) => !result.blocking)
    .map(({ target, result }) => ({ ...target, reason: result.reason }));
  const freshMeasureTargets = measureTargets.filter(
    (target) => !referenceCoverageGaps.some((gap) => gap.id === target.id)
  );
  if (measure && !requestedTargets.length) {
    throw new Error(
      viewport
        ? `No affected visual targets match --viewport ${viewport}.`
        : 'No affected visual targets were inferred from the selected impact matrix.'
    );
  }
  if (measure && !freshMeasureTargets.length && !referenceCoverageGaps.length) {
    throw new Error('No comparable visual targets were inferred from the selected impact matrix.');
  }
  if (
    measure &&
    !reportOnly &&
    (unmeasurableTargets.length > 0 || referenceCoverageGaps.length > 0)
  ) {
    if (unmeasurableTargets.length) {
      console.log(
        `Coverage gaps: ${unmeasurableTargets
          .map((target) => `${target.id} (${target.reason})`)
          .join(', ')}`
      );
    }
    if (referenceCoverageGaps.length) {
      console.log(
        `Freshness gaps: ${referenceCoverageGaps
          .map((target) => `${target.id} (${target.reason})`)
          .join(', ')}`
      );
    }
    throw new Error(
      'Design verification is incomplete. Resolve every coverage/freshness gap or rerun explicitly with --report-only.'
    );
  }

  const completed = [];
  if (measure && freshMeasureTargets.length) {
    completed.push(
      await run(
        'npm',
        [
          'run',
          'check:figma',
          ...workspaceArgs,
          '--',
          ...freshMeasureTargets.flatMap((target) => ['--id', target.id]),
          '--today',
          referenceToday,
        ],
        'Affected Figma target preflight'
      )
    );
  }

  const tasks = [];
  if (impact.verification.unitTests.length) {
    tasks.push(
      run(
        'npm',
        ['test', ...workspaceArgs, '--', '--run', ...impact.verification.unitTests],
        'Affected client unit tests'
      )
    );
  }
  if (impact.affected.globalDesignChange) {
    tasks.push(
      run(
        'npm',
        ['run', 'design:sync', ...workspaceArgs, '--', '--check'],
        'Generated design-system artifacts'
      )
    );
  }
  completed.push(...(await Promise.all(tasks)));
  let measuredTargets = [];
  let measurementFailures = [];

  if (measure) {
    if (freshMeasureTargets.length) {
      const server = await startVisualServer();
      try {
        const environment = {
          ...process.env,
          PLAYWRIGHT_BASE_URL: server.baseUrl,
          PLAYWRIGHT_REUSE_SERVER: '1',
          ...captureRuntimeEnvironment(server.identity),
        };
        const batch = batchId();
        const batchResults = await runWithLimit(
          freshMeasureTargets,
          maxParallel,
          (target) =>
            run(
              'npm',
              [
                'run',
                'figma:measure',
                ...workspaceArgs,
                '--',
                '--id',
                target.id,
                '--run-id',
                `${batch}-${target.id}`,
              ],
              `Figma measurement for ${target.id}`,
              environment
            ),
          { failFast }
        );
        completed.push(...batchResults.results);
        measuredTargets = batchResults.results.map((result) =>
          result.label.replace('Figma measurement for ', '')
        );
        measurementFailures = batchResults.failures;
      } finally {
        await stopServer(server);
      }
    }
  }

  console.log('\n── Design Verification ─────────────────────────────────────────\n');
  console.log(`Changed files: ${impact.changedFiles.length}`);
  console.log(
    `Targets: ${impact.affected.targets.map((target) => target.id).join(', ') || 'none'}`
  );
  console.log(`Viewport filter: ${viewport ?? 'all'}`);
  console.log(
    `Selected visual targets: ${requestedTargets.map((target) => target.id).join(', ') || 'none'}`
  );
  console.log(`Figma capture: ${measuredTargets.join(', ') || 'not requested'}`);
  if (unmeasurableTargets.length) {
    console.log(
      `Coverage gaps: ${unmeasurableTargets
        .map((target) => `${target.id} (${target.reason})`)
        .join(', ')}`
    );
  }
  if (referenceCoverageGaps.length) {
    console.log(
      `Freshness gaps: ${referenceCoverageGaps
        .map((target) => `${target.id} (${target.reason})`)
        .join(', ')}`
    );
  }
  if (referenceFreshnessWarnings.length) {
    console.log(
      `Freshness warnings (diagnostic measurement remains allowed): ${referenceFreshnessWarnings
        .map((target) => `${target.id} (${target.reason})`)
        .join(', ')}`
    );
  }
  for (const result of completed)
    console.log(`${result.label}: ${(result.milliseconds / 1000).toFixed(1)}s`);

  if (measurementFailures.length) {
    throw new Error(
      `Figma measurement failed for ${measurementFailures
        .map(({ item, error }) => `${item.id}: ${error}`)
        .join('; ')}`
    );
  }
}

if (resolve(process.argv[1] ?? '') === modulePath) {
  if (showHelp) {
    console.log(usage);
  } else {
    const lifecycle = installChildLifecycleGuards(childSupervisor);
    let verificationError = null;
    try {
      await verifyDesignImpact();
    } catch (error) {
      verificationError = error;
    } finally {
      await childSupervisor.stopAll();
      await lifecycle.waitForSignalCleanup();
      lifecycle.remove();
    }
    if (lifecycle.signalExitCode() === null && verificationError) throw verificationError;
  }
}
