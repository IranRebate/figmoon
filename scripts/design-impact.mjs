#!/usr/bin/env node

/**
 * Maps a changed-file set to affected design-system components, registry targets,
 * and the smallest verification commands. It never runs those commands itself.
 *
 * Usage:
 *   node scripts/design-impact.mjs --base origin/main
 *   node scripts/design-impact.mjs --files client/src/components/chat/ChatInput.tsx
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzePixelRegistryDiff,
  analyzeReferenceManifestDiff,
  publicAssetConsumerModules,
  referenceTargetIdsForFiles,
} from './lib/design-impact-contract.mjs';
import { visualProjectForTarget } from './lib/figma-visual-project.mjs';

import { getFigmoonConfig, npmWorkspaceArgs } from '../lib/config.mjs';
const __figmoonConfig = getFigmoonConfig();
const repoRoot = __figmoonConfig.consumerRoot;
const systemRoot = __figmoonConfig.systemRoot;
const argv = process.argv.slice(2);

function writeStdout(value) {
  return new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(`${value}\n`, (error) => (error ? rejectWrite(error) : resolveWrite()));
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function argumentValue(flag) {
  const inline = argv.find((argument) => argument.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function normalizeFilePath(file) {
  const normalized = file.replace(/^\.\//, '');
  if (existsSync(resolve(repoRoot, normalized))) return normalized;

  // `npm run` is commonly invoked from `client`, while dependency graph nodes
  // are repository-relative. Accept both forms so a valid local path cannot
  // silently produce an empty impact report.
  const cwdFromRoot = relative(repoRoot, process.cwd());
  if (cwdFromRoot && !cwdFromRoot.startsWith('..')) {
    const fromCwd = `${cwdFromRoot}/${normalized}`;
    if (existsSync(resolve(repoRoot, fromCwd))) return fromCwd;
  }

  return normalized;
}

function gitLines(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function readJsonAtRevision(revision, path) {
  try {
    return JSON.parse(
      execFileSync('git', ['show', `${revision}:${path}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    );
  } catch {
    return null;
  }
}

function changedFiles() {
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--files') {
      while (argv[index + 1] && !argv[index + 1].startsWith('--')) {
        files.push(normalizeFilePath(argv[++index]));
      }
    } else if (argument.startsWith('--files=')) {
      files.push(normalizeFilePath(argument.slice('--files='.length)));
    }
  }
  if (files.length) return unique(files);

  const base = argumentValue('--base') ?? 'HEAD';
  return unique([
    ...gitLines(['diff', '--name-only', base, '--']),
    ...gitLines(['ls-files', '--others', '--exclude-standard']),
  ]);
}

function adjacentTests(files) {
  return unique(
    files.flatMap((file) => {
      if (!file.startsWith('client/src/') || !/\.(ts|tsx)$/.test(file)) return [];
      if (/\.(test|spec)\.(ts|tsx)$/.test(file)) return [file.slice('client/'.length)];
      const testPath = file.replace(/\.(ts|tsx)$/, '.test.$1');
      return existsSync(resolve(repoRoot, testPath)) ? [testPath.slice('client/'.length)] : [];
    })
  );
}

const files = changedFiles();
const asJson = argv.includes('--json');
if (files.length === 0) {
  const empty = { changedFiles: [], message: 'No changed or untracked files were found.' };
  console.log(asJson ? JSON.stringify(empty, null, 2) : empty.message);
  process.exit(0);
}

const pixelRegistry = readJson(__figmoonConfig.registryPath);
const referenceManifest = readJson(__figmoonConfig.manifestPath);
const dependencyGraph = readJson(__figmoonConfig.dependencyGraphPath);
const screenRegistry = readJson(__figmoonConfig.screenRegistryPath);
const base = argumentValue('--base') ?? 'HEAD';
execFileSync('git', ['rev-parse', '--verify', `${base}^{commit}`], {
  cwd: repoRoot,
  stdio: 'ignore',
});
const registryPath = relative(repoRoot, __figmoonConfig.registryPath);
const manifestPath = relative(repoRoot, __figmoonConfig.manifestPath);
const registryDiff = files.includes(registryPath)
  ? analyzePixelRegistryDiff(readJsonAtRevision(base, registryPath), pixelRegistry)
  : { changedItemIds: [], targetIds: [], globalContractChanged: false };
const manifestDiff = files.includes(manifestPath)
  ? analyzeReferenceManifestDiff(readJsonAtRevision(base, manifestPath), referenceManifest)
  : { changedItemKeys: [], targetIds: [], globalContractChanged: false };
const referenceAssetTargetIds = referenceTargetIdsForFiles(files, [
  readJsonAtRevision(base, manifestPath),
  referenceManifest,
]);
const GLOBAL_DESIGN_PREFIXES = [
  'docs/design/system/',
  'client/src/design-system/',
  'extension/src/design-system/',
  'client/scripts/generate-design-system-',
  'client/public/fonts/',
];
const GLOBAL_DESIGN_FILES = new Set([
  'client/src/index.css',
  'client/src/App.tsx',
  'client/src/main.tsx',
  'client/src/lib/visualScenarios.ts',
  'client/src/test/visual-handlers.ts',
  'client/e2e/helpers/setup.ts',
  'client/playwright.config.ts',
  'client/package.json',
  'client/vite.config.ts',
  'package-lock.json',
  'docs/design/pixel-perfect-registry.schema.json',
  'docs/design/figma/reference-manifest.schema.json',
]);
// Visual-QA composition modules are terminal consumers: they import many
// unrelated product components solely so the harness can render isolated
// scenarios. Letting reverse-import traversal continue through them makes a
// one-component change look like a repository-wide product impact.
const TERMINAL_VISUAL_HARNESS_MODULES = new Set([
  // Runtime/bootstrap composition roots import many sibling routes. They are
  // useful trace endpoints, not proof that every sibling route changed.
  'client/src/App.tsx',
  'client/src/main.tsx',
  'client/src/lib/pageLoaders.ts',
  'client/src/components/shared/VisualQAComponents.tsx',
  'client/src/components/shared/VisualQABootstrap.tsx',
]);

function isTerminalVisualHarness(module) {
  return (
    TERMINAL_VISUAL_HARNESS_MODULES.has(module) ||
    module.startsWith('client/e2e/') ||
    /\.(?:test|spec)\.(?:ts|tsx)$/.test(module)
  );
}
const globalDesignChange =
  files.some(
    (file) =>
      GLOBAL_DESIGN_FILES.has(file) ||
      (file.startsWith('client/') && file.endsWith('.css')) ||
      GLOBAL_DESIGN_PREFIXES.some((prefix) => file.startsWith(prefix))
  ) ||
  registryDiff.globalContractChanged ||
  manifestDiff.globalContractChanged;
const importersByModule = new Map();
for (const source of dependencyGraph.sourceImports ?? []) {
  for (const importedModule of source.imports ?? []) {
    const importers = importersByModule.get(importedModule) ?? [];
    importers.push(source.module);
    importersByModule.set(importedModule, importers);
  }
}

const sourceModules = (dependencyGraph.sourceImports ?? []).flatMap((source) => {
  const path = resolve(repoRoot, source.module);
  if (!existsSync(path)) return [];
  return [{ module: source.module, content: readFileSync(path, 'utf8') }];
});
const assetConsumers = publicAssetConsumerModules(files, sourceModules);

function impactedModulesFrom(filesToTrace) {
  const impacted = new Set(filesToTrace);
  const pending = [...impacted];
  while (pending.length) {
    const module = pending.shift();
    for (const importer of importersByModule.get(module) ?? []) {
      if (impacted.has(importer)) continue;
      impacted.add(importer);
      if (!isTerminalVisualHarness(importer)) pending.push(importer);
    }
  }
  return impacted;
}

const impactedModules = globalDesignChange
  ? new Set()
  : impactedModulesFrom([...files, ...assetConsumers.modules]);

const affectedComponents = (dependencyGraph.components ?? []).filter((component) => {
  if (globalDesignChange) return true;
  return (
    impactedModules.has(component.codeModule) ||
    component.directConsumers?.some(
      (consumer) => !isTerminalVisualHarness(consumer.file) && impactedModules.has(consumer.file)
    )
  );
});

const affectedScreens = (screenRegistry.screens ?? []).filter((screen) => {
  if (globalDesignChange) return true;
  if (
    !isTerminalVisualHarness(screen.implementation?.module ?? '') &&
    impactedModules.has(screen.implementation?.module)
  ) {
    return true;
  }
  return affectedComponents.some((component) =>
    component.affectedScreens?.some((affected) => affected.id === screen.id)
  );
});

// A screen owner identifies the page-level composition, but a target can also
// declare its direct product owners. This catches shared child components whose
// changes affect multiple states of the same route without making the component
// registry pretend there is an isolated Figma component source.
const directlyOwnedTargets = (pixelRegistry.items ?? []).filter(
  (item) =>
    globalDesignChange ||
    item.implementationPaths?.some(
      (implementationPath) =>
        !isTerminalVisualHarness(implementationPath) && impactedModules.has(implementationPath)
    )
);

const targetIds = unique([
  ...registryDiff.targetIds,
  ...manifestDiff.targetIds,
  ...referenceAssetTargetIds,
  ...affectedComponents.flatMap((component) => component.visualCoverage?.registryIds ?? []),
  ...affectedScreens.map((screen) => screen.visualRegistryId),
  ...directlyOwnedTargets.map((target) => target.id),
  ...pixelRegistry.items
    .filter((item) => files.includes(item.visualTest?.file) || files.includes(item.snapshot))
    .map((item) => item.id),
]);
const targets = targetIds
  .map((id) => pixelRegistry.items.find((item) => item.id === id))
  .filter(Boolean)
  .sort((left, right) => {
    const order = {
      'in-progress': 0,
      drifting: 1,
      parity: 2,
      locked: 3,
      'not-comparable': 4,
      waived: 5,
    };
    return (
      (order[left.parityStatus] ?? 9) - (order[right.parityStatus] ?? 9) ||
      left.id.localeCompare(right.id)
    );
  });
const unitTests = adjacentTests(files);
const visualTargets = targets.map((target) => {
  const project = visualProjectForTarget(target);
  const measurable = Boolean(
    project &&
    target.visualTest?.file &&
    target.visualTest?.name &&
    target.referencePath &&
    target.referenceStatus === 'mapped'
  );
  return {
    id: target.id,
    project: project ?? null,
    visualTest: target.visualTest ?? null,
    snapshot: target.snapshot ?? null,
    measurable,
    reason: measurable
      ? null
      : !project
        ? 'No Playwright project is registered for this viewport.'
        : !target.visualTest?.file || !target.visualTest?.name
          ? 'No exact visual test is registered.'
          : !target.referencePath
            ? 'No Figma reference is registered.'
            : target.referenceStatus === 'requires-remap'
              ? 'The Figma reference requires remap before visual measurement.'
              : target.referenceStatus !== 'mapped'
                ? 'The Figma reference is not mapped for visual measurement.'
                : 'Target cannot be captured by the current visual harness.',
  };
});
const coverageGaps = visualTargets.filter((target) => !target.measurable);
const workspaceArgs = npmWorkspaceArgs(__figmoonConfig);
const workspaceFlag = workspaceArgs[0] ? ` ${workspaceArgs[0]}` : '';
const commands = [];
if (unitTests.length) {
  commands.push(
    `npm test${workspaceFlag} -- --run ${unitTests.join(' ')}`
  );
}
const designContractChanged = files.some(
  (file) => file === registryPath || file === manifestPath || GLOBAL_DESIGN_FILES.has(file)
);
if (globalDesignChange || designContractChanged) {
  commands.push(`npm run design:check${workspaceFlag}`);
}
if (visualTargets.some((target) => target.measurable)) {
  commands.push(
    `npm run design:verify${workspaceFlag} -- --files ${files.join(' ')} --measure --max-parallel 2`
  );
}

const output = {
  changedFiles: files,
  limitations: [
    'Static import analysis is conservative; inspect the target card before mutation.',
    'Run-scoped measurement can fan out across affected targets; code mutation and baseline promotion remain target-specific.',
  ],
  affected: {
    globalDesignChange,
    contractChanges: {
      pixelRegistryItemIds: registryDiff.changedItemIds,
      referenceManifestItemKeys: manifestDiff.changedItemKeys,
      referenceAssetTargetIds,
    },
    assetConsumers: {
      modules: assetConsumers.modules,
      unmappedFiles: assetConsumers.unmappedFiles,
    },
    impactedModules: [...impactedModules].sort(),
    components: affectedComponents.map((component) => ({
      id: component.id,
      codeModule: component.codeModule,
      impactRoutes: component.impactSurfaces.flatMap((surface) => surface.routes ?? []),
    })),
    screens: affectedScreens.map((screen) => ({
      id: screen.id,
      route: screen.route,
      visualRegistryId: screen.visualRegistryId,
    })),
    registryOwners: directlyOwnedTargets.map((target) => ({
      id: target.id,
      implementationPaths: target.implementationPaths ?? [],
    })),
    targets: targets.map((target) => ({
      id: target.id,
      parityStatus: target.parityStatus,
      visualTest: target.visualTest ?? null,
    })),
  },
  verification: {
    unitTests,
    visualTargets,
    coverageGaps,
    recommendedCommands: commands,
  },
};

if (asJson) {
  // The verifier captures this through a pipe. Awaiting the write prevents
  // process.exit() from truncating a large impact matrix at the pipe buffer.
  await writeStdout(JSON.stringify(output, null, 2));
  process.exit(0);
}

console.log('\n── Design Impact ───────────────────────────────────────────────\n');
console.log(`Changed files: ${files.length}`);
console.log(
  `Affected components: ${output.affected.components.map((component) => component.id).join(', ') || 'none'}`
);
console.log(
  `Affected targets: ${output.affected.targets.map((target) => target.id).join(', ') || 'none'}`
);
console.log(`Global design contract changed: ${globalDesignChange ? 'yes' : 'no'}`);
console.log('\nRecommended verification:');
for (const command of commands) console.log(`  ${command}`);
if (coverageGaps.length) {
  console.log(
    `Visual coverage gaps: ${coverageGaps.map((target) => `${target.id} (${target.reason})`).join(', ')}`
  );
}
if (!commands.length)
  console.log('  No client design verification was inferred from this file set.');
