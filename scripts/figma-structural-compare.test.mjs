import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareStructuralEvidence,
  flattenFigmaTree,
  normalizeColor,
  normalizeText,
  workflowForComparison,
} from './lib/figma-structural-compare.mjs';

function browser(elements) {
  return {
    captureRect: { x: 0, y: 0, width: 390, height: 844 },
    elements,
  };
}

function element({ key, tag = 'span', text = '', rect, style = {}, reactStack = [] }) {
  return {
    key,
    tag,
    text,
    rect,
    style: {
      color: 'rgb(118, 132, 167)',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderColor: 'rgba(0, 0, 0, 0)',
      borderWidth: '0px',
      borderRadius: '0px',
      fontFamily: 'Yekan Bakh FaNum, sans-serif',
      fontSize: '16px',
      fontWeight: '400',
      lineHeight: '24px',
      letterSpacing: '0px',
      opacity: '1',
      display: 'block',
      gap: 'normal',
      padding: { top: '0px', right: '0px', bottom: '0px', left: '0px' },
      textAlign: 'right',
      ...style,
    },
    reactStack,
  };
}

test('normalizes RTL text and CSS colors', () => {
  assert.equal(normalizeText('‏  حذف   حساب  '), 'حذف حساب');
  assert.equal(normalizeColor('rgb(118, 132, 167)'), '#7684a7');
  assert.equal(normalizeColor('rgba(0, 0, 0, 0)'), null);
});

test('flattens parent-relative Figma coordinates', () => {
  const nodes = flattenFigmaTree({
    id: 'root',
    name: 'root',
    type: 'FRAME',
    bounds: { x: 1000, y: 2000, width: 390, height: 844 },
    children: [
      {
        id: 'frame',
        name: 'frame',
        type: 'FRAME',
        bounds: { x: 16, y: 124, width: 358, height: 72 },
        children: [
          {
            id: 'text',
            name: 'label',
            type: 'TEXT',
            characters: 'پاک‌سازی',
            bounds: { x: 10, y: 8, width: 80, height: 28 },
            styles: { fills: [{ type: 'SOLID', color: '#7684A7', opacity: 1 }] },
          },
        ],
      },
    ],
  });
  assert.deepEqual(nodes.find((node) => node.id === 'frame').rect, {
    x: 16,
    y: 124,
    width: 358,
    height: 72,
  });
  assert.deepEqual(nodes.find((node) => node.id === 'text').rect, {
    x: 26,
    y: 132,
    width: 80,
    height: 28,
  });
});

test('clips Figma descendants to the captured root viewport', () => {
  const nodes = flattenFigmaTree({
    id: 'root',
    name: 'root',
    type: 'FRAME',
    bounds: { x: 0, y: 0, width: 390, height: 844 },
    children: [
      {
        id: 'partial',
        name: 'partial',
        type: 'TEXT',
        characters: 'بخشی قابل مشاهده',
        bounds: { x: 20, y: 835, width: 100, height: 20 },
      },
      {
        id: 'offscreen',
        name: 'offscreen',
        type: 'TEXT',
        characters: 'خارج از کادر',
        bounds: { x: 20, y: 900, width: 100, height: 20 },
      },
    ],
  });

  assert.deepEqual(nodes.find((node) => node.id === 'partial')?.rect, {
    x: 20,
    y: 835,
    width: 100,
    height: 9,
  });
  assert.equal(nodes.some((node) => node.id === 'offscreen'), false);
});

