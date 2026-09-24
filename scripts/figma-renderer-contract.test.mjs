import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertFigmaPlaywrightConfig,
  assertRendererEvidenceSanitized,
  assertRendererVersionMatch,
  FIGMA_RENDERER_CAPTURE_CONTRACT,
  FIGMA_RENDERER_EXECUTABLE_PATH,
  FIGMA_RENDERER_LAUNCH_ARGS,
  FIGMA_VISUAL_PROJECTS,
  hashBrowserDistribution,
  validateRendererRuntimeAttestation,
} from './lib/figma-renderer-contract.mjs';

function validConfig() {
  return {
    use: {
      browserName: FIGMA_RENDERER_CAPTURE_CONTRACT.browserName,
      headless: FIGMA_RENDERER_CAPTURE_CONTRACT.headless,
      launchOptions: {
        executablePath: FIGMA_RENDERER_EXECUTABLE_PATH,
        args: [...FIGMA_RENDERER_LAUNCH_ARGS],
      },
      contextOptions: {
        reducedMotion: FIGMA_RENDERER_CAPTURE_CONTRACT.reducedMotion,
      },
      deviceScaleFactor: FIGMA_RENDERER_CAPTURE_CONTRACT.deviceScaleFactor,
      colorScheme: FIGMA_RENDERER_CAPTURE_CONTRACT.colorScheme,
      locale: FIGMA_RENDERER_CAPTURE_CONTRACT.locale,
      timezoneId: FIGMA_RENDERER_CAPTURE_CONTRACT.timezoneId,
    },
    projects: FIGMA_VISUAL_PROJECTS.map((name) => ({ name, use: { deviceScaleFactor: 1 } })),
  };
}

function browserTree(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'figma-renderer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const distributionRoot = join(root, 'chromium-7');
  const executablePath = join(distributionRoot, 'bin', 'browser');
  mkdirSync(join(distributionRoot, 'bin'), { recursive: true });
  mkdirSync(join(distributionRoot, 'Resources'), { recursive: true });
  writeFileSync(executablePath, 'launcher-v1');
  writeFileSync(join(distributionRoot, 'Resources', 'framework.bin'), 'framework-v1');
  symlinkSync('Resources', join(distributionRoot, 'Current'));
  return { root, distributionRoot, executablePath };
}

test('browser distribution identity is location-independent and covers every file', (t) => {
  const first = browserTree(t);
  const secondRoot = mkdtempSync(join(realpathSync(tmpdir()), 'figma-renderer-copy-'));
  t.after(() => rmSync(secondRoot, { recursive: true, force: true }));
  const secondDistribution = join(secondRoot, 'chromium-7');
  cpSync(first.distributionRoot, secondDistribution, { recursive: true, verbatimSymlinks: true });

  const original = hashBrowserDistribution(first);
  const copied = hashBrowserDistribution({
    distributionRoot: secondDistribution,
    executablePath: join(secondDistribution, 'bin', 'browser'),
  });
  assert.deepEqual(copied, original);

  writeFileSync(join(secondDistribution, 'Resources', 'framework.bin'), 'framework-v2');
  const frameworkChanged = hashBrowserDistribution({
    distributionRoot: secondDistribution,
    executablePath: join(secondDistribution, 'bin', 'browser'),
  });
  assert.notEqual(frameworkChanged.distributionSha256, original.distributionSha256);
  assert.equal(frameworkChanged.executableSha256, original.executableSha256);

  writeFileSync(join(secondDistribution, 'bin', 'browser'), 'launcher-v2');
  const launcherChanged = hashBrowserDistribution({
    distributionRoot: secondDistribution,
    executablePath: join(secondDistribution, 'bin', 'browser'),
  });
  assert.notEqual(launcherChanged.distributionSha256, frameworkChanged.distributionSha256);
  assert.notEqual(launcherChanged.executableSha256, frameworkChanged.executableSha256);
});

test('browser distribution rejects a symlink outside its immutable root', (t) => {
  const current = browserTree(t);
  const outside = join(current.root, 'outside.bin');
  writeFileSync(outside, 'outside');
  symlinkSync(outside, join(current.distributionRoot, 'escape'));
  assert.throws(() => hashBrowserDistribution(current), /symlink escapes/);
});

test('browser distribution rejects a file swapped before or after a no-follow open', (t) => {
  const beforeOpen = browserTree(t);
  const outsideBefore = join(beforeOpen.root, 'outside-before.bin');
  writeFileSync(outsideBefore, 'outside-before');
  assert.throws(
    () =>
      hashBrowserDistribution({
        ...beforeOpen,
        testHooks: {
          beforeFileOpen(relativePath) {
            if (relativePath !== 'Resources/framework.bin') return;
            rmSync(join(beforeOpen.distributionRoot, relativePath));
            symlinkSync(outsideBefore, join(beforeOpen.distributionRoot, relativePath));
          },
        },
      }),
    /without following links|changed before hashing/
  );

  const afterOpen = browserTree(t);
  const outsideAfter = join(afterOpen.root, 'outside-after.bin');
  writeFileSync(outsideAfter, 'outside-after');
  assert.throws(
    () =>
      hashBrowserDistribution({
        ...afterOpen,
        testHooks: {
          afterFileOpen(relativePath) {
            if (relativePath !== 'Resources/framework.bin') return;
            rmSync(join(afterOpen.distributionRoot, relativePath));
            symlinkSync(outsideAfter, join(afterOpen.distributionRoot, relativePath));
          },
        },
      }),
    /changed before hashing/
  );
});

