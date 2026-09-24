import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export const TARGET_SOURCE_FINGERPRINT_VERSION = 1;

// These inputs affect every deterministic visual capture. Changes to unrelated
// product or server files stay outside the digest, while capture/runtime changes
// intentionally invalidate every target that depended on them.
export const TARGET_SOURCE_SHARED_FILES = Object.freeze([
  'package-lock.json',
  'client/package.json',
  'client/index.html',
  'client/playwright.config.ts',
  'client/vite.config.ts',
  'client/scripts/lib/figma-capture-runtime.mjs',
  'client/e2e/fixtures/visual-data.ts',
  'client/e2e/helpers/setup.ts',
  'client/public/mockServiceWorker.js',
  'client/src/index.css',
  'client/src/main.tsx',
  'client/src/components/shared/VisualQABootstrap.tsx',
  'client/src/lib/visualQA.ts',
  'client/src/lib/visualScenarios.ts',
  'client/src/test/visual-handlers.ts',
]);

export const TARGET_SOURCE_SHARED_DIRECTORIES = Object.freeze(['client/public/fonts']);
export const TARGET_SOURCE_OPTIONAL_FILES = Object.freeze([
  'client/.env',
  'client/.env.local',
  'client/.env.development',
  'client/.env.development.local',
]);
export const TARGET_SOURCE_SHARED_RUNTIME_ROOTS = Object.freeze(['client/src/main.tsx']);

function stableJson(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, normalize(entry[key])])
      );
    }
    return entry;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function repoRelativePath(repoRoot, declaredPath) {
  if (typeof declaredPath !== 'string' || !declaredPath.trim()) {
    throw new Error('Target source dependencies require non-empty repository-relative paths.');
  }
  const absolute = resolve(repoRoot, declaredPath);
  const repoRelative = relative(repoRoot, absolute);
  if (
    !repoRelative ||
    repoRelative === '..' ||
    repoRelative.startsWith(`..${sep}`) ||
    repoRelative.startsWith(sep)
  ) {
    throw new Error(`Target source dependency escapes the repository: ${declaredPath}`);
  }
  return repoRelative.split(sep).join('/');
}

function addDirectoryFiles(files, repoRoot, declaredDirectory) {
  const directory = resolve(repoRoot, repoRelativePath(repoRoot, declaredDirectory));
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
    throw new Error(`Target source shared directory is missing: ${declaredDirectory}`);
  }
  const pending = [directory];
  const added = [];
  while (pending.length) {
    const current = pending.pop();
    for (const name of readdirSync(current).sort()) {
      const absolute = resolve(current, name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(
          `Target source dependencies must not traverse symbolic links: ${relative(repoRoot, absolute)}`
        );
      }
      if (info.isDirectory()) pending.push(absolute);
      else if (info.isFile()) {
        const path = repoRelativePath(repoRoot, absolute);
        if (!files.has(path)) added.push(path);
        files.add(path);
      }
    }
  }
  return added;
}