test('matches exact text and reports property-level visual differences', () => {
  const figma = {
    id: 'root',
    name: 'root',
    type: 'FRAME',
    bounds: { x: 0, y: 0, width: 390, height: 844 },
    children: [
      {
        id: 'label',
        name: 'نام',
        type: 'TEXT',
        characters: 'نام',
        bounds: { x: 16, y: 165, width: 80, height: 24 },
        styles: {
          fills: [{ type: 'SOLID', color: '#7684A7', opacity: 1 }],
          fontFamily: 'Yekan Bakh FaNum',
          fontSize: 16,
          fontWeight: 400,
          lineHeight: { value: 24, unit: 'PIXELS' },
        },
      },
    ],
  };
  const result = compareStructuralEvidence({
    figma,
    browser: browser([
      element({
        key: 'name',
        text: 'نام',
        rect: { x: 16, y: 165, width: 80, height: 24 },
        style: { color: 'rgb(149, 162, 191)' },
      }),
    ]),
    item: { referenceStatus: 'mapped', parityStatus: 'drifting' },
  });
  assert.equal(result.summary.matchedPairs, 1);
  assert.equal(result.findings[0].classification, 'visual-difference');
  assert.deepEqual(result.findings[0].differences.visual[0], {
    property: 'color',
    figma: '#7684a7',
    browser: '#95a2bf',
  });
  assert.equal(result.workflow.workflowLane, 'visual-remediation');
  assert.equal(result.workflow.measurementAllowed, true);
  assert.equal(result.workflow.terminalBlocker, false);
});

test('routes production-valid copy differences to mandatory nonterminal content remediation', () => {
  const figma = {
    id: 'root',
    name: 'root',
    type: 'FRAME',
    bounds: { x: 0, y: 0, width: 390, height: 844 },
    children: [
      {
        id: 'message',
        name: 'پیام',
        type: 'TEXT',
        characters: 'محتوای دقیق فیگما',
        bounds: { x: 16, y: 120, width: 180, height: 28 },
        styles: { fills: [{ type: 'SOLID', color: '#7684A7', opacity: 1 }] },
      },
    ],
  };
  const result = compareStructuralEvidence({
    figma,
    browser: browser([
      element({
        key: 'message',
        text: 'محتوای داده فعلی',
        rect: { x: 16, y: 120, width: 180, height: 28 },
      }),
    ]),
    item: { referenceStatus: 'mapped', parityStatus: 'drifting' },
  });

  assert.equal(result.summary.counts['content-difference'], 1);
  assert.equal(result.workflow.workflowLane, 'content-remediation');
  assert.equal(result.workflow.measurementAllowed, false);
  assert.equal(result.workflow.terminalBlocker, false);
  assert.match(result.workflow.requiredAction, /production props\/state\/store/);
});

test('routes a missing valid Figma input to Case 2 component-model remediation', () => {
  const figma = {
    id: 'root',
    name: 'root',
    type: 'FRAME',
    bounds: { x: 0, y: 0, width: 390, height: 844 },
    children: [
      {
        id: 'required-copy',
        name: 'required-copy',
        type: 'TEXT',
        characters: 'ورودی معتبر مورد نیاز',
        bounds: { x: 16, y: 120, width: 180, height: 28 },
        styles: { fills: [{ type: 'SOLID', color: '#7684A7', opacity: 1 }] },
      },
    ],
  };
  const result = compareStructuralEvidence({
    figma,
    browser: browser([
      element({
        key: 'root',
        tag: 'div',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      }),
    ]),
    item: { referenceStatus: 'mapped', parityStatus: 'drifting' },
  });

  assert.equal(result.summary.counts['content-difference'], 1);
  assert.equal(result.workflow.workflowLane, 'content-remediation');
  assert.equal(result.workflow.terminalBlocker, false);
  assert.match(result.workflow.requiredAction, /extend its real component model/i);
});

test('routes extra rendered copy to content remediation instead of unresolved visual drift', () => {
  const figma = {
    id: 'root',
    name: 'root',
    type: 'FRAME',
    bounds: { x: 0, y: 0, width: 390, height: 844 },
    children: [],
  };
  const result = compareStructuralEvidence({
    figma,
    browser: browser([
      element({
        key: 'root',
        tag: 'div',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      }),
      element({
        key: 'extra-copy',
        text: 'متن اضافه محصول',
        rect: { x: 16, y: 120, width: 180, height: 28 },
      }),
    ]),
    item: { referenceStatus: 'mapped', parityStatus: 'drifting' },
  });

  assert.equal(result.summary.counts['content-difference'], 1);
  assert.equal(result.workflow.workflowLane, 'content-remediation');
  assert.equal(result.workflow.terminalBlocker, false);
});

