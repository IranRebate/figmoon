import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { assertFigmaAcquisitionPluginIntegrity } from './lib/figma-plugin-integrity.mjs';

const root = join(import.meta.dirname, 'plugin');
const repositoryRoot = import.meta.dirname;

const findManifests = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.figmoon') {
      continue;
    }
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) manifests.push(...(await findManifests(absolute)));
    else if (entry.name === 'manifest.json') manifests.push(absolute);
  }
  return manifests;
};

test('Figmoon is the only Figma plugin manifest in the package', async () => {
  const manifests = await findManifests(repositoryRoot);
  assert.deepEqual(manifests, [join(root, 'manifest.json')]);
});

test('Figmoon is the repository-owned unified Figma workspace', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'Figmoon');
  assert.equal(manifest.id, 'figmoon');
  assert.equal(manifest.enablePrivatePluginApi, true);
  assert.deepEqual(manifest.editorType, ['figma', 'figjam', 'slides', 'dev']);
  assert.deepEqual(manifest.permissions, ['teamlibrary']);
  assert.deepEqual(manifest.networkAccess.allowedDomains, [
    'ws://localhost:29194',
    'ws://localhost:29195',
  ]);
});

test('Figmoon owns the pinned MCP server configuration', async () => {
  const mcp = JSON.parse(await readFile(join(repositoryRoot, '.mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.figmoon, {
    type: 'stdio',
    command: 'node',
    args: ['server/launch.mjs'],
  });
});

test('Figmoon retains bridge, reference, and design-system capabilities', async () => {
  const [main, acquisition, designSystem, ui, built] = await Promise.all([
    readFile(join(root, 'src/main/code.ts'), 'utf8'),
    readFile(join(root, 'src/main/acquisition.ts'), 'utf8'),
    readFile(join(root, 'src/main/design-system.ts'), 'utf8'),
    readFile(join(root, 'src/ui/App.tsx'), 'utf8'),
    readFile(join(root, 'dist/code.js'), 'utf8'),
  ]);
  assert.match(main, /handleRequest/);
  assert.match(main, /exportDesignSystem/);
  assert.match(main, /handleAcquisition/);
  assert.match(acquisition, /figmoon-reference-acquisition\/v1/);
  assert.match(designSystem, /figmoon-design-system\/v1/);
  for (const label of ['Connect', 'References', 'Design System', 'Activity'])
    assert.ok(ui.includes(label));
  for (const operation of ['get_document', 'get_screenshot', 'set_text_content', 'delete_nodes'])
    assert.ok(built.includes(operation));
  for (const operation of [
    'search_nodes',
    'get_library_assets',
    'analyze_design_patterns',
    'batch_transaction',
  ])
    assert.ok(built.includes(operation));
  assert.match(main, /scope: 'current-page'/);
  assert.match(await readFile(join(root, 'src/main/workspace.ts'), 'utf8'), /safeRead/);
  assert.match(ui, /Selection is optional/);
  assert.match(ui, /pluginBuild=/);
  assert.match(ui, /identity\?\.plugin\.build, status\.fileKey, status\.fileName/);
  assert.doesNotMatch(ui, /<span>Selected<\/span>/);
  assert.match(ui, /Workspace ready/);
  assert.doesNotMatch(ui, /Figmoon started/);
  assert.doesNotMatch(ui, /<h1>Activity<\/h1>/);
});

test('Figmoon source identity matches the acquisition broker contract', () => {
  const integrity = assertFigmaAcquisitionPluginIntegrity();
  assert.equal(integrity.plugin.id, 'figmoon');
  assert.match(
    integrity.plugin.build,
    /^1\.0\.0\+gethopp-v0\.0\.18\.dc2ea5a\.sha256\.[a-f0-9]{64}$/
  );
});

test('built plugin serves bridge status, Design System export, and independent reference acquisitions', async () => {
  const posts = [];
  const handlers = {};
  const page = { id: '0:1', name: 'Page', type: 'PAGE', parent: null, children: [] };
  const node = {
    id: '1:2',
    name: 'Hero',
    type: 'FRAME',
    parent: page,
    visible: true,
    x: 10,
    y: 20,
    width: 320,
    height: 180,
    children: [],
    async exportAsync() {
      return new Uint8Array([137, 80, 78, 71]);
    },
  };
  const child = {
    id: '1:3',
    name: 'Hero child',
    type: 'RECTANGLE',
    parent: node,
    visible: true,
    opacity: 1,
    x: 0,
    y: 0,
    width: 40,
    height: 40,
  };
  const textNode = {
    id: '1:5',
    name: 'Deferred text',
    type: 'TEXT',
    parent: node,
    visible: true,
    opacity: 1,
    x: 0,
    y: 50,
    width: 100,
    height: 24,
    characters: 'Before',
    fontName: { family: 'Inter', style: 'Regular' },
    fontSize: 16,
    fontWeight: 400,
    textDecoration: 'NONE',
    lineHeight: { unit: 'AUTO' },
    letterSpacing: { value: 0, unit: 'PIXELS' },
    textAlignHorizontal: 'LEFT',
    textAlignVertical: 'TOP',
    textAutoResize: 'NONE',
    getRangeAllFontNames() {
      return [this.fontName];
    },
  };
  const outside = {
    id: '1:4',
    name: 'Outside sibling',
    type: 'RECTANGLE',
    parent: page,
    visible: true,
    opacity: 1,
    x: 400,
    y: 0,
    width: 40,
    height: 40,
  };
  const mainComponent = {
    id: '1:6',
    key: 'component-key',
    name: 'Button',
    type: 'COMPONENT',
    remote: false,
  };
  const instance = {
    id: '1:7',
    name: 'Button',
    type: 'INSTANCE',
    parent: page,
    visible: true,
    opacity: 1,
    x: 0,
    y: 100,
    width: 120,
    height: 40,
    componentProperties: { Label: { type: 'TEXT', value: 'Save' } },
    children: [],
    async getMainComponentAsync() {
      return mainComponent;
    },
  };
  node.children = [child, textNode];
  page.children = [node, outside, instance];
  const nodesById = new Map(
    [page, node, child, textNode, outside, mainComponent, instance].map((item) => [item.id, item])
  );
  let deferredFontResolve = null;
  let deferFontLoad = false;
  const figma = {
    fileKey: 'StableFileKey',
    root: {
      name: 'Figmoon Test',
      children: [page],
      findAll() {
        return [node, child, outside, instance];
      },
      findAllWithCriteria() {
        return [];
      },
    },
    currentPage: { ...page, selection: [] },
    variables: {
      async getLocalVariableCollectionsAsync() {
        return [];
      },
      async getLocalVariablesAsync() {
        return [];
      },
      async getVariableByIdAsync() {
        return null;
      },
    },
    async getLocalPaintStylesAsync() {
      return [];
    },
    async getLocalTextStylesAsync() {
      return [];
    },
    async getLocalEffectStylesAsync() {
      return [];
    },
    async getLocalGridStylesAsync() {
      return [];
    },
    async loadAllPagesAsync() {},
    async getNodeByIdAsync(id) {
      return nodesById.get(id) ?? null;
    },
    async loadFontAsync() {
      if (!deferFontLoad) return;
      await new Promise((resolve) => {
        deferredFontResolve = resolve;
      });
    },
    commitUndo() {},
    triggerUndo() {},
    base64Encode(bytes) {
      return Buffer.from(bytes).toString('base64');
    },
    showUI(_html, options) {
      assert.deepEqual(JSON.parse(JSON.stringify(options)), {
        width: 460,
        height: 600,
        themeColors: true,
      });
    },
    on(event, handler) {
      handlers[event] = handler;
    },
    closePlugin() {},
    ui: {
      onmessage: null,
      postMessage(message) {
        posts.push(JSON.parse(JSON.stringify(message)));
      },
    },
  };
  const source = await readFile(join(root, 'dist/code.js'), 'utf8');
  vm.runInNewContext(source, { figma, __html__: '<ui />', console, Uint8Array, Buffer });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(typeof figma.ui.onmessage, 'function');
  assert.ok(posts.some((message) => message.type === 'plugin-status'));
  const status = posts.find((message) => message.type === 'plugin-status').payload;
  assert.equal(status.currentPageName, 'Page');
  assert.equal(status.pageCount, 1);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'search_nodes',
      requestId: 'search-1',
      params: { query: 'hero', limit: 20 },
    },
  });
  assert.equal(posts.at(-1).requestId, 'search-1');
  assert.equal(posts.at(-1).data.matches[0].id, node.id);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'get_node',
      requestId: 'instance-identity',
      nodeIds: [instance.id],
    },
  });
  assert.deepEqual(posts.at(-1).data.designSemantics.mainComponent, {
    id: mainComponent.id,
    key: mainComponent.key,
    name: mainComponent.name,
    remote: false,
  });

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'analyze_design_patterns',
      requestId: 'patterns-1',
      params: { pageId: page.id, minimumSubtreeNodes: 2 },
    },
  });
  assert.equal(posts.at(-1).data.analysis.schemaVersion, 'figmoon-design-pattern-index/v1');

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'acquire_workspace_lock',
      requestId: 'lock-1',
      params: { owner: 'test-agent', nodeIds: [node.id], ttlMs: 30000 },
    },
  });
  const lock = posts.at(-1).data.lock;
  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'batch_transaction',
      requestId: 'batch-1',
      params: {
        owner: 'test-agent',
        lockId: lock.id,
        expectedRevision: 0,
        dryRun: true,
        operations: [{ type: 'set_node_properties', nodeIds: [node.id], params: { opacity: 0.5 } }],
      },
    },
  });
  assert.equal(posts.at(-1).data.dryRun, true);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'acquire_workspace_lock',
      requestId: 'same-owner-overlap',
      params: { owner: 'test-agent', nodeIds: [child.id], ttlMs: 30000 },
    },
  });
  assert.match(posts.at(-1).error, /locked by test-agent/);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'batch_transaction',
      requestId: 'batch-descendant',
      params: {
        owner: 'test-agent',
        lockId: lock.id,
        expectedRevision: 0,
        dryRun: true,
        operations: [
          { type: 'set_node_properties', nodeIds: [child.id], params: { opacity: 0.5 } },
        ],
      },
    },
  });
  assert.equal(posts.at(-1).data.dryRun, true);
  assert.deepEqual(posts.at(-1).data.plan[0].nodeIds, [child.id]);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'batch_transaction',
      requestId: 'batch-visibility-escape',
      params: {
        owner: 'test-agent',
        lockId: lock.id,
        expectedRevision: 0,
        dryRun: true,
        operations: [
          {
            type: 'set_node_visibility',
            nodeIds: [],
            params: { items: [{ nodeId: outside.id, visible: false }] },
          },
        ],
      },
    },
  });
  assert.match(posts.at(-1).error, /do not match visibility params\.items/);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'batch_transaction',
      requestId: 'batch-visibility-derived-escape',
      params: {
        owner: 'test-agent',
        lockId: lock.id,
        expectedRevision: 0,
        dryRun: true,
        operations: [
          {
            type: 'set_node_visibility',
            params: { items: [{ nodeId: outside.id, visible: false }] },
          },
        ],
      },
    },
  });
  assert.match(posts.at(-1).error, /outside its lease/);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'batch_transaction',
      requestId: 'batch-ambiguous-target',
      params: {
        owner: 'test-agent',
        lockId: lock.id,
        expectedRevision: 0,
        dryRun: true,
        operations: [
          {
            type: 'set_node_properties',
            nodeIds: [node.id, child.id],
            params: { opacity: 0.5 },
          },
        ],
      },
    },
  });
  assert.match(posts.at(-1).error, /requires exactly one target node ID/);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'acquire_workspace_lock',
      requestId: 'child-overlap',
      params: { owner: 'other-agent', nodeIds: [child.id], ttlMs: 30000 },
    },
  });
  assert.match(posts.at(-1).error, /locked by test-agent/);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'acquire_workspace_lock',
      requestId: 'sibling-lock',
      params: { owner: 'other-agent', nodeIds: [outside.id], ttlMs: 30000 },
    },
  });
  const siblingLock = posts.at(-1).data.lock;
  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'release_workspace_lock',
      requestId: 'sibling-release',
      params: { owner: 'other-agent', lockId: siblingLock.id },
    },
  });
  assert.equal(posts.at(-1).data.released, true);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'release_workspace_lock',
      requestId: 'parent-release',
      params: { owner: 'test-agent', lockId: lock.id },
    },
  });
  assert.equal(posts.at(-1).data.released, true);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'acquire_workspace_lock',
      requestId: 'child-lock',
      params: { owner: 'child-agent', nodeIds: [child.id], ttlMs: 30000 },
    },
  });
  const childLock = posts.at(-1).data.lock;
  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'acquire_workspace_lock',
      requestId: 'parent-overlap',
      params: { owner: 'parent-agent', nodeIds: [node.id], ttlMs: 30000 },
    },
  });
  assert.match(posts.at(-1).error, /locked by child-agent/);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'batch_transaction',
      requestId: 'batch-ancestor-escape',
      params: {
        owner: 'child-agent',
        lockId: childLock.id,
        expectedRevision: 0,
        dryRun: true,
        operations: [{ type: 'set_node_properties', nodeIds: [node.id], params: { opacity: 0.5 } }],
      },
    },
  });
  assert.match(posts.at(-1).error, /outside its lease/);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'release_workspace_lock',
      requestId: 'child-release',
      params: { owner: 'child-agent', lockId: childLock.id },
    },
  });
  assert.equal(posts.at(-1).data.released, true);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'acquire_workspace_lock',
      requestId: 'file-lock',
      params: { owner: 'file-agent', nodeIds: [], ttlMs: 30000 },
    },
  });
  const fileLock = posts.at(-1).data.lock;
  const childVisibleBefore = child.visible;
  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'batch_transaction',
      requestId: 'batch-page-partial-write',
      params: {
        owner: 'file-agent',
        lockId: fileLock.id,
        expectedRevision: 0,
        dryRun: false,
        operations: [
          {
            type: 'set_node_visibility',
            params: {
              items: [
                { nodeId: child.id, visible: false },
                { nodeId: page.id, visible: false },
              ],
            },
          },
        ],
      },
    },
  });
  assert.match(posts.at(-1).error, /Batch target node not found/);
  assert.equal(child.visible, childVisibleBefore);
  assert.notEqual(posts.at(-1).data?.committed, true);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'release_workspace_lock',
      requestId: 'file-release',
      params: { owner: 'file-agent', lockId: fileLock.id },
    },
  });
  assert.equal(posts.at(-1).data.released, true);

  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'acquire_workspace_lock',
      requestId: 'expiring-lock',
      params: { owner: 'expiring-agent', nodeIds: [textNode.id], ttlMs: 1000 },
    },
  });
  const expiringLock = posts.at(-1).data.lock;
  deferFontLoad = true;
  const pendingBatch = figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'batch_transaction',
      requestId: 'batch-expiring-in-flight',
      params: {
        owner: 'expiring-agent',
        lockId: expiringLock.id,
        expectedRevision: 0,
        dryRun: false,
        operations: [
          {
            type: 'set_text_content',
            nodeIds: [textNode.id],
            params: { text: 'After' },
          },
        ],
      },
    },
  });
  while (!deferredFontResolve) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 1050));
  await figma.ui.onmessage({
    type: 'server-request',
    payload: {
      type: 'acquire_workspace_lock',
      requestId: 'overlap-while-expired-in-flight',
      params: { owner: 'overlap-agent', nodeIds: [textNode.id], ttlMs: 30000 },
    },
  });
  assert.match(posts.at(-1).error, /locked by expiring-agent/);
  deferredFontResolve();
  await pendingBatch;
  deferFontLoad = false;
  assert.equal(posts.at(-1).data.committed, true);
  assert.equal(textNode.characters, 'After');

  await figma.ui.onmessage({ type: 'export-design-system' });
  assert.equal(posts.at(-1).type, 'design-system-export');
  assert.equal(posts.at(-1).payload.format, 'figmoon-design-system/v1');

  await figma.ui.onmessage({
    type: 'acquire-reference',
    payload: {
      type: 'acquire_reference',
      protocol: 'figmoon-reference-acquisition/v1',
      requestId: 'request-1',
      nodeId: node.id,
      export: { format: 'PNG', scale: 1, clip: true },
    },
  });
  assert.equal(posts.at(-1).type, 'acquisition-result');
  assert.equal(posts.at(-1).payload.error, undefined, JSON.stringify(posts.at(-1).payload.error));
  assert.equal(posts.at(-1).payload.data.before.node.id, node.id);
  assert.equal(posts.at(-1).payload.data.export.base64, 'iVBORw==');

  await figma.ui.onmessage({
    type: 'acquire-reference',
    payload: {
      type: 'acquire_reference',
      protocol: 'figmoon-reference-acquisition/v1',
      requestId: 'request-2',
      nodeId: node.id,
      export: { format: 'PNG', scale: 1, clip: true },
    },
  });
  assert.equal(posts.at(-1).type, 'acquisition-result');
  assert.equal(posts.at(-1).payload.requestId, 'request-2');
  assert.equal(posts.at(-1).payload.error, undefined, JSON.stringify(posts.at(-1).payload.error));
  assert.equal(posts.at(-1).payload.data.before.node.id, node.id);

  assert.equal(typeof handlers.documentchange, 'function');
  assert.equal(typeof handlers.selectionchange, 'function');
});
