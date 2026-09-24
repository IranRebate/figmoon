#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFigmaAcquisitionPluginIntegrity, FIGMOON_PACKAGE_ROOT } from './lib/figma-plugin-integrity.mjs';
import { resolveConsumerRoot } from './lib/config.mjs';
import { serverBuildStatus } from './server/launch.mjs';

const packageRoot = FIGMOON_PACKAGE_ROOT;
const DEFAULT_CONNECT_PORT = 29194;

function configuredConnectPort() {
  const raw = process.env.FIGMOON_CONNECT_PORT;
  const port = raw === undefined ? DEFAULT_CONNECT_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('FIGMOON_CONNECT_PORT must be an integer from 1 to 65535.');
  return port;
}

export function parseArgs(argv) {
  const parsed = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') parsed.json = true;
    else if (argument === '--file-key' || argument === '--file-name') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires one value.`);
      parsed[argument === '--file-key' ? 'fileKey' : 'fileName'] = value;
    } else throw new Error(`Unsupported figmoon:doctor argument: ${argument}`);
  }
  return parsed;
}

function findManifests(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.figmoon') {
      return [];
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findManifests(path);
    return entry.name === 'manifest.json' ? [relative(packageRoot, path)] : [];
  });
}

async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function diagnose({ fileKey, fileName } = {}) {
  const checks = [];
  const connectPort = configuredConnectPort();
  const add = (name, ok, detail, action) =>
    checks.push({ name, ok, detail, ...(!ok && action ? { action } : {}) });

  const manifests = findManifests(packageRoot);
  add(
    'singlePlugin',
    manifests.length === 1 && manifests[0].replaceAll('\\', '/') === 'plugin/manifest.json',
    manifests,
    'Keep only plugin/manifest.json in the Figmoon package.'
  );

  let expectedPluginBuild;
  try {
    const integrity = assertFigmaAcquisitionPluginIntegrity();
    expectedPluginBuild = integrity.plugin.build;
    add('pluginIntegrity', true, integrity.plugin.build);
  } catch (error) {
    add('pluginIntegrity', false, error.message, 'Run npm test to rebuild and seal the plugin.');
  }

  const consumerRoot = resolveConsumerRoot();
  const mcpPath = join(consumerRoot, '.mcp.json');
  let configuredLauncher = 'missing';
  let mcpOk = false;
  if (existsSync(mcpPath)) {
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    configuredLauncher = mcp.mcpServers?.figmoon?.args?.[0] ?? 'missing';
    const normalized = String(configuredLauncher).replaceAll('\\', '/');
    mcpOk =
      normalized === 'server/launch.mjs' ||
      normalized.endsWith('/figmoon/server/launch.mjs') ||
      normalized.endsWith('/server/launch.mjs');
  }
  add(
    'mcpConfiguration',
    mcpOk,
    configuredLauncher,
    'Point .mcp.json to the Figmoon server/launch.mjs entry (package-relative or absolute).'
  );

  const build = serverBuildStatus(join(packageRoot, 'server'));
  add(
    'serverBuild',
    build.ready,
    build.reason,
    'Restart the MCP host; the launcher rebuilds stale output.'
  );

  let files = [];
  try {
    const ping = await request(`http://localhost:${connectPort}/ping`);
    add('transport', ping.status === 'ok', ping);
    const rpc = await request(`http://localhost:${connectPort}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'list_files' }),
    });
    files = Array.isArray(rpc.data) ? rpc.data : [];
    add(
      'pluginConnection',
      files.length > 0,
      files,
      'Open the intended saved Figma file, run Figmoon, and keep its window open.'
    );
  } catch (error) {
    add('transport', false, error.message, 'Start or restart the MCP host.');
    add(
      'pluginConnection',
      false,
      [],
      'After transport starts, open the intended saved Figma file and run Figmoon.'
    );
  }

  if (fileKey || fileName) {
    const match = files.find(
      (file) => (!fileKey || file.fileKey === fileKey) && (!fileName || file.fileName === fileName)
    );
    add(
      'intendedFile',
      Boolean(match),
      match ?? { requested: { fileKey, fileName }, available: files },
      'Connect the exact requested file or correct --file-key/--file-name.'
    );
  }

  const probeFile = files.find(
    (file) => (!fileKey || file.fileKey === fileKey) && (!fileName || file.fileName === fileName)
  );
  if (probeFile) {
    add(
      'loadedPluginBuild',
      probeFile.pluginBuild === expectedPluginBuild,
      { expected: expectedPluginBuild, connected: probeFile.pluginBuild },
      'Rebuild Figmoon, re-import its manifest in Figma Desktop, and reopen the plugin.'
    );
    try {
      const rpc = await request(`http://localhost:${connectPort}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'get_editor_context', fileKey: probeFile.fileKey }),
      });
      const context = rpc.data;
      add(
        'workspaceContext',
        Boolean(context?.fileName && context?.currentPage?.id && Array.isArray(context?.pages)),
        {
          fileKey: probeFile.fileKey,
          fileName: context?.fileName,
          editorType: context?.editorType,
          currentPage: context?.currentPage,
          pageCount: context?.pages?.length,
          revision: context?.revision,
        },
        'Restart Figmoon in the intended file and rerun the doctor.'
      );
    } catch (error) {
      add(
        'workspaceContext',
        false,
        error.message,
        'Restart Figmoon in the intended file and rerun the doctor.'
      );
    }
  } else {
    add(
      'workspaceContext',
      false,
      'No matching connected file is available for a functional probe.',
      'Connect the intended file and rerun the doctor.'
    );
  }

  return { ready: checks.every((check) => check.ok), checks };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const report = await diagnose({ fileKey: parsed.fileKey, fileName: parsed.fileName });
  if (parsed.json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const check of report.checks) {
      console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${JSON.stringify(check.detail)}`);
      if (!check.ok && check.action) console.log(`  Next: ${check.action}`);
    }
    console.log(report.ready ? 'Figmoon is ready.' : 'Figmoon is not ready.');
  }
  process.exitCode = report.ready ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
