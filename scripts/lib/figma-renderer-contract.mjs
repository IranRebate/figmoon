import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { chromium } from '@playwright/test';

export const FIGMA_RENDERER_EXECUTABLE_PATH = chromium.executablePath();
export const FIGMA_RENDERER_LAUNCH_ARGS = Object.freeze(['--force-color-profile=srgb']);
export const FIGMA_VISUAL_PROJECTS = Object.freeze([
  'desktop',
  'mobile',
  'mobile-components',
  'tablet-landscape',
  'tablet-portrait',
]);
export const FIGMA_RENDERER_CAPTURE_CONTRACT = Object.freeze({
  browserName: 'chromium',
  browserDistribution: 'playwright-managed-chromium',
  headless: true,
  launchArgs: FIGMA_RENDERER_LAUNCH_ARGS,
  colorProfile: 'srgb',
  colorScheme: 'light',
  deviceScaleFactor: 1,
  locale: 'fa-IR',
  reducedMotion: 'reduce',
  timezoneId: 'UTC',
});

export const FIGMA_RENDERER_ATTESTATION_PATH_ENV = 'FIGMA_RENDERER_ATTESTATION_PATH';
export const FIGMA_RENDERER_EXPECTED_EXECUTABLE_ENV = 'FIGMA_RENDERER_EXPECTED_EXECUTABLE';
export const FIGMA_RENDERER_EXPECTED_VERSION_ENV = 'FIGMA_RENDERER_EXPECTED_VERSION';
export const FIGMA_RENDERER_EXPECTED_COLOR_PROFILE_ENV = 'FIGMA_RENDERER_EXPECTED_COLOR_PROFILE';
export const FIGMA_RENDERER_EXPECTED_CONTRACT_ENV = 'FIGMA_RENDERER_EXPECTED_CONTRACT';

const SHA256_RE = /^[a-f0-9]{64}$/;
const FILE_READ_BUFFER_BYTES = 1024 * 1024;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW;

function pathIsWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedRelativePath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function fileIdentity(stat) {
  return {
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    size: stat.size,
    modified: stat.mtimeNs,
    changed: stat.ctimeNs,
  };
}

function sameFileIdentity(left, right) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed
  );
}

function assertEntryIdentity(path, expectedIdentity, expectedType, label) {
  const current = lstatSync(path, { bigint: true });
  const correctType =
    (expectedType === 'directory' && current.isDirectory()) ||
    (expectedType === 'file' && current.isFile()) ||
    (expectedType === 'symlink' && current.isSymbolicLink());
  if (!correctType || !sameFileIdentity(fileIdentity(current), expectedIdentity)) {
    throw new Error(`Playwright Chromium distribution entry changed while hashing: ${label}`);
  }
  return current;
}

function collectDistributionEntries(root) {
  const entries = [];
  const rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Playwright Chromium distribution root must be a real directory.');
  }
  const stack = [{ path: root, identity: fileIdentity(rootStat) }];
  while (stack.length) {
    const directory = stack.pop();
    assertEntryIdentity(directory.path, directory.identity, 'directory', '.');
    const names = readdirSync(directory.path).sort();
    assertEntryIdentity(directory.path, directory.identity, 'directory', '.');
    for (const name of names) {
      const path = join(directory.path, name);
      const stat = lstatSync(path, { bigint: true });
      const relativePath = normalizedRelativePath(root, path);
      const identity = fileIdentity(stat);
      if (stat.isDirectory()) {
        entries.push({ type: 'directory', path, relativePath, identity });
        stack.push({ path, identity });
      } else if (stat.isFile()) {
        entries.push({ type: 'file', path, relativePath, identity });
      } else if (stat.isSymbolicLink()) {
        const declaredTarget = readlinkSync(path);
        const resolvedTarget = realpathSync(path);
        if (!pathIsWithin(resolvedTarget, root) || resolvedTarget === root) {
          throw new Error(
            `Playwright Chromium distribution symlink escapes its root: ${relativePath}`
          );
        }
        assertEntryIdentity(path, identity, 'symlink', relativePath);
        if (readlinkSync(path) !== declaredTarget) {
          throw new Error(
            `Playwright Chromium distribution symlink changed while hashing: ${relativePath}`
          );
        }
        entries.push({
          type: 'symlink',
          path,
          relativePath,
          identity,
          target: isAbsolute(declaredTarget)
            ? `@root/${normalizedRelativePath(root, resolvedTarget)}`
            : declaredTarget.split(sep).join('/'),
        });
      } else {
        throw new Error(
          `Playwright Chromium distribution contains an unsupported entry: ${relativePath}`
        );
      }
    }
  }
  return entries.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  );
}