test('renderer versions and runtime evidence fail closed', () => {
  assert.doesNotThrow(() =>
    assertRendererVersionMatch({ manifestVersion: '1.2.3.4', runtimeVersion: '1.2.3.4' })
  );
  assert.throws(
    () => assertRendererVersionMatch({ manifestVersion: '1.2.3.4', runtimeVersion: '1.2.3.5' }),
    /does not match/
  );
  const rendererState = { chromium: { runtimeVersion: '1.2.3.4' } };
  assert.deepEqual(
    validateRendererRuntimeAttestation(
      {
        schemaVersion: 2,
        browser: 'chromium',
        runtimeVersion: '1.2.3.4',
        executableMatchesContract: true,
        headless: true,
        effectiveColorProfile: 'srgb',
        locale: 'fa-IR',
        timezoneId: 'UTC',
        deviceScaleFactor: 1,
        colorScheme: 'light',
        reducedMotion: 'reduce',
      },
      rendererState
    ).runtimeVersion,
    '1.2.3.4'
  );
  assert.throws(
    () =>
      validateRendererRuntimeAttestation(
        {
          schemaVersion: 2,
          browser: 'chromium',
          runtimeVersion: '1.2.3.4',
          executableMatchesContract: true,
          headless: true,
          effectiveColorProfile: 'display-p3',
          locale: 'fa-IR',
          timezoneId: 'UTC',
          deviceScaleFactor: 1,
          colorScheme: 'light',
          reducedMotion: 'reduce',
        },
        rendererState
      ),
    /did not match/
  );
});

test('serialized renderer identity contains no installation location', () => {
  const identity = {
    distribution: 'playwright-managed-chromium',
    revision: '7',
    manifestVersion: '1.2.3.4',
    runtimeVersion: '1.2.3.4',
    distributionSha256: 'a'.repeat(64),
    executableSha256: 'b'.repeat(64),
    executableRelativePath: 'bin/browser',
  };
  assert.equal(assertRendererEvidenceSanitized(identity), identity);
  assert.throws(
    () => assertRendererEvidenceSanitized({ ...identity, executablePathSha256: 'c'.repeat(64) }),
    /location-bearing/
  );
});

test('every Figma visual project inherits one exact renderer and rejects all launch overrides', () => {
  assert.equal(assertFigmaPlaywrightConfig(validConfig()).projects.length, 5);

  const globalOverrides = [
    (config) => (config.use.browserName = 'firefox'),
    (config) => (config.use.headless = false),
    (config) => (config.use.channel = 'chromium'),
    (config) => (config.use.connectOptions = { wsEndpoint: 'ws://127.0.0.1:1' }),
    (config) => (config.use.defaultBrowserType = 'firefox'),
    (config) => (config.use.reducedMotion = 'no-preference'),
    (config) => (config.use.launchOptions.channel = 'chrome'),
    (config) => (config.use.launchOptions.ignoreDefaultArgs = true),
    (config) => (config.use.launchOptions.args = ['--force-color-profile=display-p3']),
    (config) => (config.use.launchOptions.executablePath = '/tmp/other-browser'),
    (config) => (config.use.contextOptions.reducedMotion = 'no-preference'),
    (config) => (config.use.contextOptions.locale = 'en-US'),
  ];
  for (const override of globalOverrides) {
    const config = validConfig();
    override(config);
    assert.throws(
      () => assertFigmaPlaywrightConfig(config),
      /one explicit managed Chromium contract/
    );
  }

  const projectOverrides = [
    (use) => (use.browserName = 'firefox'),
    (use) => (use.headless = false),
    (use) => (use.channel = 'chromium'),
    (use) => (use.connectOptions = { wsEndpoint: 'ws://127.0.0.1:1' }),
    (use) => (use.defaultBrowserType = 'firefox'),
    (use) => (use.contextOptions = { reducedMotion: 'no-preference' }),
    (use) => (use.launchOptions = { args: ['--force-color-profile=display-p3'] }),
  ];
  for (const override of projectOverrides) {
    const config = validConfig();
    override(config.projects[1].use);
    assert.throws(() => assertFigmaPlaywrightConfig(config), /overrides the Figma renderer/);
  }
});

test('runtime evidence rejects every mutable browser-context setting', () => {
  const rendererState = { chromium: { runtimeVersion: '1.2.3.4' } };
  const valid = {
    schemaVersion: 2,
    browser: 'chromium',
    runtimeVersion: '1.2.3.4',
    executableMatchesContract: true,
    headless: true,
    effectiveColorProfile: 'srgb',
    locale: 'fa-IR',
    timezoneId: 'UTC',
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  };
  for (const [property, value] of [
    ['browser', 'firefox'],
    ['headless', false],
    ['locale', 'en-US'],
    ['timezoneId', 'Asia/Tehran'],
    ['deviceScaleFactor', 2],
    ['colorScheme', 'dark'],
    ['reducedMotion', 'no-preference'],
  ]) {
    assert.throws(
      () => validateRendererRuntimeAttestation({ ...valid, [property]: value }, rendererState),
      /did not match/
    );
  }
});
