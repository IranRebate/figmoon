import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { auditTargetMaskingFiles } from './lib/figma-masking-audit.mjs';

function withRepository(sources, run) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'figma-masking-audit-'));
  try {
    for (const [file, source] of Object.entries(sources)) {
      const absolute = join(repoRoot, file);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, source);
    }
    return run(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test('scans the complete declared target closure with AST and CSS-aware masking rules', () => {
  withRepository(
    {
      'client/src/hooks/useTarget.ts': `
        import { isVisualQA as readQa } from '../lib/visualQA.js';
        import { visualQaMode } from '../lib/runtime.js';
        const screenshotMode = readQa;
        export const useTarget = () => screenshotMode() ? 'hidden' : 'visible';
        export const importedBranch = visualQaMode ? 'hidden' : 'visible';
      `,
      'client/src/api/target.ts': `
        export const reference = '/figma-refs/target.png';
      `,
      'client/src/target.css': `
        .target { mask: radial-gradient(white, black); }
        html.visual-qa .target { opacity: 0; }
      `,
      'client/e2e/visual/target.spec.ts': `
        await page.evaluate(() => document.fonts.ready);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await expect(page).toHaveScreenshot('target.png', { mask: [page.locator('.clock')] });
        const injectStyle = page.addStyleTag;
        await injectStyle.call(page, { content: '.target { display: none }' });
        await page.evaluate(() => {
          const node = document.querySelector('.target');
          const style = node.style;
          style.opacity = '0';
          node.textContent = 'replacement';
        });
      `,
      'server/src/fixtures/target.json': `{"image":"/images/reference-figma-target.png"}`,
    },
    (repoRoot) => {
      const files = [
        'client/src/hooks/useTarget.ts',
        'client/src/api/target.ts',
        'client/src/target.css',
        'client/e2e/visual/target.spec.ts',
        'server/src/fixtures/target.json',
      ];
      const result = auditTargetMaskingFiles({ repoRoot, files });
      assert.deepEqual(result.inspectedFiles.map(({ file }) => file).sort(), [...files].sort());
      const kinds = new Set(result.findings.map(({ kind }) => kind));
      assert.equal(kinds.has('visual-qa-product-branch'), true);
      assert.equal(kinds.has('reference-image-substitution'), true);
      assert.equal(kinds.has('visual-qa-style-substitution'), true);
      assert.equal(kinds.has('screenshot-mask'), true);
      assert.equal(kinds.has('renderer-substitution'), true);
      assert.equal(kinds.has('style-substitution'), true);
      assert.equal(kinds.has('dom-substitution'), true);
      assert.equal(
        result.findings.some(
          ({ file, text }) =>
            file === 'client/src/target.css' && text.includes('mask: radial-gradient')
        ),
        false,
        'ordinary product CSS masks are not Playwright screenshot masks'
      );
      assert.equal(
        result.findings.some(({ text }) => text.includes('document.fonts.ready')),
        false,
        'read-only page.evaluate calls remain valid'
      );
    }
  );
});

test('keeps dedicated fixture infrastructure and the two approved foundation checks out of masking findings', () => {
  withRepository(
    {
      'client/src/lib/visualQA.ts': `
        export function isVisualQA() {
          return localStorage.getItem('VISUAL_QA') === '1';
        }
      `,
      'client/src/components/shared/VisualQAComponents.tsx': `
        import blue from '../../../../docs/design/figma/foundation/Blue.svg?url';
        import typography from '../../../../docs/design/figma/foundation/Typography_Secondary font.png?url';
        export const fixtures = [blue, typography];
      `,
    },
    (repoRoot) => {
      const result = auditTargetMaskingFiles({
        repoRoot,
        files: [
          'client/src/lib/visualQA.ts',
          'client/src/components/shared/VisualQAComponents.tsx',
        ],
      });
      assert.deepEqual(result.findings, []);
    }
  );
});

test('preserves exact-line and sourceContains exception metadata without unblocking signoff findings', () => {
  withRepository(
    {
      'client/src/hooks/useTarget.ts': `
        export const value = isVisualQA() ? 'fixture' : 'product';
      `,
      'client/src/components/Target.tsx': `
        export const image = '/images/figma-target-reference.png';
      `,
    },
    (repoRoot) => {
      const result = auditTargetMaskingFiles({
        repoRoot,
        files: ['client/src/hooks/useTarget.ts', 'client/src/components/Target.tsx'],
        exceptionRegistry: {
          exceptions: [
            {
              id: 'visual-exception',
              file: 'client/src/hooks/useTarget.ts',
              source: "export const value = isVisualQA() ? 'fixture' : 'product';",
              category: 'intentional-design-deviation',
              rationale: 'reviewed',
              reviewBy: '2099-01-01',
            },
          ],
          referenceImageExceptions: [
            {
              id: 'reference-exception',
              file: 'client/src/components/Target.tsx',
              sourceContains: 'figma-target-reference.png',
              reason: 'reviewed',
              reviewBy: '2099-01-01',
            },
          ],
        },
      });
      assert.equal(result.findings.length, 2);
      assert.deepEqual(
        new Set(result.findings.map(({ exceptionId }) => exceptionId)),
        new Set(['visual-exception', 'reference-exception'])
      );
      assert.equal(
        result.findings.every(({ allowedByPolicy }) => allowedByPolicy === true),
        true
      );
    }
  );
});

test('fails closed when a target source path is missing, escaping, or syntactically invalid', () => {
  withRepository(
    {
      'client/src/Broken.tsx': 'export const Broken = <div>;',
    },
    (repoRoot) => {
      const result = auditTargetMaskingFiles({
        repoRoot,
        files: ['client/src/Broken.tsx', 'client/src/Missing.ts', '../outside.ts'],
      });
      const kinds = new Set(result.findings.map(({ kind }) => kind));
      assert.equal(kinds.has('target-source-parse-error'), true);
      assert.equal(kinds.has('target-source-unavailable'), true);
      assert.equal(kinds.has('target-source-path-invalid'), true);
    }
  );
});
