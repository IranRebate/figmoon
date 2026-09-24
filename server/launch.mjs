#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = dirname(fileURLToPath(import.meta.url));
const distEntry = join(serverRoot, 'dist', 'index.js');

function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(
    stat.mtimeMs,
    ...readdirSync(path, { withFileTypes: true }).map((entry) =>
      newestMtime(join(path, entry.name))
    )
  );
}

export function serverBuildStatus(root = serverRoot) {
  const entry = join(root, 'dist', 'index.js');
  const inputs = [join(root, 'src'), join(root, 'package.json'), join(root, 'tsconfig.json')];
  const inputMtime = Math.max(...inputs.map(newestMtime));
  const outputMtime = existsSync(entry) ? statSync(entry).mtimeMs : 0;
  return {
    ready: outputMtime >= inputMtime && outputMtime > 0,
    reason: outputMtime === 0 ? 'missing' : outputMtime < inputMtime ? 'stale' : 'current',
  };
}

function buildServer() {
  if (!existsSync(join(serverRoot, 'node_modules', 'typescript'))) {
    throw new Error(
      'Figmoon server dependencies are missing. Run `npm run figmoon:setup` once, then restart the MCP host.'
    );
  }
  console.error('Figmoon server build is missing or stale; rebuilding before MCP startup...');
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: serverRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) throw new Error('Figmoon server build failed.');
}

export function launch() {
  if (!serverBuildStatus().ready) buildServer();
  const child = spawn(process.execPath, [distEntry], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    launch();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
