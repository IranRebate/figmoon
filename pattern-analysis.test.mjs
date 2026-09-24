import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeDesignPatterns } from './plugin/src/main/pattern-analysis.mjs';

const text = (id, characters) => ({
  id,
  name: 'Label',
  type: 'TEXT',
  visible: true,
  width: 80,
  height: 20,
  characters,
  fontName: { family: 'Inter', style: 'Regular' },
  fontSize: 14,
  fontWeight: 400,
  lineHeight: { unit: 'PIXELS', value: 20 },
  letterSpacing: { unit: 'PIXELS', value: 0 },
});

const input = (id, characters, width = 240) => ({
  id,
  name: 'Input',
  type: 'FRAME',
  visible: true,
  width,
  height: 40,
  layoutMode: 'HORIZONTAL',
  itemSpacing: 8,
  children: [
    { id: `${id}:icon`, name: 'Icon', type: 'VECTOR', visible: true, width: 16, height: 16 },
    text(`${id}:text`, characters),
  ],
});

const page = {
  id: '1:1',
  name: 'Final',
  type: 'PAGE',
  visible: true,
  children: [input('1:2', 'Email'), input('1:3', 'Phone'), input('1:4', 'Search', 320)],
};

test('pattern analysis abstracts literal copy while retaining geometric variants', () => {
  const result = analyzeDesignPatterns(page, {
    minimumOccurrences: 2,
    minimumSubtreeNodes: 3,
  });

  assert.equal(result.summary.scannedNodeCount, 10);
  assert.equal(result.summary.rawCandidateCount, 3);
  const exact = result.exactTemplateClusters.find((cluster) => cluster.occurrenceCount === 2);
  assert.ok(exact);
  assert.equal(exact.contentVariantCount, 2);
  assert.equal(exact.hasContentSlotEvidence, true);
  assert.match(exact.code, /^T-[A-F0-9]{8,16}$/);

  const relaxed = result.relaxedVariantFamilies.find(
    (family) => family.occurrenceCount === 3 && family.templateVariantCount === 2
  );
  assert.ok(relaxed);
  assert.match(relaxed.code, /^S-[A-F0-9]{8,16}$/);
});

test('authored instances stay opaque and do not leak their expanded child trees as raw patterns', () => {
  const expandedInstance = {
    id: '2:2',
    name: 'Button',
    type: 'INSTANCE',
    visible: true,
    width: 120,
    height: 40,
    componentProperties: { Label: { type: 'TEXT', value: 'Save' } },
    children: [input('2:3', 'Expanded internals')],
  };
  const result = analyzeDesignPatterns(
    { id: '2:1', name: 'Final', type: 'PAGE', visible: true, children: [expandedInstance] },
    { minimumSubtreeNodes: 2 }
  );

  assert.equal(result.summary.scannedNodeCount, 2);
  assert.equal(result.summary.authoredInstanceCount, 1);
  assert.equal(result.summary.rawCandidateCount, 0);
});
