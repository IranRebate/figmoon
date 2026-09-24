import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import {
  FIGMA_ACQUISITION_PLUGIN,
  FIGMA_ACQUISITION_PROTOCOL,
} from './figma-readonly-bridge.mjs';
import {
  READ_ONLY_FIGMA_OPERATIONS,
  REFERENCE_RUNS_ROOT,
  REPO_ROOT,
  digestNamedFiles,
  findManifestEntry,
  findRegistryItem,
  resolveManifestArtifact,
  sha256,
  stableJson,
  validateRunId,
} from './figma-reference-run.mjs';

const ABSOLUTE_MAX_REFERENCE_PIXELS = 20_000_000;
const MAX_REFERENCE_DIMENSION = 8_192;
const MAX_BASE64_CHARACTERS = 28 * 1024 * 1024;

function finiteBounds(bounds) {
  return Boolean(
    bounds &&
      Number.isFinite(bounds.x) &&
      Number.isFinite(bounds.y) &&
      Number.isFinite(bounds.width) &&
      Number.isFinite(bounds.height) &&
      bounds.width > 0 &&
      bounds.height > 0
  );
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

function assertPayload(acquisition, nodeId) {
  const { before, after, export: exported, ancestry, changeTracking } = acquisition ?? {};
  const metadata = before?.metadata;
  const node = before?.node;
  const variables = before?.variables;
  if (!metadata || !node || !variables || !Array.isArray(variables.collections)) {
    throw new Error('Figma acquisition response is malformed.');
  }
  if (node.id !== nodeId || !node.name || !node.type || !finiteBounds(node.bounds)) {
    throw new Error(`Figma node '${nodeId}' is missing stable identity or bounds.`);
  }
  if (
    exported?.nodeId !== nodeId ||
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

/** Writes one immutable, promotion-compatible receipt from a read-only acquisition. */
export async function stageFigmaReference({
  bridge,
  connection,
  registry,
  manifest,
  id,
  nodeId,
  sourceRemapCandidate = false,
  nodeNameChangeCandidate = false,
  runId: requestedRunId,
  timeoutMs,
}) {
  const item = findRegistryItem(registry, id);
  const { key: manifestKey, entry } = findManifestEntry(manifest, id);
  if (!entry.referencePath || !entry.figma?.pageId || !entry.figma?.pageName) {
    throw new Error(`${id} does not have a manifest-backed Figma page/reference contract.`);
  }
  if (!nodeId) throw new Error(`${id} has no mapped node.`);
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
  try {
    const exportSpec = { format: 'PNG', scale: 1, clip: entry.exportSpec?.clip === true };
    const acquisition = await bridge.acquireReference(connection, { nodeId, exportSpec }, timeoutMs);
    const { metadata, node, variables, exported } = assertPayload(acquisition, nodeId);
    if (exported.clip !== exportSpec.clip) {
      throw new Error('Figma acquisition export clip mode contradicts the request.');
    }
    const referenceBytes = decodeBoundedBase64(exported.base64);
    const imageMetadata = await sharp(referenceBytes).metadata();
    const expectedPixels = entry.exportBounds.width * entry.exportBounds.height;
    const maxReferencePixels = Math.min(
      ABSOLUTE_MAX_REFERENCE_PIXELS,
      Math.max(1_000_000, expectedPixels * 4)
    );
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
    const remapCandidate = nodeId !== entry.figma?.nodeId;
    const nodeNameChanged = node.name !== entry.figma?.nodeName;
    const boundsChanged =
      imageMetadata.width !== entry.exportBounds?.width ||
      imageMetadata.height !== entry.exportBounds?.height;
    const blockingIssues = [];
    const reviewRequired = [];
    if (
      connection.fileName !== metadata.fileName ||
      metadata.fileName !== manifest.figmaFile?.name ||
      connection.fileKey !== metadata.fileKey ||
      connection.fileKey !== manifest.figmaFile?.key
    ) {
      blockingIssues.push('Live plugin metadata does not match the manifest Figma file identity.');
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
      blockingIssues.push('Mapped node name changed without an explicit review candidate.');
    }
    if (nodeNameChangeCandidate && remapCandidate) {
      blockingIssues.push('nodeNameChangeCandidate is valid only for an unchanged node ID.');
    }
    if (sha256(canonicalBytes) !== entry.assetSha256) {
      blockingIssues.push('Canonical reference bytes no longer match the manifest predecessor hash.');
    }
    if (remapCandidate) reviewRequired.push('node-remap');
    if (nodeNameChanged && nodeNameChangeCandidate) reviewRequired.push('node-name-change');
    if (boundsChanged) reviewRequired.push('export-bounds-change');
    if (sourceRemapCandidate) reviewRequired.push('source-file-remap');

    mkdirSync(temporaryRoot);
    const paths = {
      reference: join(temporaryRoot, 'reference.png'),
      node: join(temporaryRoot, 'node.json'),
      variables: join(temporaryRoot, 'variables.json'),
      diff: join(temporaryRoot, 'candidate-vs-canonical.png'),
    };
    writeFileSync(paths.reference, referenceBytes);
    writeFileSync(paths.node, nodeJson);
    writeFileSync(paths.variables, variablesJson);
    if (comparison.diffBytes) writeFileSync(paths.diff, comparison.diffBytes);
    const finalPaths = Object.fromEntries(
      Object.entries(paths).map(([key, path]) => [key, join(runRoot, path.split('/').at(-1))])
    );
    const evidence = {
      schemaVersion: 1,
      kind: 'figma-reference-acquisition',
      runId,
      target: { registryId: id, manifestKey, logicalReferencePath: entry.referencePath },
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
        node: { id: node.id, name: node.name, type: node.type, bounds: node.bounds, path: relative(REPO_ROOT, finalPaths.node), sha256: sha256(nodeJson) },
        variables: { collectionCount: variables.collections.length, path: relative(REPO_ROOT, finalPaths.variables), sha256: sha256(variablesJson) },
        export: { path: relative(REPO_ROOT, finalPaths.reference), sha256: sha256(referenceBytes), bounds: { width: imageMetadata.width, height: imageMetadata.height }, spec: exportSpec },
        stability: { beforeSha256: sha256(stableJson(acquisition.before)), afterSha256: sha256(stableJson(acquisition.after)), ancestorPage: acquisition.ancestry.before, changeTracking: acquisition.changeTracking },
      },
      canonicalBefore: { path: relative(REPO_ROOT, canonicalPath), sha256: sha256(canonicalBytes), manifestSha256: entry.assetSha256, bounds: { width: canonicalMetadata.width, height: canonicalMetadata.height } },
      comparison: { dimensionsMatch: comparison.dimensionsMatch, exactMatch: comparison.exactMatch, mismatchedPixels: comparison.mismatchedPixels, totalPixels: comparison.totalPixels, diffPixelRatio: comparison.diffPixelRatio, diffPath: comparison.diffBytes ? relative(REPO_ROOT, finalPaths.diff) : null },
      validation: { status: blockingIssues.length ? 'blocked' : reviewRequired.length ? 'review-required' : 'ready', remapCandidate, nodeNameChangeCandidate, boundsChanged, fileBindingCandidate: false, sourceRemapCandidate, reviewRequired, blockingIssues },
      acquiredAt: new Date().toISOString(),
      result: blockingIssues.length ? 'blocked' : 'staged',
    };
    writeFileSync(join(temporaryRoot, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    renameSync(temporaryRoot, runRoot);
    const reviewSha256 = digestNamedFiles([
      { name: 'evidence.json', path: join(runRoot, 'evidence.json') },
      { name: 'node.json', path: join(runRoot, 'node.json') },
      { name: 'reference.png', path: join(runRoot, 'reference.png') },
      { name: 'variables.json', path: join(runRoot, 'variables.json') },
      ...(comparison.diffBytes ? [{ name: 'candidate-vs-canonical.png', path: join(runRoot, 'candidate-vs-canonical.png') }] : []),
    ]);
    return { runId, runRoot, reviewSha256, evidence };
  } catch (error) {
    if (existsSync(temporaryRoot)) rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
