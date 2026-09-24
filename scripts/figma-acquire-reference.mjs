#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import {
  FIGMA_ACQUISITION_OPERATION,
  FIGMA_ACQUISITION_PLUGIN,
  FIGMA_ACQUISITION_PROTOCOL,
  startFigmaReadonlyBridge,
} from './lib/figma-readonly-bridge.mjs';
import {
  MANIFEST_PATH,
  READ_ONLY_FIGMA_OPERATIONS,
  REFERENCE_RUNS_ROOT,
  REGISTRY_PATH,
  REPO_ROOT,
  findManifestEntry,
  findRegistryItem,
  digestNamedFiles,
  readJson,
  resolveManifestArtifact,
  sha256,
  stableJson,
  validateRunId,
} from './lib/figma-reference-run.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const NODE_ID_RE = /^(?:I)?\d+:\d+(?:;\d+:\d+)*$/;
const ABSOLUTE_MAX_REFERENCE_PIXELS = 20_000_000;
const MAX_REFERENCE_DIMENSION = 8_192;
const MAX_BASE64_CHARACTERS = 28 * 1024 * 1024;

function valuesFor(flag) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flag) {
      const value = args[index + 1];
      if (value && !value.startsWith('--')) values.push(value);
    } else if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
    }
  }
  return values;
}

function optionalValue(flag) {
  const values = valuesFor(flag);
  if (values.length > 1) throw new Error(`${flag} may be provided only once.`);
  return values[0] ?? null;
}

function requiredValue(flag) {
  const value = optionalValue(flag);
  if (!value) throw new Error(`figma:acquire requires ${flag}.`);
  return value;
}

function numericValue(flag, fallback, { minimum, maximum }) {
  const raw = optionalValue(flag);
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${flag} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

const id = requiredValue('--id');
const requestedNodeId = optionalValue('--node-id');
const requestedFileKey = optionalValue('--file-key');
const requestedFileName = optionalValue('--file-name');
const sourceRemapCandidate = args.includes('--source-remap-candidate');
const nodeNameChangeCandidate = args.includes('--node-name-change-candidate');
const port = numericValue('--port', Number(process.env.FIGMOON_REFERENCES_PORT ?? 29195), {
  minimum: 0,
  maximum: 65_535,
});
const timeoutMs = numericValue('--timeout-ms', 120_000, { minimum: 1_000, maximum: 600_000 });
const requestedRunId = optionalValue('--run-id');

const valueFlags = new Set([
  '--id',
  '--node-id',
  '--file-key',
  '--file-name',
  '--port',
  '--timeout-ms',
  '--run-id',
]);
const booleanFlags = new Set(['--source-remap-candidate', '--node-name-change-candidate']);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if ([...valueFlags].some((flag) => arg.startsWith(`${flag}=`))) continue;
  if (booleanFlags.has(arg)) continue;
  if (!valueFlags.has(arg)) throw new Error(`Unsupported figma:acquire argument: ${arg}`);
  index += 1;
}
if (args.filter((arg) => arg === '--source-remap-candidate').length > 1) {
  throw new Error('--source-remap-candidate may be provided only once.');
}

if (requestedNodeId && !NODE_ID_RE.test(requestedNodeId)) {
  throw new Error('--node-id must be a Figma colon-format node id.');
}
if (requestedFileKey && !/^[A-Za-z0-9_-]{1,256}$/.test(requestedFileKey)) {
  throw new Error('--file-key must be an exact Figma file key.');
}
if (
  requestedFileName &&
  (requestedFileName.length > 512 ||
    !requestedFileName.trim() ||
    /[\u0000-\u001f\u007f]/.test(requestedFileName))
) {
  throw new Error('--file-name must be an exact non-empty Figma file name.');
}

const registry = readJson(REGISTRY_PATH);
const manifest = readJson(MANIFEST_PATH);
const item = findRegistryItem(registry, id);
const { key: manifestKey, entry } = findManifestEntry(manifest, id);
if (!entry.referencePath || !entry.figma?.pageId || !entry.figma?.pageName) {
  throw new Error(`${id} does not have a manifest-backed Figma page/reference contract.`);
}
const nodeId = requestedNodeId ?? entry.figma?.nodeId;
if (!nodeId) throw new Error(`${id} has no mapped node; provide --node-id for a remap candidate.`);

