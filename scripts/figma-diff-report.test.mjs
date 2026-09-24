import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(scriptDir, '..');
const diffReportScript = join(scriptDir, 'figma-diff-report.mjs');

test('embeds the complete visual review surface in the report HTML', (t) => {
  const reportRoot = mkdtempSync(join(tmpdir(), 'figmoon-diff-report-'));
  t.after(() => rmSync(reportRoot, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [diffReportScript, '--id', 'comp-message-actions', '--out-dir', reportRoot],
    { cwd: clientRoot, encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const html = readFileSync(join(reportRoot, 'index.html'), 'utf8');
  const imageSources = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);

  assert.equal(imageSources.length, 3);
  for (const source of imageSources) {
    assert.match(source, /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);
  }
  assert.doesNotMatch(html, /<img\b[^>]*\bsrc="(?!data:image\/png;base64,)/);

  const sidecars = [
    join(reportRoot, 'figma', 'comp-message-actions.png'),
    join(reportRoot, 'snapshots', 'comp-message-actions.png'),
    join(reportRoot, 'diffs', 'comp-message-actions-diff.png'),
  ];
  imageSources.forEach((source, index) => {
    assert.deepEqual(Buffer.from(source.split(',')[1], 'base64'), readFileSync(sidecars[index]));
  });
});
