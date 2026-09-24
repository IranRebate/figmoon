import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeDesignImage,
  diffDesignStructures,
  evolveRepairRubrics,
  exportDesignTokensDTCG,
  ingestDesignImage,
  generateDesignPlan,
  indexRepository,
  mapDesignToCode,
  REPAIR_ASPECTS,
  scoreDesignParity,
  selectRepairRubric,
  validateDesignIR,
  verifyDesignPlan,
  type DesignIR,
} from './design-pipeline.js';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'figmoon-design-'));
  const image = path.join(directory, 'input.svg');
  await writeFile(
    image,
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#fff"/><rect x="8" y="8" width="100" height="40" fill="#0f766e"/><text x="16" y="32">Figmoon demo</text></svg>'
  );
  return { directory, image };
}

test('ingestion fingerprints image and records dimensions without mutating the source', async () => {
  const { directory, image } = await fixture();
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), 'figmoon-artifacts-'));
  const previous = process.env.FIGMOON_ARTIFACT_DIR;
  process.env.FIGMOON_ARTIFACT_DIR = artifactDirectory;
  try {
    const result = await ingestDesignImage(image);
    const data = result.data as { mediaType: string; width: number; height: number };
    assert.equal(data.mediaType, 'image/svg+xml');
    assert.equal(data.width, 320);
    assert.equal(data.height, 180);
    assert.equal(result.artifacts[0].stage, 'ingest');
    assert.equal(
      await readFile(image, 'utf8'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#fff"/><rect x="8" y="8" width="100" height="40" fill="#0f766e"/><text x="16" y="32">Figmoon demo</text></svg>'
    );
  } finally {
    if (previous === undefined) delete process.env.FIGMOON_ARTIFACT_DIR;
    else process.env.FIGMOON_ARTIFACT_DIR = previous;
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(artifactDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('fixture analysis is deterministic and exposes unresolved semantics', async () => {
  const { directory, image } = await fixture();
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), 'figmoon-artifacts-'));
  const previous = process.env.FIGMOON_ARTIFACT_DIR;
  process.env.FIGMOON_ARTIFACT_DIR = artifactDirectory;
  try {
    const first = await analyzeDesignImage(image);
    const second = await analyzeDesignImage(image);
    assert.deepEqual(first.data, second.data);
    assert.match(first.warnings[0], /vision provider/);
    const ir = first.data as DesignIR;
    const elements = ir.elements[0].children ?? [];
    assert.ok(
      elements.some((element) => element.kind === 'text' && element.content === 'Figmoon demo')
    );
    assert.ok(elements.some((element) => element.kind === 'shape' && element.fill === '#0f766e'));
    assert.equal(ir.schemaVersion, '1.0');
  } finally {
    if (previous === undefined) delete process.env.FIGMOON_ARTIFACT_DIR;
    else process.env.FIGMOON_ARTIFACT_DIR = previous;
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(artifactDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('mapping reports exact, ambiguous, and unresolved candidates', async () => {
  const { directory, image } = await fixture();
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), 'figmoon-artifacts-'));
  const previous = process.env.FIGMOON_ARTIFACT_DIR;
  process.env.FIGMOON_ARTIFACT_DIR = artifactDirectory;
  try {
    const analysis = await analyzeDesignImage(image);
    const ir = analysis.data as DesignIR;
    const children = ir.elements[0].children ?? [];
    const mapped = mapDesignToCode(
      { ...ir, elements: [{ ...ir.elements[0], children: [children[0]] }] },
      [{ id: 'card', name: 'Card', role: 'rect' }]
    );
    assert.equal(mapped.find((item) => item.elementId === children[0].id)?.status, 'mapped');
    const ambiguous = mapDesignToCode(
      { ...ir, elements: [{ ...ir.elements[0], children: [children[0]] }] },
      [
        { id: 'a', name: 'Card', role: 'rect' },
        { id: 'b', name: 'CardAlt', role: 'rect' },
      ]
    );
    assert.equal(ambiguous.find((item) => item.elementId === children[0].id)?.status, 'ambiguous');
    const unresolved = mapDesignToCode(
      { ...ir, elements: [{ ...ir.elements[0], children: [children[0]] }] },
      []
    );
    assert.equal(
      unresolved.find((item) => item.elementId === children[0].id)?.status,
      'unresolved'
    );
  } finally {
    if (previous === undefined) delete process.env.FIGMOON_ARTIFACT_DIR;
    else process.env.FIGMOON_ARTIFACT_DIR = previous;
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(artifactDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('repository-aware plans retain mapping evidence without enabling write-back', async () => {
  const { directory, image } = await fixture();
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), 'figmoon-artifacts-'));
  const previous = process.env.FIGMOON_ARTIFACT_DIR;
  process.env.FIGMOON_ARTIFACT_DIR = artifactDirectory;
  try {
    await writeFile(path.join(directory, 'Rect.tsx'), 'export function Rect() { return null; }');
    const result = await generateDesignPlan(image, directory);
    const plan = result.data as {
      repository?: { root: string };
      writeBack: { allowed: boolean };
      mappings: Array<{ status: string }>;
    };
    assert.equal(plan.repository?.root, directory);
    assert.equal(plan.writeBack.allowed, false);
    assert.ok(plan.mappings.some((mapping) => mapping.status === 'mapped'));
  } finally {
    if (previous === undefined) delete process.env.FIGMOON_ARTIFACT_DIR;
    else process.env.FIGMOON_ARTIFACT_DIR = previous;
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(artifactDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('repository indexing is bounded and returns source candidates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'figmoon-repo-'));
  try {
    await writeFile(
      path.join(directory, 'Button.tsx'),
      'export function Button() { return null; }'
    );
    await writeFile(path.join(directory, 'tokens.css'), ':root { --primary-color: #0f766e; }');
    const result = await indexRepository(directory, 10);
    assert.equal(result.filesScanned, 2);
    assert.equal(result.truncated, false);
    assert.ok(result.candidates.some((candidate) => candidate.name === 'Button'));
    assert.ok(result.candidates.some((candidate) => candidate.name === 'primary-color'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('provider analysis accepts an identity-bound IR over explicit local HTTP opt-in', async () => {
  const { directory, image } = await fixture();
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), 'figmoon-artifacts-'));
  const previousArtifacts = process.env.FIGMOON_ARTIFACT_DIR;
  const previousHttp = process.env.FIGMOON_VISION_ALLOW_INSECURE_HTTP;
  const previousPrivate = process.env.FIGMOON_VISION_ALLOW_PRIVATE_NETWORK;
  process.env.FIGMOON_ARTIFACT_DIR = artifactDirectory;
  process.env.FIGMOON_VISION_ALLOW_INSECURE_HTTP = '1';
  process.env.FIGMOON_VISION_ALLOW_PRIVATE_NETWORK = '1';
  const server = createServer(async (request, response) => {
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(Buffer.from(chunk));
    const source = Buffer.concat(body);
    const sourceDigest = (await import('node:crypto'))
      .createHash('sha256')
      .update(source)
      .digest('hex');
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        schemaVersion: '1.0',
        source: {
          digest: sourceDigest,
          mediaType: 'image/svg+xml',
          width: 320,
          height: 180,
          path: image,
        },
        canvas: { width: 320, height: 180, background: '#fff' },
        elements: [],
        tokens: [],
        componentCandidates: [],
        responsiveStates: [],
        interactionStates: [],
        unresolvedQuestions: [],
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const result = await analyzeDesignImage(image, {
      endpoint: `http://127.0.0.1:${address.port}`,
    });
    assert.equal((result.data as DesignIR).source.width, 320);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    if (previousArtifacts === undefined) delete process.env.FIGMOON_ARTIFACT_DIR;
    else process.env.FIGMOON_ARTIFACT_DIR = previousArtifacts;
    if (previousHttp === undefined) delete process.env.FIGMOON_VISION_ALLOW_INSECURE_HTTP;
    else process.env.FIGMOON_VISION_ALLOW_INSECURE_HTTP = previousHttp;
    if (previousPrivate === undefined) delete process.env.FIGMOON_VISION_ALLOW_PRIVATE_NETWORK;
    else process.env.FIGMOON_VISION_ALLOW_PRIVATE_NETWORK = previousPrivate;
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(artifactDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('provider analysis rejects an identity-mismatched IR', async () => {
  const { directory, image } = await fixture();
  const previous = process.env.FIGMOON_VISION_ALLOW_INSECURE_HTTP;
  const previousPrivate = process.env.FIGMOON_VISION_ALLOW_PRIVATE_NETWORK;
  process.env.FIGMOON_VISION_ALLOW_INSECURE_HTTP = '1';
  process.env.FIGMOON_VISION_ALLOW_PRIVATE_NETWORK = '1';
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        schemaVersion: '1.0',
        source: {
          digest: 'wrong',
          mediaType: 'image/svg+xml',
          width: 320,
          height: 180,
          path: image,
        },
        canvas: { width: 320, height: 180, background: '#fff' },
        elements: [],
        tokens: [],
        componentCandidates: [],
        responsiveStates: [],
        interactionStates: [],
        unresolvedQuestions: [],
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.FIGMOON_VISION_ALLOW_PRIVATE_NETWORK = '1';
    await assert.rejects(
      () => analyzeDesignImage(image, { endpoint: `http://127.0.0.1:${address.port}` }),
      /does not match/
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    if (previous === undefined) delete process.env.FIGMOON_VISION_ALLOW_INSECURE_HTTP;
    else process.env.FIGMOON_VISION_ALLOW_INSECURE_HTTP = previous;
    if (previousPrivate === undefined) delete process.env.FIGMOON_VISION_ALLOW_PRIVATE_NETWORK;
    else process.env.FIGMOON_VISION_ALLOW_PRIVATE_NETWORK = previousPrivate;
    await rm(directory, { recursive: true, force: true });
  }
});

test('provider analysis refuses plaintext endpoints by default', async () => {
  const { directory, image } = await fixture();
  try {
    await assert.rejects(
      () => analyzeDesignImage(image, { endpoint: 'http://127.0.0.1:9' }),
      /requires HTTPS/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('verification remains reviewable but makes no parity claim without a target', async () => {
  const { directory, image } = await fixture();
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), 'figmoon-artifacts-'));
  const previous = process.env.FIGMOON_ARTIFACT_DIR;
  process.env.FIGMOON_ARTIFACT_DIR = artifactDirectory;
  try {
    const result = await verifyDesignPlan(image);
    const report = result.data as {
      parityClaim: string;
      pixel: { measured: boolean };
      edge: { measured: boolean };
    };
    assert.equal(report.parityClaim, 'none');
    assert.equal(report.pixel.measured, false);
    assert.equal(report.edge.measured, false);
    assert.equal(result.stage, 'verify_design_plan');
  } finally {
    if (previous === undefined) delete process.env.FIGMOON_ARTIFACT_DIR;
    else process.env.FIGMOON_ARTIFACT_DIR = previous;
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(artifactDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('IR validation rejects duplicate IDs and invalid confidence', () => {
  const base = {
    schemaVersion: '1.0' as const,
    source: { digest: 'a', mediaType: 'image/png', width: 10, height: 10, path: 'x' },
    canvas: { width: 10, height: 10, background: '#fff' },
    elements: [
      {
        id: 'a',
        kind: 'shape' as const,
        role: 'card',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        evidence: { kind: 'observed' as const, confidence: 1 },
      },
      {
        id: 'a',
        kind: 'shape' as const,
        role: 'card',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        evidence: { kind: 'observed' as const, confidence: 1 },
      },
    ],
    tokens: [],
    componentCandidates: [],
    responsiveStates: [],
    interactionStates: [],
    unresolvedQuestions: [],
  } satisfies DesignIR;
  assert.throws(() => validateDesignIR(base), /Duplicate/);
  const invalid = {
    ...base,
    elements: [
      { ...base.elements[0], id: 'b', evidence: { kind: 'observed' as const, confidence: 2 } },
    ],
  };
  assert.throws(() => validateDesignIR(invalid), /confidence/);
});

const parityIR = (): DesignIR => ({
  schemaVersion: '1.0',
  source: { digest: 'parity', mediaType: 'image/png', width: 100, height: 100, path: 'x' },
  canvas: { width: 100, height: 100, background: '#fff' },
  elements: [
    {
      id: 'a',
      kind: 'shape',
      role: 'card',
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      fill: '#0f766e',
      evidence: { kind: 'observed', confidence: 0.9 },
    },
    {
      id: 'b',
      kind: 'text',
      role: 'heading',
      bounds: { x: 0, y: 20, width: 40, height: 12 },
      content: 'Hello',
      evidence: { kind: 'observed', confidence: 0.9 },
    },
  ],
  tokens: [
    { name: 'color.primary', value: '#0f766e', evidence: { kind: 'observed', confidence: 0.9 } },
    { name: 'space.md', value: '16px', evidence: { kind: 'observed', confidence: 0.9 } },
    {
      name: 'canvas.background',
      value: '#FFFFFF',
      evidence: { kind: 'defaulted', confidence: 0.4 },
    },
  ],
  componentCandidates: [],
  responsiveStates: [],
  interactionStates: [],
  unresolvedQuestions: [],
});

test('DTCG export emits 2025.10 objects with evidence provenance and excludes defaulted tokens', () => {
  const tokens = exportDesignTokensDTCG(parityIR()) as {
    color: { primary: { $value: unknown } };
    space: { md: { $value: unknown } };
  };
  assert.deepEqual(tokens.color.primary.$value, {
    colorSpace: 'srgb',
    components: [15 / 255, 118 / 255, 110 / 255],
    alpha: 1,
    hex: '#0f766e',
  });
  assert.deepEqual(tokens.space.md.$value, { value: 16, unit: 'px' });
  const exported = JSON.stringify(tokens);
  assert.ok(!exported.includes('canvas'), 'defaulted tokens must be excluded by default');
  assert.match(exported, /"sourceDigest":"parity"/);
  assert.match(
    JSON.stringify(exportDesignTokensDTCG(parityIR(), true)),
    /canvas/,
    'includeDefaulted opts back in'
  );
});

test('parity scoring weighs mapped/ambiguous/unresolved per aspect without claiming visual parity', () => {
  const ir = parityIR();
  const score = scoreDesignParity(ir, [
    { elementId: 'a', status: 'mapped', candidates: [{ id: 'x', name: 'Card' }] },
    {
      elementId: 'b',
      status: 'ambiguous',
      candidates: [
        { id: 'x', name: 'Heading' },
        { id: 'y', name: 'Title' },
      ],
    },
  ]);
  assert.equal(score.status, 'partial');
  assert.ok(score.score > 0.5 && score.score < 0.8);
  assert.equal(score.aspects.find((aspect) => aspect.name === 'text')?.total, 1);
  assert.equal(score.blocking.length, 1);
  assert.match(score.blocking[0].reason, /plausible repository candidates/);
  const empty = scoreDesignParity(ir, []);
  assert.equal(empty.score, 0, 'no supplied mappings means every leaf counts as unresolved');
  assert.equal(empty.status, 'partial');
});

test('repair rubrics evolve typed targets and selection avoids repeated history', () => {
  const ir = parityIR();
  const rubrics = evolveRepairRubrics(ir, [
    { elementId: 'b', status: 'unresolved', candidates: [] },
  ]);
  const first = selectRepairRubric(rubrics, []);
  assert.ok(first);
  assert.ok(REPAIR_ASPECTS.includes(first.aspect));
  assert.equal(first.elementId, 'b');
  assert.equal(
    selectRepairRubric(rubrics, rubrics),
    undefined,
    'a fully applied history yields no remaining selection'
  );
});

test('structural diff reports added/removed/changed/unchanged by element identity', () => {
  const before = parityIR();
  const after = parityIR();
  after.elements = [
    ...after.elements.map((element) =>
      element.id === 'b' ? { ...element, fill: '#111111' } : element
    ),
    {
      id: 'c',
      kind: 'shape',
      role: 'rect',
      bounds: { x: 50, y: 50, width: 10, height: 10 },
      evidence: { kind: 'observed', confidence: 0.9 },
    },
  ];
  const diff = diffDesignStructures(before, after);
  assert.deepEqual(diff.added, ['c']);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(
    diff.changed.map((entry) => ({ id: entry.id, fields: entry.fields })),
    [{ id: 'b', fields: ['fill'] }]
  );
  assert.equal(diff.unchangedCount, 1);
  assert.equal(diffDesignStructures(before, before).changed.length, 0);
});
