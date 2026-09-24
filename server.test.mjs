import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parseArgs } from './doctor.mjs';
import { serverBuildStatus } from './server/launch.mjs';

const root = join(import.meta.dirname, 'server');

test('Figmoon server exposes the complete compatibility and professional workspace surface', async () => {
  const [base, advanced, built] = await Promise.all([
    readFile(join(root, 'src/tools.ts'), 'utf8'),
    readFile(join(root, 'src/advanced-tools.ts'), 'utf8'),
    readFile(join(root, 'dist/advanced-tools.js'), 'utf8'),
  ]);
  assert.ok((base.match(/server\.tool\(/g) ?? []).length >= 37);
  assert.ok((advanced.match(/server\.tool\(/g) ?? []).length >= 31);
  for (const name of [
    'ingest_design_image',
    'analyze_design_image',
    'index_repository',
    'validate_design_ir',
    'map_design_to_code',
    'generate_design_plan',
    'preview_design_plan',
    'verify_design_plan',
    'search_nodes',
    'get_editor_context',
    'create_figjam_sticky',
    'create_figjam_connector',
    'create_figjam_section',
    'create_slide',
    'get_page',
    'get_components',
    'analyze_design_patterns',
    'get_library_assets',
    'instantiate_library_component',
    'import_library_variable',
    'bind_variable',
    'set_instance_properties',
    'set_reactions',
    'set_annotations',
    'get_annotations',
    'get_reactions',
    'audit_accessibility',
    'get_workspace_changes',
    'acquire_workspace_lock',
    'release_workspace_lock',
    'batch_transaction',
  ]) {
    assert.match(advanced, new RegExp(`['"]${name}['"]`));
    assert.ok(built.includes(name));
  }
});

test('transaction contract is bounded, owner-locked, revision-checked, and reversible', async () => {
  const [server, schema, plugin] = await Promise.all([
    readFile(join(root, 'src/advanced-tools.ts'), 'utf8'),
    readFile(join(root, 'src/schema.ts'), 'utf8'),
    readFile(join(import.meta.dirname, 'plugin/src/main/workspace.ts'), 'utf8'),
  ]);
  assert.match(schema, /z\.array\(batchOperationSchema\)\.min\(1\)\.max\(100\)/);
  assert.match(server, /batchTransactionParamsSchema\.shape/);
  assert.match(plugin, /requireLock/);
  assert.match(plugin, /Revision conflict/);
  assert.match(plugin, /figma\.commitUndo\(\)/);
  assert.match(plugin, /figma\.triggerUndo\(\)/);
  assert.match(plugin, /outside its lease/);
});

test('batch RPC validation canonicalises execution targets and rejects spoofed scopes', async () => {
  const { validateRpc } = await import('./server/dist/schema.js');
  const base = {
    owner: 'test-agent',
    lockId: 'lock-1',
    expectedRevision: 0,
    dryRun: true,
  };
  const valid = validateRpc('batch_transaction', undefined, {
    ...base,
    operations: [
      {
        type: 'set_node_visibility',
        params: { items: [{ nodeId: '1:2', visible: false }] },
      },
      {
        type: 'set_text_content',
        nodeIds: ['1:3'],
        params: { characters: 'canonical text' },
      },
      {
        type: 'set_solid_fill',
        nodeIds: ['1:4'],
        params: { fillHex: '#123456' },
      },
    ],
  });
  assert.equal(valid.error, null);
  assert.deepEqual(valid.params.operations[0].nodeIds, ['1:2']);
  assert.deepEqual(valid.params.operations[1].params, { text: 'canonical text' });
  assert.deepEqual(valid.params.operations[2].params, { hex: '#123456', opacity: undefined });

  const visibilitySpoof = validateRpc('batch_transaction', undefined, {
    ...base,
    operations: [
      {
        type: 'set_node_visibility',
        nodeIds: ['1:2'],
        params: { items: [{ nodeId: '1:4', visible: false }] },
      },
    ],
  });
  assert.match(visibilitySpoof.error, /must exactly match visibility/);

  const ambiguousTarget = validateRpc('batch_transaction', undefined, {
    ...base,
    operations: [
      {
        type: 'set_node_properties',
        nodeIds: ['1:2', '1:3'],
        params: { opacity: 0.5 },
      },
    ],
  });
  assert.match(ambiguousTarget.error, /requires exactly one target node ID/);

  const invalidParams = validateRpc('batch_transaction', undefined, {
    ...base,
    operations: [
      {
        type: 'set_node_properties',
        nodeIds: ['1:2'],
        params: { opacity: 2 },
      },
    ],
  });
  assert.match(invalidParams.error, /less than or equal to 1/);

  assert.match(
    validateRpc('batch_transaction', ['1:2'], { ...base, operations: [] }).error,
    /does not accept top-level nodeIds/
  );
});

test('transport is restricted to the validator-compatible loopback hostname', async () => {
  const [leader, node, election, tools] = await Promise.all([
    readFile(join(root, 'src/leader.ts'), 'utf8'),
    readFile(join(root, 'src/node.ts'), 'utf8'),
    readFile(join(root, 'src/election.ts'), 'utf8'),
    readFile(join(root, 'src/tools.ts'), 'utf8'),
  ]);
  assert.match(leader, /listen\(this\.port, 'localhost'/);
  for (const source of [node, election, tools]) assert.match(source, /http:\/\/localhost/);
});

test('MCP launcher sees the checked build as current', () => {
  assert.deepEqual(serverBuildStatus(), { ready: true, reason: 'current' });
});

test('doctor verifies configuration, integrity, transport, and intended-file readiness', async () => {
  const source = await readFile(join(import.meta.dirname, 'doctor.mjs'), 'utf8');
  for (const check of [
    'singlePlugin',
    'pluginIntegrity',
    'mcpConfiguration',
    'serverBuild',
    'transport',
    'pluginConnection',
    'intendedFile',
    'loadedPluginBuild',
    'workspaceContext',
  ]) {
    assert.ok(source.includes(`'${check}'`));
  }
  assert.match(source, /list_files/);
  assert.match(source, /probeFile\.pluginBuild === expectedPluginBuild/);
  assert.match(source, /argument === '--file-key' \? 'fileKey' : 'fileName'/);
});

test('doctor preserves exact file-name and file-key selectors', () => {
  assert.deepEqual(parseArgs(['--file-name', 'Example Design File (Copy)', '--file-key', 'stable']), {
    json: false,
    fileName: 'Example Design File (Copy)',
    fileKey: 'stable',
  });
  assert.throws(() => parseArgs(['--file-name']), /requires one value/);
});
