import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_ELEMENTS = 200;
const MAX_TEXT = 10_000;

export type EvidenceKind = 'observed' | 'inferred' | 'mapped' | 'defaulted' | 'unresolved';

export interface DesignEvidence {
  kind: EvidenceKind;
  confidence: number;
  note?: string;
}

export interface DesignBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignElement {
  id: string;
  kind: 'region' | 'text' | 'shape' | 'image';
  role: string;
  bounds: DesignBounds;
  content?: string;
  fill?: string;
  evidence: DesignEvidence;
  children?: DesignElement[];
}

export interface DesignIR {
  schemaVersion: '1.0';
  source: {
    digest: string;
    mediaType: string;
    width: number;
    height: number;
    path: string;
  };
  canvas: { width: number; height: number; background: string };
  elements: DesignElement[];
  tokens: Array<{ name: string; value: string; evidence: DesignEvidence }>;
  componentCandidates: Array<{
    id: string;
    role: string;
    candidates: string[];
    evidence: DesignEvidence;
  }>;
  responsiveStates: Array<{
    name: string;
    status: 'observed' | 'not-observed' | 'unresolved';
    evidence: DesignEvidence;
  }>;
  interactionStates: Array<{
    name: string;
    status: 'observed' | 'not-observed' | 'unresolved';
    evidence: DesignEvidence;
  }>;
  unresolvedQuestions: string[];
}

export interface PipelineArtifact {
  runId: string;
  stage: string;
  artifactPath: string;
  digest: string;
}

