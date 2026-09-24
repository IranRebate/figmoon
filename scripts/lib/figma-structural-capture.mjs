import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureRuntimeEnvironment,
  captureRuntimeIdentityFromEnvironment,
  createCaptureRuntimeIdentity,
  verifyCaptureRuntime,
} from './figma-capture-runtime.mjs';
import { workspaceFingerprint } from './figma-reference-run.mjs';

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate an isolated structural-inspection port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    wait(5_000).then(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }),
  ]);
}

async function waitForRuntime(baseUrl, child, identity, fingerprint) {
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) throw new Error(`Structural capture runtime exited with ${child.exitCode}.`);
    try {
      return await verifyCaptureRuntime({
        baseUrl,
        identity,
        currentSourceFingerprint: fingerprint,
        timeoutMilliseconds: 1_000,
      });
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for structural capture runtime: ${lastError?.message ?? 'unknown error'}`);
}

export async function startStructuralCaptureRuntime({ clientRoot, environment = process.env }) {
  const sourceState = workspaceFingerprint();
  const existingBaseUrl = environment.PLAYWRIGHT_BASE_URL;
  if (existingBaseUrl) {
    const identity = captureRuntimeIdentityFromEnvironment(environment);
    if (!identity) {
      throw new Error('An external PLAYWRIGHT_BASE_URL requires Figma capture runtime credentials.');
    }
    const attestation = await verifyCaptureRuntime({
      baseUrl: existingBaseUrl,
      identity,
      currentSourceFingerprint: sourceState.fingerprint,
    });
    return {
      baseUrl: existingBaseUrl,
      identity,
      sourceState,
      attestation,
      child: null,
      owned: false,
      stop: async () => {},
    };
  }
  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const identity = createCaptureRuntimeIdentity(sourceState.fingerprint);
  let output = '';
  const child = spawn(
    'npm',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: clientRoot,
      env: { ...environment, ...captureRuntimeEnvironment(identity) },
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
    const attestation = await waitForRuntime(baseUrl, child, identity, sourceState.fingerprint);
    return {
      baseUrl,
      identity,
      sourceState,
      attestation,
      child,
      owned: true,
      stop: () => stopChild(child),
    };
  } catch (error) {
    await stopChild(child);
    throw new Error(`${error.message}\n${output.trim()}`.trim());
  }
}

export function runStructuralPlaywright({
  repoRoot,
  clientRoot,
  item,
  project,
  runtime,
  outputRoot,
  structuralOutputRoot,
  designOwnershipRoot,
  extraEnvironment = {},
}) {
  const browserStructurePath = join(structuralOutputRoot, `${item.id}.browser-structure.json`);
  if (existsSync(browserStructurePath)) {
    throw new Error(`Structural browser evidence already exists: ${browserStructurePath}`);
  }
  return new Promise((resolve, reject) => {
    const escapedName = item.visualTest.name.replace(/[.*+?^$\{()|[\]\\]/g, '\\$&');
    const child = spawn(
      process.execPath,
      [
        join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
        'test',
        item.visualTest.file.replace(/^client\//, ''),
        '--project',
        project,
        '--grep',
        `${escapedName}$`,
        '--workers',
        '1',
        '--reporter=line',
      ],
      {
        cwd: clientRoot,
        env: {
          ...process.env,
          ...extraEnvironment,
          PLAYWRIGHT_BASE_URL: runtime.baseUrl,
          PLAYWRIGHT_REUSE_SERVER: '1',
          ...captureRuntimeEnvironment(runtime.identity),
          PLAYWRIGHT_VISUAL_OUTPUT_DIR: outputRoot,
          PLAYWRIGHT_VISUAL_REPORT_DIR: join(outputRoot, 'report'),
          FIGMA_DESIGN_DIAGNOSTICS_DIR: designOwnershipRoot,
          FIGMA_STRUCTURAL_INSPECTION: '1',
          FIGMA_STRUCTURAL_INSPECTION_DIR: structuralOutputRoot,
        },
        stdio: 'inherit',
      }
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ browserStructurePath });
      else reject(new Error(`Structural Playwright capture failed${signal ? ` (${signal})` : ` (exit ${code})`}.`));
    });
  });
}
