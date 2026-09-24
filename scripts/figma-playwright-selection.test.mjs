import assert from 'node:assert/strict';
import test from 'node:test';
import { exactPlaywrightSelection } from './lib/figma-playwright-selection.mjs';
import { visualProjectForTarget } from './lib/figma-visual-project.mjs';

function report(tests) {
  return {
    errors: [],
    suites: [
      {
        specs: tests.map((entry, index) => ({
          title: entry.title,
          file: 'visual/components.spec.ts',
          line: 10 + index,
          column: 1,
          tests: [{ projectId: 'desktop', projectName: 'desktop' }],
        })),
      },
    ],
  };
}

test('accepts one exact registered Playwright test', () => {
  assert.deepEqual(
    exactPlaywrightSelection({
      report: report([{ title: 'comp-message-actions' }]),
      testName: 'comp-message-actions',
      testFile: 'client/e2e/visual/components.spec.ts',
      project: 'desktop',
    }),
    {
      title: 'comp-message-actions',
      file: 'visual/components.spec.ts',
      line: 10,
      column: 1,
      projectId: 'desktop',
      projectName: 'desktop',
    }
  );
});

test('rejects duplicate final titles that would fan out one-target capture', () => {
  assert.throws(
    () =>
      exactPlaywrightSelection({
        report: report([{ title: 'comp-message-actions' }, { title: 'comp-message-actions' }]),
        testName: 'comp-message-actions',
        testFile: 'client/e2e/visual/components.spec.ts',
        project: 'desktop',
      }),
    /requires exactly one Playwright test; discovery resolved 2/
  );
});

test('rejects a mismatched file or project even when one test is selected', () => {
  assert.throws(
    () =>
      exactPlaywrightSelection({
        report: report([{ title: 'comp-message-actions' }]),
        testName: 'comp-message-actions',
        testFile: 'client/e2e/visual/pages.spec.ts',
        project: 'desktop',
      }),
    /contradicts the registered target test contract/
  );
});

test('routes mobile component targets through the touch-enabled component project', () => {
  assert.equal(
    visualProjectForTarget({ kind: 'component', viewport: 'mobile' }),
    'mobile-components'
  );
  assert.equal(visualProjectForTarget({ kind: 'component', viewport: 'desktop' }), 'desktop');
  assert.equal(visualProjectForTarget({ kind: 'page', viewport: 'mobile' }), 'mobile');
});