export interface PipelineResult {
  runId: string;
  stage: string;
  status: 'completed';
  sourceDigest: string;
  artifacts: PipelineArtifact[];
  data?: unknown;
  warnings: string[];
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function artifactRoot(): string {
  return process.env.FIGMOON_ARTIFACT_DIR
    ? path.resolve(process.env.FIGMOON_ARTIFACT_DIR)
    : path.resolve(process.cwd(), '.figmoon', 'design-runs');
}

async function persist(
  runId: string,
  stage: string,
  value: unknown,
  extension = 'json'
): Promise<PipelineArtifact> {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  const fileDigest = digest(body);
  const directory = path.join(artifactRoot(), runId);
  await mkdir(directory, { recursive: true });
  const artifactPath = path.join(directory, `${stage}-${fileDigest.slice(0, 12)}.${extension}`);
  await writeFile(artifactPath, body, { flag: 'wx' }).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  return { runId, stage, artifactPath, digest: fileDigest };
}

function imageInfo(
  bytes: Buffer,
  sourcePath: string
): { mediaType: string; width: number; height: number } {
  const text = bytes.toString('utf8', 0, Math.min(bytes.length, 4096));
  if (text.includes('<svg')) {
    const viewBox = text.match(/viewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i);
    const width = text.match(/\bwidth=["']([\d.]+)/i);
    const height = text.match(/\bheight=["']([\d.]+)/i);
    const parsedWidth = Number(width?.[1] ?? viewBox?.[1]);
    const parsedHeight = Number(height?.[1] ?? viewBox?.[2]);
    if (
      Number.isFinite(parsedWidth) &&
      Number.isFinite(parsedHeight) &&
      parsedWidth > 0 &&
      parsedHeight > 0
    ) {
      return {
        mediaType: 'image/svg+xml',
        width: Math.round(parsedWidth),
        height: Math.round(parsedHeight),
      };
    }
  }
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return {
      mediaType: 'image/png',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }
  if (
    (bytes.length >= 10 && bytes.toString('ascii', 0, 6) === 'GIF89a') ||
    bytes.toString('ascii', 0, 6) === 'GIF87a'
  ) {
    return { mediaType: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 24 && bytes.toString('ascii', 0, 2) === '\xff\xd8') {
    for (let offset = 2; offset + 9 < bytes.length; ) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          mediaType: 'image/jpeg',
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  const extension = path.extname(sourcePath).toLowerCase();
  const mediaType =
    extension === '.webp'
      ? 'image/webp'
      : extension === '.svg'
        ? 'image/svg+xml'
        : 'application/octet-stream';
  throw new Error(
    `Unsupported or undetectable image format (${mediaType}); use PNG, JPEG, GIF, or a supported raster file.`
  );
}

function assertBounds(bounds: DesignBounds): void {
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new Error('Design element bounds must be finite and have positive dimensions.');
  }
}

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}=["']([^"']*)`, 'i'))?.[1];
}

function numberAttribute(tag: string, name: string, fallback = 0): number {
  const value = Number(attribute(tag, name));
  return Number.isFinite(value) ? value : fallback;
}

function colorAttribute(tag: string): string | undefined {
  const value = attribute(tag, 'fill');
  return value && value !== 'none' ? value : undefined;
}

function svgElements(bytes: Buffer): DesignElement[] {
  const source = bytes.toString('utf8');
  const elements: DesignElement[] = [];
  let index = 0;
  const add = (element: DesignElement) => {
    if (elements.length < MAX_ELEMENTS) elements.push(element);
  };
  for (const match of source.matchAll(
    /<(rect|circle|ellipse|line|text)\b[^>]*>([\s\S]*?)<\/\1>|<(rect|circle|ellipse|line)\b[^>]*\/?>/gi
  )) {
    const tag = match[0];
    const kind = (match[1] ?? match[3]).toLowerCase();
    const content = match[2]?.replace(/<[^>]+>/g, '').trim();
    const x = numberAttribute(tag, 'x');
    const y = numberAttribute(tag, 'y');
    const width = numberAttribute(
      tag,
      'width',
      kind === 'circle' || kind === 'ellipse' ? numberAttribute(tag, 'rx', 1) * 2 : 1
    );
    const height = numberAttribute(
      tag,
      'height',
      kind === 'circle' || kind === 'ellipse'
        ? numberAttribute(tag, 'ry', numberAttribute(tag, 'rx', 1)) * 2
        : 1
    );
    const bounds = { x, y, width, height };
    if (kind === 'circle') {
      bounds.x = x - numberAttribute(tag, 'r', 1);
      bounds.y = y - numberAttribute(tag, 'r', 1);
      bounds.width = numberAttribute(tag, 'r', 1) * 2;
      bounds.height = bounds.width;
    }
    if (kind === 'ellipse') {
      bounds.x = x - numberAttribute(tag, 'rx', 1);
      bounds.y = y - numberAttribute(tag, 'ry', 1);
    }
    if (kind === 'line') {
      bounds.width = Math.abs(numberAttribute(tag, 'x2') - x) || 1;
      bounds.height = Math.abs(numberAttribute(tag, 'y2') - y) || 1;
    }
    add({
      id: `svg-${index++}`,
      kind: kind === 'text' ? 'text' : kind === 'line' ? 'shape' : 'shape',
      role: kind,
      bounds,
      content: content || undefined,
      fill: colorAttribute(tag),
      evidence: { kind: 'observed', confidence: 0.98, note: 'Parsed from SVG source attributes' },
    });
  }
  return elements;
}

export function validateDesignIR(ir: DesignIR): DesignIR {
  if (ir.schemaVersion !== '1.0') throw new Error('Unsupported DesignIR schema version.');
  if (
    !Number.isInteger(ir.canvas.width) ||
    !Number.isInteger(ir.canvas.height) ||
    ir.canvas.width <= 0 ||
    ir.canvas.height <= 0
  ) {
    throw new Error('DesignIR canvas dimensions must be positive integers.');
  }
  if (ir.elements.length > MAX_ELEMENTS)
    throw new Error(`DesignIR contains more than ${MAX_ELEMENTS} elements.`);
  const ids = new Set<string>();
  const visit = (element: DesignElement, depth: number): void => {
    if (depth > 8) throw new Error('DesignIR nesting exceeds the maximum depth.');
    if (ids.has(element.id)) throw new Error(`Duplicate DesignIR element ID: ${element.id}`);
    ids.add(element.id);
    assertBounds(element.bounds);
    if (element.content && element.content.length > MAX_TEXT)
      throw new Error('DesignIR text content is too long.');
    if (element.evidence.confidence < 0 || element.evidence.confidence > 1)
      throw new Error('DesignIR confidence must be between 0 and 1.');
    element.children?.forEach((child) => visit(child, depth + 1));
  };
  ir.elements.forEach((element) => visit(element, 0));
  return ir;
}

export async function ingestDesignImage(source: string): Promise<PipelineResult> {
  const sourcePath = path.resolve(source);
  const file = await stat(sourcePath);
  if (!file.isFile()) throw new Error('Image source must be a file.');
  if (file.size > MAX_IMAGE_BYTES)
    throw new Error(`Image exceeds the ${MAX_IMAGE_BYTES} byte limit.`);
  const bytes = await readFile(sourcePath);
  const info = imageInfo(bytes, sourcePath);
  const sourceDigest = digest(bytes);
  const runId = `image-${sourceDigest.slice(0, 16)}`;
  const data = { source: sourcePath, sourceDigest, bytes: bytes.length, ...info };
  const artifact = await persist(runId, 'ingest', data);
  return {
    runId,
    stage: 'image_ingest',
    status: 'completed',
    sourceDigest,
    artifacts: [artifact],
    data,
    warnings: [],
  };
}

export interface VisionProviderOptions {
  endpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return (
    address === '::1' ||
    address.startsWith('fc') ||
    address.startsWith('fd') ||
    address.startsWith('fe80:')
  );
}

async function assertSafeProviderEndpoint(url: URL): Promise<void> {
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      'Vision provider endpoint must not include credentials, query parameters, or fragments.'
    );
  if (url.protocol !== 'https:' && process.env.FIGMOON_VISION_ALLOW_INSECURE_HTTP !== '1')
    throw new Error('Vision provider requires HTTPS unless FIGMOON_VISION_ALLOW_INSECURE_HTTP=1.');
  const addresses = isIP(url.hostname)
    ? [url.hostname]
    : (await lookup(url.hostname, { all: true })).map((entry) => entry.address);
  if (addresses.some(isPrivateAddress) && process.env.FIGMOON_VISION_ALLOW_PRIVATE_NETWORK !== '1')
    throw new Error('Vision provider private-network access is disabled by default.');
}

async function providerAnalysis(
  source: string,
  info: { sourceDigest: string; mediaType: string; width: number; height: number },
  options: VisionProviderOptions
): Promise<DesignIR | undefined> {
  const endpoint = options.endpoint ?? process.env.FIGMOON_VISION_ENDPOINT;
  const apiKey = options.apiKey ?? process.env.FIGMOON_VISION_API_KEY;
  if (!endpoint) return undefined;
  const url = new URL(endpoint);
  await assertSafeProviderEndpoint(url);
  const bytes = await readFile(path.resolve(source));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': info.mediaType,
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: bytes,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Vision provider returned HTTP ${response.status}.`);
    const candidate = (await response.json()) as DesignIR;
    const validated = validateDesignIR(candidate);
    if (
      validated.source.digest !== info.sourceDigest ||
      validated.source.width !== info.width ||
      validated.source.height !== info.height
    ) {
      throw new Error(
        'Vision provider DesignIR does not match the ingested image identity or dimensions.'
      );
    }
    return validated;
  } finally {
    clearTimeout(timeout);
  }
}

export async function analyzeDesignImage(
  source: string,
  options: VisionProviderOptions = {}
): Promise<PipelineResult> {
  const ingested = await ingestDesignImage(source);
  const info = ingested.data as {
    source: string;
    sourceDigest: string;
    mediaType: string;
    width: number;
    height: number;
  };
  const provided = await providerAnalysis(source, info, options);
  if (provided) {
    const artifact = await persist(ingested.runId, 'design-ir', provided);
    return {
      runId: ingested.runId,
      stage: 'image_analyze',
      status: 'completed',
      sourceDigest: ingested.sourceDigest,
      artifacts: [...ingested.artifacts, artifact],
      data: provided,
      warnings: provided.unresolvedQuestions,
    };
  }
  const bytes = await readFile(info.source);
  const parsedElements = info.mediaType === 'image/svg+xml' ? svgElements(bytes) : [];
  const semanticElements =
    parsedElements.length > 0
      ? parsedElements
      : [
          {
            id: 'source-image',
            kind: 'image' as const,
            role: 'reference-image',
            bounds: { x: 0, y: 0, width: info.width, height: info.height },
            evidence: {
              kind: 'observed' as const,
              confidence: 1,
              note: 'Source pixels; semantic decomposition requires a vision provider',
            },
          },
        ];
  const ir: DesignIR = {
    schemaVersion: '1.0',
    source: {
      digest: info.sourceDigest,
      mediaType: info.mediaType,
      width: info.width,
      height: info.height,
      path: info.source,
    },
    canvas: { width: info.width, height: info.height, background: '#FFFFFF' },
    elements: [
      {
        id: 'screen',
        kind: 'region',
        role: 'screen',
        bounds: { x: 0, y: 0, width: info.width, height: info.height },
        evidence: { kind: 'observed', confidence: 1, note: 'Image canvas bounds' },
        children: semanticElements,
      },
    ],
    tokens: [
      {
        name: 'canvas.background',
        value: '#FFFFFF',
        evidence: {
          kind: 'defaulted',
          confidence: 0.4,
          note: 'Replace with observed background after vision analysis',
        },
      },
    ],
    componentCandidates: [],
    responsiveStates: [
      {
        name: 'source-viewport',
        status: 'observed',
        evidence: { kind: 'observed', confidence: 1 },
      },
      { name: 'mobile', status: 'not-observed', evidence: { kind: 'unresolved', confidence: 0 } },
      { name: 'desktop', status: 'not-observed', evidence: { kind: 'unresolved', confidence: 0 } },
    ],
    interactionStates: [
      { name: 'default', status: 'observed', evidence: { kind: 'observed', confidence: 0.7 } },
      {
        name: 'hover/focus/pressed',
        status: 'not-observed',
        evidence: { kind: 'unresolved', confidence: 0 },
      },
    ],
    unresolvedQuestions: [
      'No vision provider was used: text, components, tokens, and layout semantics remain unresolved.',
    ],
  };
  validateDesignIR(ir);
  const artifact = await persist(ingested.runId, 'design-ir', ir);
  return {
    runId: ingested.runId,
    stage: 'image_analyze',
    status: 'completed',
    sourceDigest: ingested.sourceDigest,
    artifacts: [...ingested.artifacts, artifact],
    data: ir,
    warnings: ir.unresolvedQuestions,
  };
}

export interface MappingCandidate {
  id: string;
  name: string;
  role?: string;
  sourcePath?: string;
  tokens?: string[];
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte']);
const TOKEN_EXTENSIONS = new Set(['.json', '.css', '.scss', '.ts', '.tsx']);
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

export async function indexRepository(
  root: string,
  maxFiles = 200
): Promise<{
  candidates: MappingCandidate[];
  root: string;
  filesScanned: number;
  truncated: boolean;
}> {
  const rootPath = path.resolve(root);
  const candidates: MappingCandidate[] = [];
  let filesScanned = 0;
  let truncated = false;
  const visit = async (directory: string): Promise<void> => {
    if (truncated) return;
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(path.join(directory, entry.name));
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(extension) && !TOKEN_EXTENSIONS.has(extension)) continue;
      filesScanned += 1;
      if (filesScanned > maxFiles) {
        truncated = true;
        return;
      }
      const filePath = path.join(directory, entry.name);
      const text = await readFile(filePath, 'utf8');
      const relativePath = path.relative(rootPath, filePath);
      for (const match of text.matchAll(
        /(?:export\s+(?:default\s+)?function|export\s+(?:const|class)|function|class)\s+([A-Z][A-Za-z0-9_]*)/g
      )) {
        candidates.push({
          id: `${relativePath}#${match[1]}`,
          name: match[1],
          sourcePath: relativePath,
        });
      }
      for (const match of text.matchAll(/(?:--|['"])([a-z][a-z0-9_-]{2,})(?:['"]|:)/gi)) {
        const name = match[1];
        if (name.startsWith('--') || /color|spacing|radius|font|primary|surface|text/.test(name))
          candidates.push({
            id: `${relativePath}#${name}`,
            name,
            role: 'token',
            sourcePath: relativePath,
          });
      }
    }
  };
  await visit(rootPath);
  const unique = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
  return {
    candidates: unique,
    root: rootPath,
    filesScanned: Math.min(filesScanned, maxFiles),
    truncated,
  };
}

export function mapDesignToCode(
  ir: DesignIR,
  candidates: MappingCandidate[]
): {
  elementId: string;
  status: 'mapped' | 'ambiguous' | 'unresolved';
  candidates: MappingCandidate[];
}[] {
  validateDesignIR(ir);
  const leaves = (elements: DesignElement[]): DesignElement[] =>
    elements.flatMap((element) =>
      element.children?.length ? leaves(element.children) : [element]
    );
  return leaves(ir.elements).map((element) => {
    const exact = candidates.filter(
      (candidate) => candidate.role?.toLowerCase() === element.role.toLowerCase()
    );
    const name = candidates.filter(
      (candidate) =>
        candidate.name.toLowerCase().includes(element.role.toLowerCase()) ||
        element.role.toLowerCase().includes(candidate.name.toLowerCase())
    );
    const matches = exact.length > 0 ? exact : name;
    return {
      elementId: element.id,
      status: matches.length === 1 ? 'mapped' : matches.length > 1 ? 'ambiguous' : 'unresolved',
      candidates: matches.slice(0, 10),
    };
  });
}

export async function generateDesignPlan(
  source: string,
  repositoryRoot?: string
): Promise<PipelineResult> {
  const analysis = await analyzeDesignImage(source);
  const repository = repositoryRoot ? await indexRepository(repositoryRoot) : undefined;
  const ir = analysis.data as DesignIR;
  const flatten = (elements: DesignElement[]): DesignElement[] =>
    elements.flatMap((element) => [
      element,
      ...(element.children ? flatten(element.children) : []),
    ]);
  const mappings = repository ? mapDesignToCode(ir, repository.candidates) : [];
  const plan = {
    schemaVersion: '1.0',
    sourceDigest: analysis.sourceDigest,
    target: { width: ir.canvas.width, height: ir.canvas.height },
    elements: ir.elements,
    operations: [
      {
        type: 'create_frame',
        id: 'screen',
        role: 'screen',
        bounds: { x: 0, y: 0, width: ir.canvas.width, height: ir.canvas.height },
        fill: ir.canvas.background,
      },
      ...flatten(ir.elements)
        .filter((element) => element.id !== 'screen')
        .map((element) => ({
          type: element.kind === 'text' ? 'create_text' : 'create_shape',
          id: element.id,
          role: element.role,
          bounds: element.bounds,
          content: element.content,
          fill: element.fill,
        })),
    ],
    mappings,
    repository: repository
      ? {
          root: repository.root,
          filesScanned: repository.filesScanned,
          truncated: repository.truncated,
        }
      : undefined,
    unresolvedQuestions: ir.unresolvedQuestions,
    writeBack: {
      allowed: false,
      reason: 'Proposal only; explicit target authorization is required.',
    },
  };
  const artifact = await persist(analysis.runId, 'design-plan', plan);
  return {
    runId: analysis.runId,
    stage: 'generate_design_plan',
    status: 'completed',
    sourceDigest: analysis.sourceDigest,
    artifacts: [...analysis.artifacts, artifact],
    data: plan,
    warnings: analysis.warnings,
  };
}

export async function verifyDesignPlan(source: string): Promise<PipelineResult> {
  const plan = await generateDesignPlan(source);
  const preview = await previewFromPlan(plan);
  const data = plan.data as { operations: Array<{ id: string }>; unresolvedQuestions: string[] };
  const report = {
    sourceDigest: preview.sourceDigest,
    comparison: 'source-to-reconstruction',
    status: data.unresolvedQuestions.length === 0 ? 'reviewable' : 'incomplete',
    structural: { plannedOperations: data.operations.length, renderedPreview: true },
    pixel: {
      measured: false,
      reason: 'A qualified Figma/browser target is required before raster measurement.',
    },
    edge: {
      measured: false,
      reason: 'A qualified Figma/browser target is required before edge measurement.',
    },
    unresolvedQuestions: data.unresolvedQuestions,
    parityClaim: 'none',
  };
  const artifact = await persist(preview.runId, 'verification', report);
  return {
    ...preview,
    stage: 'verify_design_plan',
    artifacts: [...preview.artifacts, artifact],
    data: report,
  };
}

async function previewFromPlan(planResult: PipelineResult): Promise<PipelineResult> {
  const plan = planResult.data as {
    target: { width: number; height: number };
    sourceDigest: string;
    unresolvedQuestions: string[];
    elements: DesignElement[];
  };
  const width = plan.target.width;
  const height = plan.target.height;
  const design = { elements: plan.elements };
  const escape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const render = (element: DesignElement): string => {
    const { x, y, width: w, height: h } = element.bounds;
    const fill = element.fill ?? (element.kind === 'text' ? 'none' : '#e2e8f0');
    if (element.kind === 'text')
      return `<text x="${x}" y="${y + Math.max(14, h)}" font-family="sans-serif" font-size="${Math.max(12, Math.min(32, h))}" fill="${escape(fill)}">${escape(element.content ?? element.role)}</text>`;
    if (element.role === 'circle')
      return `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${Math.min(w, h) / 2}" fill="${escape(fill)}"/>`;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${element.role === 'rect' ? 8 : 0}" fill="${escape(fill)}"/>`;
  };
  const rendered = design.elements
    .flatMap((element) => element.children ?? [])
    .map(render)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/>${rendered}<text x="24" y="${Math.max(24, height - 24)}" font-family="monospace" font-size="12" fill="#64748b">Figmoon · ${plan.sourceDigest.slice(0, 12)}</text></svg>`;
  const metadata = {
    format: 'svg',
    width,
    height,
    sourceDigest: plan.sourceDigest,
    unresolvedQuestions: plan.unresolvedQuestions,
  };
  const artifact = await persist(planResult.runId, 'preview', svg, 'svg');
  const manifest = await persist(planResult.runId, 'preview-manifest', metadata);
  return {
    runId: planResult.runId,
    stage: 'preview_design_plan',
    status: 'completed',
    sourceDigest: planResult.sourceDigest,
    artifacts: [...planResult.artifacts, artifact, manifest],
    data: { ...metadata, svg },
    warnings: planResult.warnings,
  };
}

export async function previewDesignPlan(source: string): Promise<PipelineResult> {
  return previewFromPlan(await generateDesignPlan(source));
}

export const DTCG_FORMAT_VERSION = '2025.10';

function dtcgPath(name: string): string[] {
  const segments = name.split(/[./]/);
  if (
    segments.some(
      (part) =>
        !part ||
        part.startsWith('$') ||
        /[{}]/.test(part) ||
        ['__proto__', 'constructor', 'prototype'].includes(part)
    )
  ) {
    throw new Error('Token names must contain nonempty, nonreserved path segments.');
  }
  return segments;
}

function dtcgValue(value: string): { $type: string; $value: unknown } {
  const hex = value.match(/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    let channels = value.slice(1);
    if (channels.length <= 4) channels = [...channels].map((c) => c + c).join('');
    return {
      $type: 'color',
      $value: {
        colorSpace: 'srgb',
        components: [0, 2, 4].map((i) => parseInt(channels.slice(i, i + 2), 16) / 255),
        alpha: channels.length === 8 ? parseInt(channels.slice(6), 16) / 255 : 1,
        hex: `#${channels.slice(0, 6).toLowerCase()}`,
      },
    };
  }
  const dimension = value.match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|rem)$/);
  if (dimension && Number.isFinite(Number(dimension[1]))) {
    return { $type: 'dimension', $value: { value: Number(dimension[1]), unit: dimension[2] } };
  }
  throw new Error(
    'Only literal hex colors and finite px/rem dimensions are supported for token export.'
  );
}

