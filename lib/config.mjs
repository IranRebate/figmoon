import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIGMOON_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function findUp(startDir, names) {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the consuming repository root.
 * Precedence: FIGMOON_CONSUMER_ROOT env > figmoon.config.json walk-up > package root.
 */
export function resolveConsumerRoot({ cwd = process.cwd() } = {}) {
  if (process.env.FIGMOON_CONSUMER_ROOT) return resolve(process.env.FIGMOON_CONSUMER_ROOT);
  const found = findUp(cwd, ['figmoon.config.json']);
  if (found) return found;
  return FIGMOON_PACKAGE_ROOT;
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function defaultNpmWorkspace(root) {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const workspaces = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : (pkg.workspaces?.packages ?? []);
    return workspaces.includes('client') ? 'client' : null;
  } catch {
    return null;
  }
}

/** npm argv fragment for running a consumer script (`['--workspace=client']` or `[]`). */
export function npmWorkspaceArgs(config = getFigmoonConfig()) {
  return config.npmWorkspace ? [`--workspace=${config.npmWorkspace}`] : [];
}

/**
 * Unified path configuration for evidence tooling.
 * Defaults preserve the classic monorepo layout (client/ + docs/design/)
 * relative to the consumer root; every path can be overridden in
 * figmoon.config.json under a "paths" key.
 */
export function loadFigmoonConfig({ consumerRoot, cwd } = {}) {
  const root = consumerRoot ?? resolveConsumerRoot({ cwd });
  const fileConfig = readJsonIfPresent(join(root, 'figmoon.config.json'));
  const paths = fileConfig.paths ?? {};

  const clientRoot = paths.clientRoot
    ? resolve(root, paths.clientRoot)
    : join(root, 'client');
  const designRoot = paths.designRoot
    ? resolve(root, paths.designRoot)
    : join(root, 'docs', 'design');
  const figmaRoot = paths.figmaRoot ? resolve(root, paths.figmaRoot) : join(designRoot, 'figma');

  const resolved = {
    consumerRoot: root,
    packageRoot: FIGMOON_PACKAGE_ROOT,
    clientRoot,
    designRoot,
    figmaRoot,
    registryPath: paths.registryPath
      ? resolve(root, paths.registryPath)
      : join(designRoot, 'pixel-perfect-registry.json'),
    registrySchemaPath: paths.registrySchemaPath
      ? resolve(root, paths.registrySchemaPath)
      : join(designRoot, 'pixel-perfect-registry.schema.json'),
    manifestPath: paths.manifestPath
      ? resolve(root, paths.manifestPath)
      : join(figmaRoot, 'reference-manifest.json'),
    manifestSchemaPath: paths.manifestSchemaPath
      ? resolve(root, paths.manifestSchemaPath)
      : join(figmaRoot, 'reference-manifest.schema.json'),
    referenceArtifactsRoot: paths.referenceArtifactsRoot
      ? resolve(root, paths.referenceArtifactsRoot)
      : join(figmaRoot, 'artifacts', 'sha256'),
    durableEvidenceRoot: paths.durableEvidenceRoot
      ? resolve(root, paths.durableEvidenceRoot)
      : join(designRoot, 'evidence', 'sha256'),
    referenceRunsRoot: paths.referenceRunsRoot
      ? resolve(root, paths.referenceRunsRoot)
      : join(clientRoot, 'e2e', 'figma-reference-runs'),
    visualEvidenceRunsRoot: paths.visualEvidenceRunsRoot
      ? resolve(root, paths.visualEvidenceRunsRoot)
      : join(clientRoot, 'e2e', 'figma-audit-results', 'runs'),
    snapshotRoot: paths.snapshotRoot
      ? resolve(root, paths.snapshotRoot)
      : join(clientRoot, 'e2e', 'visual-snapshots'),
    systemRoot: paths.systemRoot ? resolve(root, paths.systemRoot) : join(designRoot, 'system'),
    visualScenariosPath: paths.visualScenariosPath
      ? resolve(root, paths.visualScenariosPath)
      : join(clientRoot, 'src', 'lib', 'visualScenarios.ts'),
    dependencyGraphPath: paths.dependencyGraphPath
      ? resolve(root, paths.dependencyGraphPath)
      : join(designRoot, 'system', 'dependency-graph.json'),
    screenRegistryPath: paths.screenRegistryPath
      ? resolve(root, paths.screenRegistryPath)
      : join(designRoot, 'system', 'screen-registry.json'),
    componentInventoryPath: paths.componentInventoryPath
      ? resolve(root, paths.componentInventoryPath)
      : join(designRoot, 'system', 'figma-component-inventory.json'),
    visualQaExceptionsPath: paths.visualQaExceptionsPath
      ? resolve(root, paths.visualQaExceptionsPath)
      : join(designRoot, 'visual-qa-exceptions.json'),
    visualQaPolicyPath: paths.visualQaPolicyPath
      ? resolve(root, paths.visualQaPolicyPath)
      : join(designRoot, 'visual-qa-policy.json'),
    visualQaPolicySchemaPath: paths.visualQaPolicySchemaPath
      ? resolve(root, paths.visualQaPolicySchemaPath)
      : join(designRoot, 'visual-qa-policy.schema.json'),
    inboxRoot: paths.inboxRoot ? resolve(root, paths.inboxRoot) : join(figmaRoot, 'inbox'),
    diffReportRoot: paths.diffReportRoot
      ? resolve(root, paths.diffReportRoot)
      : join(clientRoot, 'e2e', 'figma-diff-report'),
    auditResultsRoot: paths.auditResultsRoot
      ? resolve(root, paths.auditResultsRoot)
      : join(clientRoot, 'e2e', 'figma-audit-results'),
    probeResultsRoot: paths.probeResultsRoot
      ? resolve(root, paths.probeResultsRoot)
      : join(clientRoot, 'e2e', 'figma-probe-results'),
    inspectionResultsRoot: paths.inspectionResultsRoot
      ? resolve(root, paths.inspectionResultsRoot)
      : join(clientRoot, 'e2e', 'figma-inspection-results'),
    dailySyncStateRoot: paths.dailySyncStateRoot
      ? resolve(root, paths.dailySyncStateRoot)
      : join(root, '.cache', 'figma-daily-sync'),
    timezone: fileConfig.timezone ?? 'UTC',
    connectPort: Number(process.env.FIGMOON_CONNECT_PORT ?? fileConfig.connectPort ?? 29194),
    referencesPort: Number(
      process.env.FIGMOON_REFERENCES_PORT ?? fileConfig.referencesPort ?? 29195
    ),
    /** npm workspace name for consumer monorepos, or null for a flat package. */
    npmWorkspace: fileConfig.npmWorkspace === undefined ? defaultNpmWorkspace(root) : fileConfig.npmWorkspace,
  };

  return Object.freeze(resolved);
}

let cachedConfig = null;

export function getFigmoonConfig(options) {
  if (options) return loadFigmoonConfig(options);
  if (!cachedConfig) cachedConfig = loadFigmoonConfig();
  return cachedConfig;
}

export function resetFigmoonConfigCache() {
  cachedConfig = null;
}