function referencedAssetPaths(source, sourcePath, repoRoot) {
  const assets = new Set();
  const sourceDirectory = resolve(repoRoot, sourcePath, '..');
  const addLocalAsset = (specifier) => {
    const withoutQuery = specifier.split(/[?#]/, 1)[0];
    if (!withoutQuery) return;
    const absolute = withoutQuery.startsWith('/')
      ? resolve(repoRoot, 'client', 'public', withoutQuery.slice(1))
      : resolve(sourceDirectory, withoutQuery);
    if (existsSync(absolute)) assets.add(repoRelativePath(repoRoot, absolute));
  };

  for (const match of source.matchAll(
    /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\bnew\s+URL\s*\(\s*)['"]([^'"]+\.(?:css|json|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf)(?:[?#][^'"]*)?)['"]/g
  )) {
    if (match[1].startsWith('.') || match[1].startsWith('/')) addLocalAsset(match[1]);
  }
  for (const match of source.matchAll(/(?:['"`(])\/(images|icons|fonts)\/([^'"`()?#\s$]+)/g)) {
    addLocalAsset(`/${match[1]}/${match[2]}`);
  }
  for (const match of source.matchAll(/\burl\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g)) {
    if (match[1].startsWith('.') || match[1].startsWith('/')) addLocalAsset(match[1]);
  }
  return assets;
}

function relevantComponents(item, dependencyGraph) {
  return (dependencyGraph.components ?? []).filter((component) =>
    component.visualCoverage?.registryIds?.includes(item.id)
  );
}

function addImportClosure(files, roots, dependencyGraph) {
  const importsBySource = new Map(
    (dependencyGraph.sourceImports ?? []).map((source) => [source.module, source.imports ?? []])
  );
  const pending = [...roots];
  while (pending.length) {
    const source = pending.shift();
    if (source) files.add(source);
    for (const imported of importsBySource.get(source) ?? []) {
      if (files.has(imported)) continue;
      files.add(imported);
      pending.push(imported);
    }
  }
}

export function targetDependencyFiles({ item, dependencyGraph, screenRegistry }) {
  const files = new Set(
    [...(item.implementationPaths ?? []), item.visualTest?.file].filter(Boolean)
  );
  const screen = (screenRegistry.screens ?? []).find(
    (candidate) => candidate.visualRegistryId === item.id
  );
  if (screen?.implementation?.module) files.add(screen.implementation.module);
  if (screen?.implementation?.mount?.module) files.add(screen.implementation.mount.module);

  const components = relevantComponents(item, dependencyGraph);
  for (const component of components) {
    if (component.codeModule) files.add(component.codeModule);
  }

  // Traverse production owners and explicit target dependencies. A shared fixture
  // hub can import every visual scenario, so traversing it would make unrelated
  // scenarios invalidate this target. Pixel-driving fixture data belongs in the
  // target's implementationPaths and therefore participates in this traversal.
  addImportClosure(files, [...files], dependencyGraph);

  // Keep the fixture owner itself in the fingerprint without treating every
  // scenario imported by a shared hub as a dependency of this target.
  for (const component of components) {
    const visualCoverage = component.visualCoverage ?? {};
    if (visualCoverage.fixtureModule) files.add(visualCoverage.fixtureModule);
  }
  return files;
}

function targetSourceContract({ item, dependencyGraph, screenRegistry, environment }) {
  const screen = (screenRegistry.screens ?? []).find(
    (candidate) => candidate.visualRegistryId === item.id
  );
  const components = relevantComponents(item, dependencyGraph)
    .map((component) => ({
      id: component.id,
      codeModule: component.codeModule ?? null,
      fixtureModule: component.visualCoverage?.fixtureModule ?? null,
      testFile: component.visualCoverage?.testFile ?? null,
      testFiles: component.visualCoverage?.testFiles ?? [],
      testNames: component.visualCoverage?.testNames ?? [],
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: TARGET_SOURCE_FINGERPRINT_VERSION,
    target: {
      id: item.id,
      kind: item.kind ?? null,
      route: item.route ?? null,
      viewport: item.viewport ?? null,
      theme: item.theme ?? null,
      mockScenario: item.mockScenario ?? null,
      captureViewport: item.captureViewport ?? null,
      visualTest: item.visualTest ?? null,
      snapshot: item.snapshot ?? null,
      implementationPaths: [...(item.implementationPaths ?? [])].sort(),
      maxDiffPixelRatio: item.maxDiffPixelRatio ?? null,
      crops: item.crops ?? [],
    },
    screen: screen
      ? {
          id: screen.id,
          route: screen.route ?? null,
          runtimeRoute: screen.runtimeRoute ?? null,
          scenario: screen.scenario ?? null,
          viewport: screen.viewport ?? null,
          implementation: screen.implementation ?? null,
        }
      : null,
    components,
    viteEnvironment: Object.fromEntries(
      Object.keys(environment)
        .filter((name) => name.startsWith('VITE_'))
        .sort()
        .map((name) => [name, sha256(String(environment[name] ?? ''))])
    ),
  };
}

export function targetSourceState({
  item,
  dependencyGraph,
  screenRegistry,
  repoRoot,
  sharedFiles = TARGET_SOURCE_SHARED_FILES,
  sharedDirectories = TARGET_SOURCE_SHARED_DIRECTORIES,
  optionalFiles = TARGET_SOURCE_OPTIONAL_FILES,
  sharedRuntimeRoots = TARGET_SOURCE_SHARED_RUNTIME_ROOTS,
  environment = process.env,
}) {
  if (!repoRoot) throw new Error('Target source fingerprint requires repoRoot.');
  const files = new Set(
    [...targetDependencyFiles({ item, dependencyGraph, screenRegistry }), ...sharedFiles].map(
      (path) => repoRelativePath(repoRoot, path)
    )
  );
  for (const optionalPath of optionalFiles) {
    const normalized = repoRelativePath(repoRoot, optionalPath);
    if (existsSync(resolve(repoRoot, normalized))) files.add(normalized);
  }
  addImportClosure(files, sharedRuntimeRoots, dependencyGraph);
  for (const directory of sharedDirectories) addDirectoryFiles(files, repoRoot, directory);

  // Bind static assets used by the target without hashing every unrelated public
  // asset. Newly discovered text assets (for example CSS) are scanned in turn.
  const pendingAssets = [...files];
  const scanned = new Set();
  while (pendingAssets.length) {
    const sourcePath = pendingAssets.shift();
    if (scanned.has(sourcePath)) continue;
    scanned.add(sourcePath);
    const absolute = resolve(repoRoot, sourcePath);
    if (!existsSync(absolute))
      throw new Error(`Target source dependency is missing: ${sourcePath}`);
    const info = lstatSync(absolute);
    if (info.isSymbolicLink() || !info.isFile() || realpathSync(absolute) !== absolute) {
      throw new Error(
        `Target source dependency must be a regular in-repository file: ${sourcePath}`
      );
    }
    if (!/\.(?:[cm]?[jt]sx?|css|html|json)$/i.test(sourcePath)) continue;
    const source = readFileSync(absolute, 'utf8');
    for (const assetPath of referencedAssetPaths(source, sourcePath, repoRoot)) {
      if (files.has(assetPath)) continue;
      const assetInfo = lstatSync(resolve(repoRoot, assetPath));
      if (assetInfo.isDirectory()) {
        pendingAssets.push(...addDirectoryFiles(files, repoRoot, assetPath));
        continue;
      }
      files.add(assetPath);
      pendingAssets.push(assetPath);
    }
  }

  const contract = targetSourceContract({ item, dependencyGraph, screenRegistry, environment });
  const contractBytes = stableJson(contract);
  const hash = createHash('sha256');
  hash.update(`figmoon-target-source/v${TARGET_SOURCE_FINGERPRINT_VERSION}\0`);
  hash.update(contractBytes);
  hash.update('\0');
  const fileEvidence = [];
  for (const path of [...files].sort()) {
    const absolute = resolve(repoRoot, path);
    if (!existsSync(absolute)) throw new Error(`Target source dependency is missing: ${path}`);
    const info = lstatSync(absolute);
    if (info.isSymbolicLink() || !info.isFile() || realpathSync(absolute) !== absolute) {
      throw new Error(`Target source dependency must be a regular in-repository file: ${path}`);
    }
    const bytes = readFileSync(absolute);
    const fileSha256 = sha256(bytes);
    hash.update(path);
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
    fileEvidence.push({ path, sha256: fileSha256 });
  }
  return {
    schemaVersion: TARGET_SOURCE_FINGERPRINT_VERSION,
    fingerprint: hash.digest('hex'),
    contractSha256: sha256(contractBytes),
    files: fileEvidence,
  };
}

export function assertTargetSourceFingerprint(recordedFingerprint, currentState, label) {
  if (!/^[a-f0-9]{64}$/.test(recordedFingerprint ?? '')) {
    throw new Error(`${label} is missing a valid target source/input fingerprint.`);
  }
  if (recordedFingerprint !== currentState?.fingerprint) {
    throw new Error(
      `${label} is stale because this target's implementation or shared visual inputs changed.`
    );
  }
}

export function assertVisualEvidenceTargetSource(evidence, currentState, label) {
  const recordedFingerprint = evidence?.targetSourceState?.fingerprint;
  assertTargetSourceFingerprint(recordedFingerprint, currentState, label);
  if (
    evidence?.targetSourceMutationGuard?.changed !== false ||
    evidence.targetSourceMutationGuard.beforeFingerprint !== recordedFingerprint ||
    evidence.targetSourceMutationGuard.afterFingerprint !== recordedFingerprint
  ) {
    throw new Error(`${label} did not prove a stable target source/input state.`);
  }
}

export function baselineReceiptInvalidatesSignoff(signoff, nextBaselineReceiptSha256) {
  if (!signoff) return false;
  if (!/^[a-f0-9]{64}$/.test(nextBaselineReceiptSha256 ?? '')) {
    throw new Error('Baseline promotion requires a valid durable receipt SHA-256.');
  }
  return signoff.baselinePromotionReceiptSha256 !== nextBaselineReceiptSha256;
}

export function findingBelongsToTarget(finding, targetFiles) {
  return (
    targetFiles.has(finding.file) ||
    finding.file.startsWith('client/e2e/helpers/') ||
    finding.file === 'client/playwright.config.ts'
  );
}