export function exportDesignTokensDTCG(ir: DesignIR, includeDefaulted = false): unknown {
  validateDesignIR(ir);
  const root: Record<string, unknown> = {};
  const tokens = ir.tokens.filter(
    (token) => includeDefaulted || token.evidence.kind !== 'defaulted'
  );
  for (const token of tokens) {
    let node = root;
    const segments = dtcgPath(token.name);
    for (const segment of segments.slice(0, -1)) {
      if (!Object.hasOwn(node, segment)) node[segment] = {};
      node = node[segment] as Record<string, unknown>;
      if (Object.hasOwn(node, '$value'))
        throw new Error('Token path conflicts with an existing token.');
    }
    const leaf = segments[segments.length - 1];
    if (Object.hasOwn(node, leaf)) throw new Error('Duplicate or conflicting token path.');
    node[leaf] = {
      ...dtcgValue(token.value),
      $extensions: { figmoon: { sourceDigest: ir.source.digest, evidence: { ...token.evidence } } },
    };
  }
  return root;
}

function completeMappings(ir: DesignIR, mappings: ReturnType<typeof mapDesignToCode>) {
  const leaves = [...flattenIds(ir.elements).values()].filter(
    (element) => !element.children?.length
  );
  const ids = new Set(leaves.map((element) => element.id));
  const supplied = new Map<string, (typeof mappings)[number]>();
  for (const mapping of mappings) {
    if (!ids.has(mapping.elementId) || supplied.has(mapping.elementId)) {
      throw new Error('Mappings must refer to unique leaf element IDs in the supplied design.');
    }
    if (
      !['mapped', 'ambiguous', 'unresolved'].includes(mapping.status) ||
      (mapping.status === 'mapped' && mapping.candidates.length !== 1) ||
      (mapping.status === 'ambiguous' && mapping.candidates.length < 2) ||
      (mapping.status === 'unresolved' && mapping.candidates.length !== 0)
    ) {
      throw new Error('Mapping status and candidate count must agree.');
    }
    if (
      new Set(mapping.candidates.map((candidate) => candidate.id)).size !==
      mapping.candidates.length
    ) {
      throw new Error('Mapping candidate IDs must be unique.');
    }
    supplied.set(mapping.elementId, mapping);
  }
  return leaves.map(
    (element) =>
      supplied.get(element.id) ?? {
        elementId: element.id,
        status: 'unresolved' as const,
        candidates: [],
      }
  );
}

