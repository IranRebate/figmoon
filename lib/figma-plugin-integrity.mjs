import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const FIGMOON_PACKAGE_ROOT = resolve(moduleDir, '..');
export const FIGMA_ACQUISITION_PLUGIN_ROOT = join(FIGMOON_PACKAGE_ROOT, 'plugin');
export const FIGMA_ACQUISITION_PLUGIN_INTEGRITY_PATH = join(
  FIGMOON_PACKAGE_ROOT,
  'integrity.json'
);

export const FIGMA_ACQUISITION_PLUGIN_BUNDLE_FILES = Object.freeze([
  'manifest.json',
  'package-lock.json',
  'package.json',
  'src/main/acquisition.ts',
  'src/main/code.ts',
  'src/main/design-system.ts',
  'src/main/pattern-analysis.mjs',
  'src/main/serializer.ts',
  'src/main/workspace.ts',
  'src/ui/App.tsx',
  'src/ui/index.css',
  'src/ui/index.html',
  'src/ui/main.tsx',
  'tsconfig.json',
  'vite.config.main.ts',
  'vite.config.ts',
]);
const BUILD_PLACEHOLDER = "const BUILD_ID = '<CONTENT_DERIVED_BUILD_ID>';";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizedBundleBytes(pluginRoot, name) {
  const bytes = readFileSync(join(pluginRoot, name));
  if (name !== 'src/main/acquisition.ts') return bytes;
  const source = bytes.toString('utf8');
  const matches = source.match(/const BUILD_ID\s*=\s*(['"])[^'"]+\1;/g) ?? [];
  if (matches.length !== 1) {
    throw new Error(`Figma acquisition plugin ${name} must declare exactly one BUILD_ID.`);
  }
  return Buffer.from(source.replace(matches[0], BUILD_PLACEHOLDER));
}

export function computeFigmaAcquisitionPluginBundleSha256({
  pluginRoot = FIGMA_ACQUISITION_PLUGIN_ROOT,
} = {}) {
  const hash = createHash('sha256');
  for (const name of FIGMA_ACQUISITION_PLUGIN_BUNDLE_FILES) {
    const bytes = normalizedBundleBytes(pluginRoot, name);
    hash.update(name);
    hash.update('\0');
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function assertFigmaAcquisitionPluginIntegrity({
  pluginRoot = FIGMA_ACQUISITION_PLUGIN_ROOT,
  integrityPath = FIGMA_ACQUISITION_PLUGIN_INTEGRITY_PATH,
} = {}) {
  const integrity = JSON.parse(readFileSync(integrityPath, 'utf8'));
  const digest = computeFigmaAcquisitionPluginBundleSha256({ pluginRoot });
  const expectedBuild = `${integrity.plugin?.version}+gethopp-v0.0.18.dc2ea5a.sha256.${digest}`;
  if (
    integrity.schemaVersion !== 1 ||
    integrity.algorithm !== 'sha256' ||
    integrity.normalization !== 'figmoon-source-build-id/v1' ||
    JSON.stringify(integrity.files) !== JSON.stringify(FIGMA_ACQUISITION_PLUGIN_BUNDLE_FILES) ||
    integrity.plugin?.id !== 'figmoon' ||
    integrity.bundleSha256 !== digest ||
    integrity.plugin?.build !== expectedBuild
  ) {
    throw new Error(
      'Figma acquisition plugin integrity does not match its repository bundle. Rebuild the content-derived identity before acquisition.'
    );
  }

  const source = readFileSync(join(pluginRoot, 'src/main/acquisition.ts'), 'utf8');
  if (
    !new RegExp(
      `const PLUGIN_VERSION\\s*=\\s*['"]${escapeRegExp(integrity.plugin.version)}['"]\\s*;`
    ).test(source) ||
    !new RegExp(`const BUILD_ID\\s*=\\s*['"]${escapeRegExp(integrity.plugin.build)}['"]\\s*;`).test(
      source
    )
  ) {
    throw new Error('Figmoon acquisition source does not declare the trusted identity.');
  }
  for (const [name, expected] of Object.entries(integrity.artifacts ?? {})) {
    const actual = createHash('sha256')
      .update(readFileSync(join(pluginRoot, name)))
      .digest('hex');
    if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
      throw new Error(`Figmoon built artifact does not match its trusted source: ${name}`);
    }
  }
  return Object.freeze({
    ...integrity,
    files: Object.freeze([...integrity.files]),
    plugin: Object.freeze({ ...integrity.plugin }),
  });
}