const expectedFileKey = manifest.figmaFile?.key ?? null;
const expectedFileName = manifest.figmaFile?.name ?? null;
const requestedSourceDiffers = Boolean(
  (expectedFileKey && requestedFileKey && requestedFileKey !== expectedFileKey) ||
  (expectedFileName && requestedFileName && requestedFileName !== expectedFileName)
);
if (requestedSourceDiffers && !sourceRemapCandidate) {
  throw new Error(
    `Requested Figma source contradicts '${manifest.figmaFile.name}'; use --source-remap-candidate only for an intentional reviewed source change.`
  );
}
if (sourceRemapCandidate && (!requestedFileKey || !requestedFileName)) {
  throw new Error('--source-remap-candidate requires explicit --file-key and --file-name values.');
}
if (sourceRemapCandidate && !requestedSourceDiffers) {
  throw new Error('--source-remap-candidate was provided, but the requested source is unchanged.');
}
const fileKey = requestedFileKey ?? expectedFileKey;
const fileName = requestedFileName ?? expectedFileName;
if (!fileKey) {
  throw new Error(
    'The manifest has no durable Figma file key. Re-import the current local plugin manifest, read the displayed key, and rerun with --file-key <key>.'
  );
}
if (!fileName) throw new Error('Acquisition requires an exact Figma file name.');
const fileBindingCandidate = !expectedFileKey;

