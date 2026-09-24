import assert from 'node:assert/strict';
import test from 'node:test';
import pixelmatch from 'pixelmatch';

import { STRUCTURAL_EDGE_METRIC, structuralEdgeDiff } from './lib/figma-structural-diff.mjs';

const width = 24;
const height = 24;

function antialiasedEdge(edge, middle = 128) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = x < edge ? 0 : x === edge ? middle : 255;
      const index = (y * width + x) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

test('keeps threshold-adjacent AA intensity variance nonblocking when geometry is stable', () => {
  const comparison = structuralEdgeDiff(antialiasedEdge(8, 214), antialiasedEdge(8, 216));

  assert.equal(comparison.metric, STRUCTURAL_EDGE_METRIC);
  assert.equal(comparison.ratio, 0);
});

test('keeps every raw-equivalent two-level AA intensity step nonblocking', () => {
  for (let middle = 0; middle <= 253; middle += 1) {
    const before = antialiasedEdge(8, middle);
    const after = antialiasedEdge(8, middle + 2);
    const raw = pixelmatch(before.data, after.data, null, width, height, {
      threshold: 0.1,
      includeAA: true,
    });
    assert.equal(raw, 0);
    assert.equal(structuralEdgeDiff(before, after).ratio, 0, `middle=${middle}`);
  }
});

test('catches a one-pixel edge translation that the AA-excluded metric erases', () => {
  const before = antialiasedEdge(8);
  const after = antialiasedEdge(9);
  const raw = pixelmatch(before.data, after.data, null, width, height, {
    threshold: 0.1,
    includeAA: true,
  });
  const aaExcluded = pixelmatch(before.data, after.data, null, width, height, {
    threshold: 0.1,
    includeAA: false,
  });
  const structural = structuralEdgeDiff(before, after);

  assert.equal(raw, 48);
  assert.equal(aaExcluded, 0);
  assert.ok(structural.ratio > 0.002);
});

test('does not dilute a small shifted edge inside a full mobile canvas', () => {
  const mobileWidth = 390;
  const mobileHeight = 844;
  const mobileEdge = (edge) => {
    const data = new Uint8Array(mobileWidth * mobileHeight * 4).fill(255);
    for (let y = 410; y < 434; y += 1) {
      for (let x = 170; x < 194; x += 1) {
        const localX = x - 170;
        const value = localX < edge ? 0 : localX === edge ? 128 : 255;
        const index = (y * mobileWidth + x) * 4;
        data[index] = value;
        data[index + 1] = value;
        data[index + 2] = value;
        data[index + 3] = 255;
      }
    }
    return { width: mobileWidth, height: mobileHeight, data };
  };

  const comparison = structuralEdgeDiff(mobileEdge(8), mobileEdge(9));

  assert.ok(comparison.canvasRatio < 0.002);
  assert.ok(comparison.ratio > 0.002);
});