function assertDistributionSnapshotUnchanged(before, after) {
  if (before.length !== after.length) {
    throw new Error('Playwright Chromium distribution changed while hashing.');
  }
  for (let index = 0; index < before.length; index += 1) {
    const left = before[index];
    const right = after[index];
    if (
      left.type !== right.type ||
      left.relativePath !== right.relativePath ||
      left.target !== right.target ||
      !sameFileIdentity(left.identity, right.identity)
    ) {
      throw new Error(
        `Playwright Chromium distribution changed while hashing: ${left.relativePath || right.relativePath}`
      );
    }
  }
}

function hashRegularFileNoFollow({ entry, distributionHash, executableRelativePath, testHooks }) {
  if (typeof O_NOFOLLOW !== 'number' || O_NOFOLLOW === 0) {
    throw new Error('This platform cannot safely fingerprint Chromium files without O_NOFOLLOW.');
  }
  testHooks?.beforeFileOpen?.(entry.relativePath);
  let descriptor;
  try {
    descriptor = openSync(entry.path, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch {
    throw new Error(
      `Playwright Chromium distribution file could not be opened without following links: ${entry.relativePath}`
    );
  }
  try {
    testHooks?.afterFileOpen?.(entry.relativePath);
    const descriptorBefore = fstatSync(descriptor, { bigint: true });
    if (
      !descriptorBefore.isFile() ||
      !sameFileIdentity(fileIdentity(descriptorBefore), entry.identity)
    ) {
      throw new Error(
        `Playwright Chromium distribution file changed before hashing: ${entry.relativePath}`
      );
    }
    assertEntryIdentity(entry.path, entry.identity, 'file', entry.relativePath);

    const executableHash =
      entry.relativePath === executableRelativePath ? createHash('sha256') : null;
    const buffer = Buffer.allocUnsafe(FILE_READ_BUFFER_BYTES);
    let bytesReadTotal = 0n;
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const bytes = buffer.subarray(0, bytesRead);
      distributionHash.update(bytes);
      executableHash?.update(bytes);
      bytesReadTotal += BigInt(bytesRead);
    }

    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    if (
      bytesReadTotal !== descriptorAfter.size ||
      !sameFileIdentity(fileIdentity(descriptorAfter), entry.identity)
    ) {
      throw new Error(
        `Playwright Chromium distribution file changed during hashing: ${entry.relativePath}`
      );
    }
    assertEntryIdentity(entry.path, entry.identity, 'file', entry.relativePath);
    return executableHash?.digest('hex') ?? null;
  } finally {
    closeSync(descriptor);
  }
}

export function hashBrowserDistribution({ distributionRoot, executablePath, testHooks }) {
  const root = realpathSync(distributionRoot);
  const rootStat = lstatSync(root, { bigint: true });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Playwright Chromium distribution root must be a real directory.');
  }
  const rootIdentity = fileIdentity(rootStat);
  const executable = realpathSync(executablePath);
  if (!pathIsWithin(executable, root) || executable === root) {
    throw new Error('Playwright Chromium executable escapes its distribution root.');
  }
  const executableStat = lstatSync(executable, { bigint: true });
  if (executableStat.isSymbolicLink() || !executableStat.isFile()) {
    throw new Error('Playwright Chromium executable must resolve to a regular file.');
  }

  const executableRelativePath = normalizedRelativePath(root, executable);
  const entries = collectDistributionEntries(root);
  const hash = createHash('sha256');
  let executableSha256 = null;
  for (const entry of entries) {
    hash.update(entry.type);
    hash.update('\0');
    hash.update(entry.relativePath);
    hash.update('\0');
    if (entry.type === 'file') {
      const digest = hashRegularFileNoFollow({
        entry,
        distributionHash: hash,
        executableRelativePath,
        testHooks,
      });
      if (digest) executableSha256 = digest;
    }
    if (entry.type === 'symlink') hash.update(entry.target);
    hash.update('\0');
  }
  assertEntryIdentity(root, rootIdentity, 'directory', '.');
  assertDistributionSnapshotUnchanged(entries, collectDistributionEntries(root));
  if (!executableSha256) {
    throw new Error('Playwright Chromium executable is missing from its distribution snapshot.');
  }
  return {
    distributionSha256: hash.digest('hex'),
    executableSha256,
    executableRelativePath,
  };
}