test('keeps valid-authority content remediation ahead of unrelated unresolved elements', () => {
  const workflow = workflowForComparison(
    { blocking: false, terminal: false },
    {
      'product-authority-conflict': 0,
      'state/mapping-difference': 0,
      'content-difference': 3,
      unresolved: 12,
    }
  );

  assert.deepEqual(workflow, {
    workflowLane: 'content-remediation',
    measurementAllowed: false,
    terminalBlocker: false,
    requiredAction:
      'Continue the task: render the qualified Figma records, order, dates, values, and copy through production props/state/store or a production-valid API-shaped fixture. If the view cannot express that valid state, extend its real component model or separate ConnectedContainer from PureView. Rerun figma:inspect until content-difference is zero.',
  });
});

test('classifies same-region copy disagreement as a product authority conflict', () => {
  const figma = {
    id: 'root',
    name: 'root',
    type: 'FRAME',
    bounds: { x: 0, y: 0, width: 390, height: 844 },
    children: [
      {
        id: 'delete',
        name: 'حذف حساب',
        type: 'TEXT',
        characters: 'حذف حساب',
        bounds: { x: 304, y: 599, width: 70, height: 28 },
        styles: { fills: [{ type: 'SOLID', color: '#7684A7', opacity: 1 }] },
      },
    ],
  };
  const result = compareStructuralEvidence({
    figma,
    browser: browser([
      element({
        key: 'cleanup',
        text: 'پاک‌سازی داده‌های محلی',
        rect: { x: 229, y: 599, width: 145, height: 28 },
        reactStack: ['ProfileTab'],
      }),
    ]),
    item: { referenceStatus: 'mapped', parityStatus: 'drifting' },
    productDecisions: [
      {
        status: 'open',
        reason: 'The product safety wording must remain local cleanup, not account deletion.',
      },
    ],
  });
  assert.equal(result.authority.blocking, true);
  assert.equal(result.summary.counts['product-authority-conflict'], 1);
  assert.equal(result.findings[0].browser.text, 'پاک‌سازی داده‌های محلی');
  assert.equal(result.workflow.workflowLane, 'authority-remediation');
  assert.equal(result.workflow.measurementAllowed, false);
  assert.equal(result.workflow.terminalBlocker, true);
});

test('keeps a correctable state mismatch nonterminal while measurement stays closed', () => {
  const result = compareStructuralEvidence({
    figma: {
      id: 'root',
      name: 'root',
      type: 'FRAME',
      bounds: { x: 0, y: 0, width: 390, height: 844 },
      children: [],
    },
    browser: browser([
      element({
        key: 'root',
        tag: 'div',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      }),
    ]),
    item: { referenceStatus: 'mapped', parityStatus: 'not-comparable' },
  });

  assert.equal(result.workflow.workflowLane, 'authority-remediation');
  assert.equal(result.workflow.measurementAllowed, false);
  assert.equal(result.workflow.terminalBlocker, false);
  assert.match(result.workflow.requiredAction, /Continue the task/);
});

test('keeps ambiguous inferred matches unresolved', () => {
  const figma = {
    id: 'root',
    name: 'root',
    type: 'FRAME',
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    children: [
      {
        id: 'shape',
        name: 'shape',
        type: 'RECTANGLE',
        bounds: { x: 10, y: 10, width: 20, height: 20 },
        styles: { fills: [{ type: 'SOLID', color: '#ffffff', opacity: 1 }] },
      },
    ],
  };
  const result = compareStructuralEvidence({
    figma,
    browser: browser([
      element({ key: 'a', tag: 'div', rect: { x: 10, y: 10, width: 20, height: 20 }, style: { backgroundColor: '#ffffff' } }),
      element({ key: 'b', tag: 'div', rect: { x: 10, y: 10, width: 20, height: 20 }, style: { backgroundColor: '#ffffff' } }),
    ]),
    item: { referenceStatus: 'mapped', parityStatus: 'drifting' },
  });
  assert.equal(result.summary.matchedPairs, 0);
  assert.equal(result.findings[0].classification, 'unresolved');
  assert.equal(result.findings[0].browser.key, 'a');
  assert.equal(result.workflow.workflowLane, 'visual-remediation');
  assert.equal(result.workflow.measurementAllowed, true);
  assert.equal(result.workflow.terminalBlocker, false);
});