const PARITY_WEIGHTS: Record<'mapped' | 'ambiguous' | 'unresolved', number> = {
  mapped: 1,
  ambiguous: 0.35,
  unresolved: 0,
};

export interface ParityAspect {
  name: string;
  resolved: number;
  total: number;
  score: number;
}

export interface ParityScore {
  score: number;
  metric: 'mapping-coverage';
  parityClaim: 'none';
  status: 'ready' | 'partial' | 'blocked';
  aspects: ParityAspect[];
  blocking: { elementId: string; reason: string }[];
  unresolvedQuestions: string[];
}

export function scoreDesignParity(
  ir: DesignIR,
  mappings: ReturnType<typeof mapDesignToCode>
): ParityScore {
  validateDesignIR(ir);
  mappings = completeMappings(ir, mappings);
  const byKind = new Map<string, { resolved: number; total: number }>();
  for (const mapping of mappings) {
    const element = findElement(ir, mapping.elementId);
    const key = element?.kind ?? 'unknown';
    const bucket = byKind.get(key) ?? { resolved: 0, total: 0 };
    bucket.total += 1;
    bucket.resolved += PARITY_WEIGHTS[mapping.status] ?? 0;
    byKind.set(key, bucket);
  }
  const aspects: ParityAspect[] = [...byKind.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bucket]) => ({
      name,
      ...bucket,
      score: bucket.total > 0 ? Number((bucket.resolved / bucket.total).toFixed(4)) : 0,
    }));
  const total = mappings.length;
  const resolved = mappings.reduce((sum, m) => sum + (PARITY_WEIGHTS[m.status] ?? 0), 0);
  const score = total > 0 ? Number((resolved / total).toFixed(4)) : 0;
  const blocking = mappings
    .filter((m) => m.status !== 'mapped')
    .slice(0, 50)
    .map((m) => ({
      elementId: m.elementId,
      reason:
        m.status === 'ambiguous'
          ? `${m.candidates.length} equally plausible repository candidates`
          : 'no repository candidate matched',
    }));
  const allDefaulted =
    ir.tokens.length > 0 && ir.tokens.every((token) => token.evidence.kind === 'defaulted');
  const status =
    score >= 0.9 && !allDefaulted ? 'ready' : total === 0 || allDefaulted ? 'blocked' : 'partial';
  return {
    score,
    metric: 'mapping-coverage',
    parityClaim: 'none',
    status,
    aspects,
    blocking,
    unresolvedQuestions: [...ir.unresolvedQuestions],
  };
}

