import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeFigmaAcquisitionPluginBundleSha256,
  FIGMA_ACQUISITION_PLUGIN_BUNDLE_FILES,
} from './lib/figma-plugin-integrity.mjs';

const toolRoot = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(toolRoot, 'plugin');
const integrityPath = join(toolRoot, 'integrity.json');
const acquisitionPath = join(pluginRoot, 'src/main/acquisition.ts');
const pluginPackage = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
const previous = JSON.parse(readFileSync(integrityPath, 'utf8'));

if (
  previous.schemaVersion !== 1 ||
  previous.algorithm !== 'sha256' ||
  previous.normalization !== 'figmoon-source-build-id/v1' ||
  previous.plugin?.id !== 'figmoon'
) {
  throw new Error('Refusing to update an unknown Figmoon integrity contract.');
}

const digest = computeFigmaAcquisitionPluginBundleSha256({ pluginRoot });
const provenance = previous.plugin.build?.match(/^[^+]+(\+.+\.sha256\.)[a-f0-9]{64}$/)?.[1];
if (!provenance) throw new Error('Existing Figmoon build identity has an invalid provenance form.');
const build = `${pluginPackage.version}${provenance}${digest}`;

const acquisitionSource = readFileSync(acquisitionPath, 'utf8');
const buildDeclarations = acquisitionSource.match(/const BUILD_ID\s*=\s*(['"])[^'"]+\1;/g) ?? [];
if (buildDeclarations.length !== 1) {
  throw new Error('Figmoon acquisition source must declare exactly one BUILD_ID.');
}
const nextAcquisitionSource = acquisitionSource.replace(
  buildDeclarations[0],
  `const BUILD_ID =\n  '${build}';`
);
if (nextAcquisitionSource !== acquisitionSource) {
  writeFileSync(acquisitionPath, nextAcquisitionSource);
}

const npmCli = process.env.npm_execpath;
const buildResult = npmCli
  ? spawnSync(process.execPath, [npmCli, 'run', 'build', '--prefix', pluginRoot], {
      cwd: toolRoot,
      encoding: 'utf8',
      stdio: 'inherit',
    })
  : spawnSync('npm', ['run', 'build', '--prefix', pluginRoot], {
      cwd: toolRoot,
      encoding: 'utf8',
      stdio: 'inherit',
    });
if (buildResult.error) throw buildResult.error;
if (buildResult.status !== 0) {
  throw new Error(`Figmoon plugin build failed with exit code ${buildResult.status}.`);
}

const artifacts = Object.fromEntries(
  Object.keys(previous.artifacts ?? {}).map((name) => [
    name,
    createHash('sha256')
      .update(readFileSync(join(pluginRoot, name)))
      .digest('hex'),
  ])
);
const next = {
  ...previous,
  files: [...FIGMA_ACQUISITION_PLUGIN_BUNDLE_FILES],
  bundleSha256: digest,
  artifacts,
  plugin: {
    ...previous.plugin,
    version: pluginPackage.version,
    build,
  },
};
const serialized = `${JSON.stringify(next, null, 2)}\n`;
if (serialized !== readFileSync(integrityPath, 'utf8')) writeFileSync(integrityPath, serialized);

console.log(`Figmoon integrity updated: ${build}`);
