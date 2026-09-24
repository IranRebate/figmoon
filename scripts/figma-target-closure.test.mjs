import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  assertTargetSourceFingerprint,
  baselineReceiptInvalidatesSignoff,
  findingBelongsToTarget,
  targetDependencyFiles,
  targetSourceState,
} from './lib/figma-target-closure.mjs';

function writeFixture(root, path, contents) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

test('target closure follows owned modules and their imports without pulling unrelated importers', () => {
  const files = targetDependencyFiles({
    item: {
      id: 'target-a',
      implementationPaths: ['client/src/A.tsx'],
      visualTest: { file: 'client/e2e/visual/a.spec.ts' },
    },
    screenRegistry: { screens: [] },
    dependencyGraph: {
      sourceImports: [
        { module: 'client/src/A.tsx', imports: ['client/src/Shared.tsx'] },
        { module: 'client/src/B.tsx', imports: ['client/src/Shared.tsx'] },
      ],
      components: [],
    },
  });
  assert.equal(files.has('client/src/A.tsx'), true);
  assert.equal(files.has('client/src/Shared.tsx'), true);
  assert.equal(files.has('client/src/B.tsx'), false);
});

test('target closure fingerprints a shared fixture hub without pulling unrelated scenarios', () => {
  const files = targetDependencyFiles({
    item: {
      id: 'target-a',
      implementationPaths: ['client/src/test/fixtures/canonicalNews.ts'],
      visualTest: { file: 'client/e2e/visual/a.spec.ts' },
    },
    screenRegistry: { screens: [] },
    dependencyGraph: {
      sourceImports: [
        {
          module: 'client/src/components/shared/VisualQAComponents.tsx',
          imports: [
            'client/src/components/chat/ChatSidebar.tsx',
            'client/src/test/fixtures/canonicalNews.ts',
          ],
        },
      ],
      components: [
        {
          id: 'component-a',
          visualCoverage: {
            registryIds: ['target-a'],
            fixtureModule: 'client/src/components/shared/VisualQAComponents.tsx',
          },
        },
      ],
    },
  });

  assert.equal(files.has('client/src/components/shared/VisualQAComponents.tsx'), true);
  assert.equal(files.has('client/src/test/fixtures/canonicalNews.ts'), true);
  assert.equal(files.has('client/src/components/chat/ChatSidebar.tsx'), false);
});

test('target fingerprint binds explicit fixture data but ignores unrelated hub imports', (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'figma-target-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixture(
    root,
    'client/src/components/shared/VisualQAComponents.tsx',
    "import '../chat/ChatSidebar.js';\nimport '../../test/fixtures/canonicalNews.js';\n"
  );
  writeFixture(root, 'client/src/components/chat/ChatSidebar.tsx', 'export const sidebar = 1;\n');
  writeFixture(root, 'client/src/test/fixtures/canonicalNews.ts', 'export const news = 1;\n');
  writeFixture(root, 'client/e2e/visual/a.spec.ts', 'export const test = 1;\n');

  const contract = {
    item: {
      id: 'target-a',
      implementationPaths: ['client/src/test/fixtures/canonicalNews.ts'],
      visualTest: { file: 'client/e2e/visual/a.spec.ts', name: 'target-a' },
    },
    dependencyGraph: {
      sourceImports: [
        {
          module: 'client/src/components/shared/VisualQAComponents.tsx',
          imports: [
            'client/src/components/chat/ChatSidebar.tsx',
            'client/src/test/fixtures/canonicalNews.ts',
          ],
        },
      ],
      components: [
        {
          id: 'component-a',
          visualCoverage: {
            registryIds: ['target-a'],
            fixtureModule: 'client/src/components/shared/VisualQAComponents.tsx',
          },
        },
      ],
    },
    screenRegistry: { screens: [] },
    repoRoot: root,
    sharedFiles: [],
    sharedDirectories: [],
    optionalFiles: [],
    sharedRuntimeRoots: [],
    environment: {},
  };
  const reviewed = targetSourceState(contract);

  writeFixture(root, 'client/src/components/chat/ChatSidebar.tsx', 'export const sidebar = 2;\n');
  assert.equal(targetSourceState(contract).fingerprint, reviewed.fingerprint);

  writeFixture(root, 'client/src/test/fixtures/canonicalNews.ts', 'export const news = 2;\n');
  assert.notEqual(targetSourceState(contract).fingerprint, reviewed.fingerprint);
});