const runId = validateRunId(
  requestedRunId ??
    `reference-${id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
);
const runRoot = join(REFERENCE_RUNS_ROOT, runId);
if (existsSync(runRoot)) throw new Error(`Reference run already exists: ${runId}`);
mkdirSync(REFERENCE_RUNS_ROOT, { recursive: true });
const temporaryRoot = join(
  REFERENCE_RUNS_ROOT,
  `.tmp-${runId}-${process.pid}-${randomBytes(4).toString('hex')}`
);

function relativeToRepo(path) {
  return relative(REPO_ROOT, path);
}

function finiteBounds(bounds) {
  return (
    bounds &&
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function assertPluginPayload(acquisition) {
  if (!acquisition || typeof acquisition !== 'object' || Array.isArray(acquisition)) {
    throw new Error('Figma acquisition response is malformed.');
  }
  const { before, after, export: exported, ancestry, changeTracking } = acquisition;
  const metadata = before?.metadata;
  const node = before?.node;
  const variables = before?.variables;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Figma metadata response is malformed.');
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error('Figma node response is malformed.');
  }
  if (node.id !== nodeId || !node.name || !node.type || !finiteBounds(node.bounds)) {
    throw new Error(`Figma node '${nodeId}' is missing stable identity or bounds.`);
  }
  if (!variables || typeof variables !== 'object' || !Array.isArray(variables.collections)) {
    throw new Error('Figma variable response is malformed.');
  }
  if (
    exported.nodeId !== nodeId ||
    exported.nodeName !== node.name ||
    exported.format !== 'PNG' ||
    exported.scale !== 1 ||
    typeof exported.clip !== 'boolean' ||
    typeof exported.base64 !== 'string' ||
    !exported.base64
  ) {
    throw new Error('Figma acquisition export does not match the requested PNG node export.');
  }
  if (
    !after ||
    stableJson(before) !== stableJson(after) ||
    ancestry?.before?.id !== metadata.targetPageId ||
    ancestry?.before?.name !== metadata.targetPageName ||
    ancestry?.after?.id !== metadata.targetPageId ||
    ancestry?.after?.name !== metadata.targetPageName ||
    (changeTracking?.supported === true &&
      (changeTracking.beforeReadStart !== changeTracking.beforeReadEnd ||
        changeTracking.beforeReadEnd !== changeTracking.afterReadStart ||
        changeTracking.afterReadStart !== changeTracking.afterReadEnd))
  ) {
    throw new Error('Figma changed while the reference was being acquired.');
  }
  return { metadata, node, variables, exported };
}

function decodeBoundedBase64(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_BASE64_CHARACTERS ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error('Figma export is missing or exceeds the bounded base64 payload contract.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value)
    throw new Error('Figma export base64 payload is not canonical.');
  return bytes;
}

function comparePngs(candidateBytes, canonicalBytes) {
  const candidate = PNG.sync.read(candidateBytes);
  const canonical = PNG.sync.read(canonicalBytes);
  if (candidate.width !== canonical.width || candidate.height !== canonical.height) {
    return {
      dimensionsMatch: false,
      exactMatch: false,
      mismatchedPixels: null,
      totalPixels: null,
      diffPixelRatio: null,
      diffBytes: null,
    };
  }
  const diff = new PNG({ width: candidate.width, height: candidate.height });
  const mismatchedPixels = pixelmatch(
    canonical.data,
    candidate.data,
    diff.data,
    candidate.width,
    candidate.height,
    { threshold: 0.1, includeAA: true }
  );
  const totalPixels = candidate.width * candidate.height;
  return {
    dimensionsMatch: true,
    exactMatch: candidateBytes.equals(canonicalBytes),
    mismatchedPixels,
    totalPixels,
    diffPixelRatio: mismatchedPixels / totalPixels,
    diffBytes: PNG.sync.write(diff),
  };
}

let bridge;
try {
  bridge = await startFigmaReadonlyBridge({ port });
  console.log(`Read-only Figma acquisition broker listening at ${bridge.url}.`);
  console.log(
    `Open Figmoon in '${fileName}', choose References, and paste this one-time nonce: ${bridge.sessionNonce}`
  );
  const connection = await bridge.waitForConnection({
    ...(fileKey ? { fileKey } : {}),
    ...(fileName ? { fileName } : {}),
    timeoutMs,
  });
  const exportSpec = {
    format: 'PNG',
    scale: 1,
    clip: entry.exportSpec?.clip === true,
  };
  const acquisition = await bridge.acquireReference(connection, { nodeId, exportSpec }, timeoutMs);
  const { metadata, node, variables, exported } = assertPluginPayload(acquisition);
  if (exported.clip !== exportSpec.clip) {
    throw new Error('Figma acquisition export clip mode contradicts the request.');
  }
  const referenceBytes = decodeBoundedBase64(exported.base64);
  const imageMetadata = await sharp(referenceBytes).metadata();
  const expectedPixels = entry.exportBounds.width * entry.exportBounds.height;
  const targetRelativeMaxPixels = Math.max(1_000_000, expectedPixels * 4);
  const maxReferencePixels = Math.min(ABSOLUTE_MAX_REFERENCE_PIXELS, targetRelativeMaxPixels);
  if (
    imageMetadata.format !== 'png' ||
    !imageMetadata.width ||
    !imageMetadata.height ||
    imageMetadata.width > MAX_REFERENCE_DIMENSION ||
    imageMetadata.height > MAX_REFERENCE_DIMENSION ||
    imageMetadata.width * imageMetadata.height > maxReferencePixels
  ) {
    throw new Error('Figma export is not a valid bounded PNG reference.');
  }

  const canonicalPath = resolveManifestArtifact(entry);
  const canonicalBytes = readFileSync(canonicalPath);
  const canonicalMetadata = await sharp(canonicalBytes).metadata();
  const comparison = comparePngs(referenceBytes, canonicalBytes);
  const nodeJson = stableJson(node);
  const variablesJson = stableJson(variables);
  const acquiredAt = new Date().toISOString();
  const remapCandidate = nodeId !== entry.figma?.nodeId;
  const nodeNameChanged = node.name !== entry.figma?.nodeName;
  const boundsChanged =
    imageMetadata.width !== entry.exportBounds?.width ||
    imageMetadata.height !== entry.exportBounds?.height;
  const blockingIssues = [];
  const reviewRequired = [];

  if (
    connection.fileName !== metadata.fileName ||
    metadata.fileName !== fileName ||
    connection.fileKey !== metadata.fileKey
  ) {
    blockingIssues.push(
      'Live plugin metadata does not match the selected/manifest Figma file name.'
    );
  }
  if (fileKey && connection.fileKey !== fileKey) {
    blockingIssues.push('Live plugin connection does not match the selected Figma file key.');
  }
  if (
    metadata.currentPageId !== entry.figma.pageId ||
    metadata.currentPageName !== entry.figma.pageName ||
    metadata.targetPageId !== entry.figma.pageId ||
    metadata.targetPageName !== entry.figma.pageName
  ) {
    blockingIssues.push('Open/ancestor Figma page does not match the mapped manifest page.');
  }
  if (!remapCandidate && node.type !== entry.figma.nodeType) {
    blockingIssues.push('Mapped node type changed; acquire it as an explicit remap candidate.');
  }
  if (!remapCandidate && nodeNameChanged && !nodeNameChangeCandidate) {
    blockingIssues.push(
      'Mapped node name changed; reacquire with --node-name-change-candidate for explicit review.'
    );
  }
  if (nodeNameChangeCandidate && (!nodeNameChanged || remapCandidate)) {
    blockingIssues.push(
      '--node-name-change-candidate is valid only when the mapped node ID is unchanged and its name changed.'
    );
  }
  if (sha256(canonicalBytes) !== entry.assetSha256) {
    blockingIssues.push('Canonical reference bytes no longer match the manifest predecessor hash.');
  }
  if (remapCandidate) reviewRequired.push('node-remap');
  if (nodeNameChanged && nodeNameChangeCandidate) reviewRequired.push('node-name-change');
  if (boundsChanged) reviewRequired.push('export-bounds-change');
  if (fileBindingCandidate) reviewRequired.push('file-key-binding');
  if (sourceRemapCandidate) reviewRequired.push('source-file-remap');

  mkdirSync(temporaryRoot);
  const referencePath = join(temporaryRoot, 'reference.png');
  const nodePath = join(temporaryRoot, 'node.json');
  const variablesPath = join(temporaryRoot, 'variables.json');
  const diffPath = join(temporaryRoot, 'candidate-vs-canonical.png');
  writeFileSync(referencePath, referenceBytes);
  writeFileSync(nodePath, nodeJson);
  writeFileSync(variablesPath, variablesJson);
  if (comparison.diffBytes) writeFileSync(diffPath, comparison.diffBytes);

  const finalizedReferencePath = join(runRoot, 'reference.png');
  const finalizedNodePath = join(runRoot, 'node.json');
  const finalizedVariablesPath = join(runRoot, 'variables.json');
  const finalizedDiffPath = join(runRoot, 'candidate-vs-canonical.png');
  const evidence = {
    schemaVersion: 1,
    kind: 'figma-reference-acquisition',
    runId,
    target: {
      registryId: id,
      manifestKey,
      logicalReferencePath: entry.referencePath,
    },
    acquisition: {
      adapter: 'figmoon-reference-broker',
      adapterVersion: '1.0.0',
      protocol: FIGMA_ACQUISITION_PROTOCOL,
      plugin: FIGMA_ACQUISITION_PLUGIN,
      operations: [...READ_ONLY_FIGMA_OPERATIONS],
      listenHost: bridge.host,
    },
    source: {
      file: { key: connection.fileKey, name: metadata.fileName },
      page: { id: metadata.targetPageId, name: metadata.targetPageName },
      node: {
        id: node.id,
        name: node.name,
        type: node.type,
        bounds: node.bounds,
        path: relativeToRepo(finalizedNodePath),
        sha256: sha256(nodeJson),
      },
      variables: {
        collectionCount: variables.collections.length,
        path: relativeToRepo(finalizedVariablesPath),
        sha256: sha256(variablesJson),
      },
      export: {
        path: relativeToRepo(finalizedReferencePath),
        sha256: sha256(referenceBytes),
        bounds: { width: imageMetadata.width, height: imageMetadata.height },
        spec: exportSpec,
      },
      stability: {
        beforeSha256: sha256(stableJson(acquisition.before)),
        afterSha256: sha256(stableJson(acquisition.after)),
        ancestorPage: acquisition.ancestry.before,
        changeTracking: acquisition.changeTracking,
      },
    },
    canonicalBefore: {
      path: relativeToRepo(canonicalPath),
      sha256: sha256(canonicalBytes),
      manifestSha256: entry.assetSha256,
      bounds: { width: canonicalMetadata.width, height: canonicalMetadata.height },
    },
    comparison: {
      dimensionsMatch: comparison.dimensionsMatch,
      exactMatch: comparison.exactMatch,
      mismatchedPixels: comparison.mismatchedPixels,
      totalPixels: comparison.totalPixels,
      diffPixelRatio: comparison.diffPixelRatio,
      diffPath: comparison.diffBytes ? relativeToRepo(finalizedDiffPath) : null,
    },
    validation: {
      status: blockingIssues.length
        ? 'blocked'
        : reviewRequired.length
          ? 'review-required'
          : 'ready',
      remapCandidate,
      nodeNameChangeCandidate,
      boundsChanged,
      fileBindingCandidate,
      sourceRemapCandidate,
      reviewRequired,
      blockingIssues,
    },
    acquiredAt,
    result: blockingIssues.length ? 'blocked' : 'staged',
  };
  writeFileSync(join(temporaryRoot, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  renameSync(temporaryRoot, runRoot);

  console.log(`Figma reference evidence: ${runRoot}`);
  const reviewSha256 = digestNamedFiles([
    { name: 'evidence.json', path: join(runRoot, 'evidence.json') },
    { name: 'node.json', path: join(runRoot, 'node.json') },
    { name: 'reference.png', path: join(runRoot, 'reference.png') },
    { name: 'variables.json', path: join(runRoot, 'variables.json') },
    ...(comparison.diffBytes
      ? [
          {
            name: 'candidate-vs-canonical.png',
            path: join(runRoot, 'candidate-vs-canonical.png'),
          },
        ]
      : []),
  ]);
  console.log(`Review SHA-256: ${reviewSha256}`);
  if (evidence.result !== 'staged') {
    console.error(`Acquisition was blocked: ${blockingIssues.join('; ')}`);
    process.exitCode = 2;
  } else if (reviewRequired.length) {
    console.log(`Staged with explicit review required: ${reviewRequired.join(', ')}`);
  } else {
    console.log('Staged read-only reference acquisition passed identity and predecessor checks.');
  }
} catch (error) {
  if (existsSync(temporaryRoot)) rmSync(temporaryRoot, { recursive: true, force: true });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await bridge?.close();
}

if (
  READ_ONLY_FIGMA_OPERATIONS.length !== 1 ||
  READ_ONLY_FIGMA_OPERATIONS[0] !== FIGMA_ACQUISITION_OPERATION
) {
  throw new Error(`Read-only acquisition contracts diverged in ${relative(REPO_ROOT, scriptDir)}.`);
}