function findElement(ir: DesignIR, id: string): DesignElement | undefined {
  const visit = (elements: DesignElement[]): DesignElement | undefined => {
    for (const element of elements) {
      if (element.id === id) return element;
      const nested = element.children ? visit(element.children) : undefined;
      if (nested) return nested;
    }
    return undefined;
  };
  return visit(ir.elements);
}

// --- Guided repair rubrics (Evolve → Select → History) -------------------

export const REPAIR_ASPECTS = [
  'layout_geometry',
  'spacing_density',
  'typography_text',
  'styling_visual',
  'completeness',
] as const;

export type RepairAspect = (typeof REPAIR_ASPECTS)[number];

export interface RepairRubric {
  title: string;
  aspect: RepairAspect;
  description: string;
  elementId?: string;
}

function classifyElement(element: DesignElement): RepairAspect {
  if (element.kind === 'text') return 'typography_text';
  if (element.role === 'rect' || element.role === 'circle') return 'styling_visual';
  if (element.kind === 'region') return 'layout_geometry';
  return 'completeness';
}

export function evolveRepairRubrics(
  ir: DesignIR,
  mapping?: ReturnType<typeof mapDesignToCode>
): RepairRubric[] {
  validateDesignIR(ir);
  const ambiguousIds = new Set(
    (mapping ?? []).filter((m) => m.status !== 'mapped').map((m) => m.elementId)
  );
  const rubrics: RepairRubric[] = [];
  const visit = (element: DesignElement): void => {
    if (element.evidence.kind === 'unresolved') {
      rubrics.push({
        title: `Resolve unresolved ${element.kind} element`,
        aspect: 'completeness',
        description: `Element ${element.id} (${element.role}) has no resolved evidence; a vision pass or repository candidate is required before it can be trusted.`,
        elementId: element.id,
      });
    } else if (ambiguousIds.has(element.id)) {
      rubrics.push({
        title: `Disambiguate ${element.role} mapping`,
        aspect: classifyElement(element),
        description: `Element ${element.id} maps to multiple repository candidates; pick one explicitly or rename one of the candidates.`,
        elementId: element.id,
      });
    }
    element.children?.forEach(visit);
  };
  ir.elements.forEach(visit);
  for (const question of ir.unresolvedQuestions.slice(0, 20)) {
    rubrics.push({
      title: 'Resolve pipeline-level open question',
      aspect: 'completeness',
      description: question,
    });
  }
  return rubrics.slice(0, MAX_ELEMENTS);
}

