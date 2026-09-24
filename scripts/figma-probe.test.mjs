import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseProbeArguments,
  summarizeProbeDelta,
  validateProbeSpec,
} from './figma-probe.mjs';
import { renderStructuralInspectionHtml } from './lib/figma-structural-report.mjs';

function finding({ key = 'node', classification = 'visual-difference', outline = 'none' } = {}) {
  return {
    classification,
    figma: { key, name: key, text: '', rect: { x: 0, y: 0, width: 10, height: 10 } },
    browser: {
      key: `browser:${key}`,
      tag: 'button',
      text: 'بستن',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      style: { outline },
    },
    differences: { content: [], geometry: [], visual: [] },
  };
}

test('parses a bounded probe CLI and rejects duplicate or unknown input', () => {
  assert.deepEqual(
    parseProbeArguments([
      '--run',
      'runs/inspection',
      '--spec=probe.json',
      '--run-id',
      'probe-run',
      '--screenshot',
      '--json',
    ]),
    {
      run: 'runs/inspection',
      spec: 'probe.json',
      runId: 'probe-run',
      screenshot: true,
      json: true,
    }
  );
  assert.throws(
    () => parseProbeArguments(['--run', 'a', '--run=b', '--spec', 'probe.json']),
    /provided only once/
  );
  assert.throws(
    () => parseProbeArguments(['--run', 'a', '--spec', 'probe.json', '--write-source']),
    /Unsupported/
  );
});

test('validates explicit bounded style, text, and attribute overrides', () => {
  assert.deepEqual(
    validateProbeSpec({
      label: 'outline experiment',
      operations: [
        {
          selector: '[data-testid="close"]',
          styles: { outline: '2px solid red', '--probe-color': '#f00' },
          text: 'بستن',
          attributes: { 'aria-label': 'بستن', hidden: null },
        },
      ],
    }),
    {
      label: 'outline experiment',
      operations: [
        {
          selector: '[data-testid="close"]',
          styles: { outline: '2px solid red', '--probe-color': '#f00' },
          text: 'بستن',
          attributes: { 'aria-label': 'بستن', hidden: null },
        },
      ],
    }
  );
  assert.throws(() => validateProbeSpec({ operations: [] }), /1 through 12/);
  assert.throws(
    () => validateProbeSpec({ operations: [{ selector: '', styles: {} }] }),
    /bounded selector/
  );
  assert.throws(
    () => validateProbeSpec({ operations: [{ selector: 'button', styles: { 'bad style': 'x' } }] }),
    /invalid style/
  );
});

test('reports property-level before/after probe deltas without claiming parity', () => {
  const baseline = {
    summary: { counts: { 'visual-difference': 1 } },
    findings: [finding({ outline: 'none' })],
  };
  const comparison = {
    summary: { counts: { 'visual-difference': 1 } },
    findings: [finding({ outline: 'rgb(255, 0, 0) solid 2px' })],
  };
  const delta = summarizeProbeDelta(baseline, comparison);
  assert.equal(delta.structuralCaptureChanged, true);
  assert.equal(delta.changedFindingCount, 1);
  assert.deepEqual(delta.changedFindings[0].propertyChanges[0], {
    property: 'browser-style:outline',
    change: 'changed',
    baseline: 'none',
    probe: 'rgb(255, 0, 0) solid 2px',
  });
});

test('renders a self-contained structural report with escaped content', () => {
  const html = renderStructuralInspectionHtml({
    id: '<target>',
    target: { route: '/settings', viewport: 'mobile' },
    figmaSource: { kind: 'canonical-acquisition' },
    browser: { url: 'http://127.0.0.1/settings' },
    comparison: {
      authority: { blocking: false },
      workflow: {
        workflowLane: 'content-remediation',
        measurementAllowed: false,
        terminalBlocker: false,
        requiredAction: 'Continue through the production fixture and rerun inspection.',
      },
      summary: { counts: {} },
      findings: [finding()],
    },
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /&lt;target&gt;/);
  assert.match(html, /Workflow lane: content-remediation/);
  assert.match(html, /Raster measurement: held until remediation/);
  assert.match(html, /Terminal blocker: no/);
  assert.match(html, /Continue through the production fixture/);
  assert.doesNotMatch(html, /<script\b|https?:\/\/[^<]*\.(?:js|css)/i);
});