test('target masking includes its closure and global capture helpers only', () => {
  const files = new Set(['client/src/A.tsx', 'client/e2e/visual/a.spec.ts']);
  assert.equal(findingBelongsToTarget({ file: 'client/src/A.tsx' }, files), true);
  assert.equal(findingBelongsToTarget({ file: 'client/e2e/helpers/setup.ts' }, files), true);
  assert.equal(findingBelongsToTarget({ file: 'client/src/B.tsx' }, files), false);
});

test('stored target signoff fingerprint ignores unrelated files and invalidates on target closure edits', (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'figma-target-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixture(root, 'client/src/Target.tsx', "import './Shared.js';\nexport const Target = 1;\n");
  writeFixture(root, 'client/src/Shared.ts', 'export const shared = 1;\n');
  writeFixture(root, 'server/src/Unrelated.ts', 'export const unrelated = 1;\n');

  const contract = {
    item: {
      id: 'target-a',
      kind: 'component',
      implementationPaths: ['client/src/Target.tsx'],
      visualTest: { file: 'client/src/Target.tsx', name: 'target-a' },
      snapshot: 'desktop/target-a.png',
    },
    dependencyGraph: {
      sourceImports: [{ module: 'client/src/Target.tsx', imports: ['client/src/Shared.ts'] }],
      components: [],
    },
    screenRegistry: { screens: [] },
    repoRoot: root,
    sharedFiles: [],
    sharedDirectories: [],
    optionalFiles: [],
    sharedRuntimeRoots: [],
    environment: {},
  };
  const reviewed = targetSourceState(contract);

  writeFixture(root, 'server/src/Unrelated.ts', 'export const unrelated = 2;\n');
  assert.doesNotThrow(() =>
    assertTargetSourceFingerprint(
      reviewed.fingerprint,
      targetSourceState(contract),
      'Stored Figma signoff'
    )
  );

  writeFixture(root, 'client/src/Shared.ts', 'export const shared = 2;\n');
  assert.throws(
    () =>
      assertTargetSourceFingerprint(
        reviewed.fingerprint,
        targetSourceState(contract),
        'Stored Figma signoff'
      ),
    /stale because this target's implementation or shared visual inputs changed/
  );
});

test('target fingerprint follows the complete visual runtime entry import closure', (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'figma-runtime-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixture(root, 'client/src/Target.tsx', 'export const Target = 1;\n');
  writeFixture(
    root,
    'client/src/main.tsx',
    "import './App.js';\nimport './components/shared/VisualQAComponents.js';\n"
  );
  writeFixture(root, 'client/src/App.tsx', "import './GlobalShell.js';\nexport const App = 1;\n");
  writeFixture(root, 'client/src/GlobalShell.tsx', 'export const shell = 1;\n');
  writeFixture(
    root,
    'client/src/components/shared/VisualQAComponents.tsx',
    'export const VisualQAComponents = 1;\n'
  );
  const contract = {
    item: {
      id: 'target-runtime',
      implementationPaths: ['client/src/Target.tsx'],
      visualTest: { file: 'client/src/Target.tsx', name: 'target-runtime' },
    },
    dependencyGraph: {
      sourceImports: [
        {
          module: 'client/src/main.tsx',
          imports: ['client/src/App.tsx', 'client/src/components/shared/VisualQAComponents.tsx'],
        },
        { module: 'client/src/App.tsx', imports: ['client/src/GlobalShell.tsx'] },
      ],
      components: [],
    },
    screenRegistry: { screens: [] },
    repoRoot: root,
    sharedFiles: [],
    sharedDirectories: [],
    optionalFiles: [],
    sharedRuntimeRoots: ['client/src/main.tsx'],
    environment: {},
  };
  const reviewed = targetSourceState(contract);
  assert.deepEqual(
    reviewed.files.map((file) => file.path),
    [
      'client/src/App.tsx',
      'client/src/GlobalShell.tsx',
      'client/src/Target.tsx',
      'client/src/components/shared/VisualQAComponents.tsx',
      'client/src/main.tsx',
    ]
  );

  writeFixture(root, 'client/src/App.tsx', "import './GlobalShell.js';\nexport const App = 2;\n");
  assert.notEqual(reviewed.fingerprint, targetSourceState(contract).fingerprint);
});

