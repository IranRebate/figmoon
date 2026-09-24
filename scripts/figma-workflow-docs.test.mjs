import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const packageRoot = resolve(import.meta.dirname, '..');
const rootPackage = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

// Policy and procedure each live in exactly one place. These tests guard the
// wiring (commands exist, entry points reference the canon), not document
// prose. See docs/design/pixel-perfect-workflow.md.
const policyGuide = 'docs/agent-guides/figma.md';
const canonicalWorkflow = 'docs/design/pixel-perfect-workflow.md';
const skillEntry = '.claude/skills/figma-pixel-perfect/SKILL.md';

const operationalCommands = [
  'check:figma',
  'figma:inspect',
  'figma:probe',
  'figma:measure',
  'doctor',
];

function text(path) {
  return readFileSync(join(packageRoot, path), 'utf8');
}

test('structural-first commands named by agent guidance exist', () => {
  for (const command of operationalCommands) {
    assert.equal(typeof rootPackage.scripts[command], 'string', `missing root ${command}`);
  }
  for (const command of ['design:impact', 'design:verify', 'design:lease']) {
    assert.equal(typeof rootPackage.scripts[command], 'string', `missing root ${command}`);
  }
});

test('skill entry point references both canonical documents', () => {
  const skill = text(skillEntry);
  for (const path of [policyGuide, canonicalWorkflow]) {
    assert.ok(existsSync(join(packageRoot, path)), `missing ${path}`);
    assert.ok(skill.includes(path), `${skillEntry} must reference ${path}`);
  }
});

test('workflow defers policy to the guide and keeps its lane names stable', () => {
  const workflow = text(canonicalWorkflow);
  assert.match(workflow, /agent-guides\/figma\.md/);
  for (const lane of [
    'authority-remediation',
    'content-remediation',
    'visual-remediation',
  ]) {
    assert.match(workflow, new RegExp(lane));
  }
  assert.match(
    workflow,
    /Content-difference triage/,
    'the stale-design triage valve must stay documented'
  );
});

test('config layer resolves a consumer root and package exports are complete', () => {
  const config = text('lib/config.mjs');
  assert.match(config, /resolveConsumerRoot/);
  assert.match(config, /npmWorkspace/);
  assert.match(config, /getFigmoonConfig/);

  const exportsMap = rootPackage.exports ?? {};
  for (const key of [
    './lib/config.mjs',
    './lib/figma-plugin-integrity.mjs',
    './doctor.mjs',
    './server/launch.mjs',
  ]) {
    assert.ok(exportsMap[key], `missing export ${key}`);
  }
  assert.ok(exportsMap['./scripts/*'], 'missing scripts export map');
});