export function selectRepairRubric(
  rubrics: RepairRubric[],
  history: RepairRubric[]
): RepairRubric | undefined {
  const avoided = new Set(history.map((rubric) => rubric.title + '|' + (rubric.elementId ?? '')));
  return (
    rubrics.find((rubric) => !avoided.has(rubric.title + '|' + (rubric.elementId ?? ''))) ??
    undefined
  );
}

// --- Structural diff ------------------------------------------------------

export interface StructuralDiff {
  added: string[];
  removed: string[];
  changed: Array<{ id: string; fields: string[]; before: unknown; after: unknown }>;
  unchangedCount: number;
}

function flattenIds(elements: DesignElement[]): Map<string, DesignElement> {
  const map = new Map<string, DesignElement>();
  const visit = (element: DesignElement): void => {
    map.set(element.id, element);
    element.children?.forEach(visit);
  };
  elements.forEach(visit);
  return map;
}

export function diffDesignStructures(before: DesignIR, after: DesignIR): StructuralDiff {
  validateDesignIR(before);
  validateDesignIR(after);
  const beforeMap = flattenIds(before.elements);
  const afterMap = flattenIds(after.elements);
  const added = [...afterMap.keys()].filter((id) => !beforeMap.has(id));
  const removed = [...beforeMap.keys()].filter((id) => !afterMap.has(id));
  const changed: StructuralDiff['changed'] = [];
  let unchangedCount = 0;
  for (const [id, element] of afterMap) {
    const prior = beforeMap.get(id);
    if (!prior) continue;
    const fields: string[] = [];
    const entries: Array<[string, unknown, unknown]> = [
      ['bounds', prior.bounds, element.bounds],
      ['content', prior.content, element.content],
      ['fill', prior.fill, element.fill],
      ['role', prior.role, element.role],
    ];
    for (const [field, previous, next] of entries) {
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        fields.push(field);
        changed.push({ id, fields, before: previous, after: next });
      }
    }
    if (fields.length === 0) unchangedCount += 1;
  }
  return { added, removed, changed, unchangedCount };
}