test('a new baseline receipt invalidates signoff even when the accepted pixels are identical', () => {
  const receiptA = 'a'.repeat(64);
  const receiptB = 'b'.repeat(64);
  const signoffA = {
    snapshotSha256: 'c'.repeat(64),
    baselinePromotionReceiptSha256: receiptA,
  };

  assert.equal(baselineReceiptInvalidatesSignoff(signoffA, receiptA), false);
  assert.equal(baselineReceiptInvalidatesSignoff(signoffA, receiptB), true);
});

test('dynamic public asset directories are recursively bound without pulling sibling directories', (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'figma-target-assets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixture(
    root,
    'client/src/Target.tsx',
    'export const icon = `/images/figma-icons/${name}.svg`;\n' +
      'export const persona = `/images/personas/${id}.png`;\n'
  );
  writeFixture(root, 'client/public/images/figma-icons/calendar.svg', '<svg/>\n');
  writeFixture(root, 'client/public/images/figma-icons/news.svg', '<svg/>\n');
  writeFixture(root, 'client/public/images/personas/a.png', 'persona-a');
  writeFixture(root, 'client/public/images/unrelated/other.png', 'unrelated');

  const state = targetSourceState({
    item: {
      id: 'target-assets',
      implementationPaths: ['client/src/Target.tsx'],
      visualTest: { file: 'client/src/Target.tsx', name: 'target-assets' },
    },
    dependencyGraph: { sourceImports: [], components: [] },
    screenRegistry: { screens: [] },
    repoRoot: root,
    sharedFiles: [],
    sharedDirectories: [],
    optionalFiles: [],
    sharedRuntimeRoots: [],
    environment: {},
  });
  const paths = state.files.map((file) => file.path);
  assert.equal(paths.includes('client/public/images/figma-icons/calendar.svg'), true);
  assert.equal(paths.includes('client/public/images/figma-icons/news.svg'), true);
  assert.equal(paths.includes('client/public/images/personas/a.png'), true);
  assert.equal(paths.includes('client/public/images/unrelated/other.png'), false);
});

test('effective Vite environment changes invalidate the target without exposing values', (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'figma-target-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixture(root, 'client/src/Target.tsx', 'export const Target = 1;\n');
  const contract = {
    item: {
      id: 'target-env',
      implementationPaths: ['client/src/Target.tsx'],
      visualTest: { file: 'client/src/Target.tsx', name: 'target-env' },
    },
    dependencyGraph: { sourceImports: [], components: [] },
    screenRegistry: { screens: [] },
    repoRoot: root,
    sharedFiles: [],
    sharedDirectories: [],
    optionalFiles: [],
    sharedRuntimeRoots: [],
  };
  const first = targetSourceState({ ...contract, environment: { VITE_PUBLIC_MODE: 'one' } });
  const second = targetSourceState({ ...contract, environment: { VITE_PUBLIC_MODE: 'two' } });
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(JSON.stringify(first).includes('one'), false);
});