function findDistributionRoot(executablePath, revision) {
  const expectedName = `chromium-${revision}`;
  let current = dirname(realpathSync(executablePath));
  while (dirname(current) !== current) {
    if (basename(current) === expectedName) return current;
    current = dirname(current);
  }
  throw new Error(
    `Playwright Chromium executable is not inside the expected ${expectedName} distribution.`
  );
}

export function assertRendererVersionMatch({ manifestVersion, runtimeVersion }) {
  if (!manifestVersion || !runtimeVersion || manifestVersion !== runtimeVersion) {
    throw new Error(
      `Playwright Chromium runtime version does not match browsers.json (${runtimeVersion || 'missing'} vs ${manifestVersion || 'missing'}).`
    );
  }
}

export function playwrightRendererIdentity({ repoRoot }) {
  const browserManifest = JSON.parse(
    readFileSync(join(repoRoot, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8')
  );
  const chromiumManifest = browserManifest.browsers?.find((browser) => browser.name === 'chromium');
  if (!chromiumManifest?.revision || !chromiumManifest.browserVersion) {
    throw new Error('Playwright browsers.json is missing the pinned Chromium identity.');
  }
  const executablePath = realpathSync(FIGMA_RENDERER_EXECUTABLE_PATH);
  const runtimeOutput = execFileSync(executablePath, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();
  const runtimeVersion = runtimeOutput.match(/\b\d+\.\d+\.\d+\.\d+\b/)?.[0] ?? null;
  assertRendererVersionMatch({
    manifestVersion: chromiumManifest.browserVersion,
    runtimeVersion,
  });
  const distributionRoot = findDistributionRoot(executablePath, chromiumManifest.revision);
  return {
    distribution: 'playwright-managed-chromium',
    revision: chromiumManifest.revision,
    manifestVersion: chromiumManifest.browserVersion,
    runtimeVersion,
    ...hashBrowserDistribution({ distributionRoot, executablePath }),
  };
}

export function rendererAttestationEnvironment({ attestationPath, runtimeVersion }) {
  return {
    [FIGMA_RENDERER_ATTESTATION_PATH_ENV]: attestationPath,
    [FIGMA_RENDERER_EXPECTED_EXECUTABLE_ENV]: realpathSync(FIGMA_RENDERER_EXECUTABLE_PATH),
    [FIGMA_RENDERER_EXPECTED_VERSION_ENV]: runtimeVersion,
    [FIGMA_RENDERER_EXPECTED_COLOR_PROFILE_ENV]: FIGMA_RENDERER_CAPTURE_CONTRACT.colorProfile,
    [FIGMA_RENDERER_EXPECTED_CONTRACT_ENV]: JSON.stringify(FIGMA_RENDERER_CAPTURE_CONTRACT),
  };
}

export function validateRendererRuntimeAttestation(value, rendererState) {
  if (
    value?.schemaVersion !== 2 ||
    value.browser !== FIGMA_RENDERER_CAPTURE_CONTRACT.browserName ||
    value.runtimeVersion !== rendererState?.chromium?.runtimeVersion ||
    value.executableMatchesContract !== true ||
    value.headless !== FIGMA_RENDERER_CAPTURE_CONTRACT.headless ||
    value.effectiveColorProfile !== FIGMA_RENDERER_CAPTURE_CONTRACT.colorProfile ||
    value.locale !== FIGMA_RENDERER_CAPTURE_CONTRACT.locale ||
    value.timezoneId !== FIGMA_RENDERER_CAPTURE_CONTRACT.timezoneId ||
    value.deviceScaleFactor !== FIGMA_RENDERER_CAPTURE_CONTRACT.deviceScaleFactor ||
    value.colorScheme !== FIGMA_RENDERER_CAPTURE_CONTRACT.colorScheme ||
    value.reducedMotion !== FIGMA_RENDERER_CAPTURE_CONTRACT.reducedMotion ||
    Object.keys(value).sort().join(',') !==
      'browser,colorScheme,deviceScaleFactor,effectiveColorProfile,executableMatchesContract,headless,locale,reducedMotion,runtimeVersion,schemaVersion,timezoneId'
  ) {
    throw new Error('Playwright runtime did not match the sealed Figma renderer contract.');
  }
  return value;
}

export function assertFigmaPlaywrightConfig(config) {
  const globalUse = config?.use ?? {};
  const globalLaunchOptions = globalUse.launchOptions ?? {};
  const globalContextOptions = globalUse.contextOptions ?? {};
  const globalLaunchOptionKeys = Object.keys(globalLaunchOptions).sort();
  const globalContextOptionKeys = Object.keys(globalContextOptions).sort();
  if (
    globalUse.browserName !== FIGMA_RENDERER_CAPTURE_CONTRACT.browserName ||
    globalUse.headless !== FIGMA_RENDERER_CAPTURE_CONTRACT.headless ||
    globalUse.channel !== undefined ||
    globalUse.connectOptions !== undefined ||
    globalUse.defaultBrowserType !== undefined ||
    globalUse.reducedMotion !== undefined ||
    globalLaunchOptionKeys.join(',') !== 'args,executablePath' ||
    globalLaunchOptions.executablePath !== FIGMA_RENDERER_EXECUTABLE_PATH ||
    JSON.stringify(globalLaunchOptions.args) !== JSON.stringify(FIGMA_RENDERER_LAUNCH_ARGS) ||
    globalContextOptionKeys.join(',') !== 'reducedMotion' ||
    globalContextOptions.reducedMotion !== FIGMA_RENDERER_CAPTURE_CONTRACT.reducedMotion
  ) {
    throw new Error('Figma Playwright config must use the one explicit managed Chromium contract.');
  }
  for (const projectName of FIGMA_VISUAL_PROJECTS) {
    const matches = (config.projects ?? []).filter((project) => project.name === projectName);
    if (matches.length !== 1) {
      throw new Error(`Figma Playwright config requires exactly one '${projectName}' project.`);
    }
    const projectUse = matches[0].use ?? {};
    const effective = { ...globalUse, ...projectUse };
    if (
      [
        'browserName',
        'headless',
        'channel',
        'connectOptions',
        'contextOptions',
        'launchOptions',
        'reducedMotion',
      ].some((key) => Object.hasOwn(projectUse, key)) ||
      (projectUse.defaultBrowserType !== undefined &&
        projectUse.defaultBrowserType !== FIGMA_RENDERER_CAPTURE_CONTRACT.browserName) ||
      effective.deviceScaleFactor !== FIGMA_RENDERER_CAPTURE_CONTRACT.deviceScaleFactor ||
      effective.colorScheme !== FIGMA_RENDERER_CAPTURE_CONTRACT.colorScheme ||
      effective.locale !== FIGMA_RENDERER_CAPTURE_CONTRACT.locale ||
      effective.timezoneId !== FIGMA_RENDERER_CAPTURE_CONTRACT.timezoneId
    ) {
      throw new Error(`Playwright project '${projectName}' overrides the Figma renderer contract.`);
    }
  }
  return config;
}

export function assertRendererEvidenceSanitized(identity) {
  if (
    !SHA256_RE.test(identity?.distributionSha256 ?? '') ||
    !SHA256_RE.test(identity?.executableSha256 ?? '') ||
    typeof identity?.executableRelativePath !== 'string' ||
    identity.executableRelativePath.startsWith('/') ||
    identity.executableRelativePath.includes('..') ||
    Object.keys(identity).some((key) => /absolute|pathsha/i.test(key))
  ) {
    throw new Error('Figma renderer evidence contains an invalid or location-bearing identity.');
  }
  return identity;
}
