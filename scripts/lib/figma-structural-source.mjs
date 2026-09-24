import { readFileSync } from 'node:fs';
import {
  DURABLE_EVIDENCE_ROOT,
  findManifestEntry,
  findRegistryItem,
  loadReferenceRun,
  readJson,
  sha256,
} from './figma-reference-run.mjs';
import { resolveDurablePointer } from './figma-promotion.mjs';
import { assertFigmaAcquisitionPluginIntegrity } from './figma-plugin-integrity.mjs';

const DEFAULT_ENDPOINT = `http://localhost:${Number(process.env.FIGMOON_CONNECT_PORT ?? 29194)}/rpc`;

async function rpc(tool, params = {}, { endpoint = DEFAULT_ENDPOINT, timeoutMs = 5_000 } = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, ...params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Figmoon ${tool} returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload.error) throw new Error(`Figmoon ${tool}: ${payload.error}`);
  return payload.data;
}

export function selectConnectedFigmaFile(manifest, files) {
  const expectedName = manifest.figmaFile?.dailySync?.fileName ?? manifest.figmaFile?.name;
  const matches = (Array.isArray(files) ? files : []).filter((file) => file?.fileName === expectedName);
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? `Figmoon has ${matches.length} connected files named '${expectedName}'; connect exactly one.`
        : `Figmoon has no connected file named '${expectedName}'.`
    );
  }
  const expectedBuild = assertFigmaAcquisitionPluginIntegrity().plugin.build;
  if (matches[0].pluginBuild !== expectedBuild) {
    throw new Error('The connected Figmoon plugin build is stale.');
  }
  return matches[0];
}

function validateNodeIdentity(node, entry, id, figma = null) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`Figma structure for '${id}' is malformed.`);
  }
  const expected = figma ?? entry.figma ?? {};
  const mismatches = [
    ['id', expected.nodeId, node.id],
    ['name', expected.nodeName, node.name],
    ['type', expected.nodeType, node.type],
  ].filter(([, expectedValue, observed]) => expectedValue && expectedValue !== observed);
  const expectedBounds = expected.liveBounds ?? entry.exportBounds;
  if (
    expectedBounds &&
    (Math.abs(node.bounds?.width - expectedBounds.width) > 0.01 ||
      Math.abs(node.bounds?.height - expectedBounds.height) > 0.01)
  ) {
    mismatches.push([
      'bounds',
      `${expectedBounds.width}x${expectedBounds.height}`,
      `${node.bounds?.width ?? 'missing'}x${node.bounds?.height ?? 'missing'}`,
    ]);
  }
  if (mismatches.length) {
    throw new Error(
      `Figma structure identity changed for '${id}': ${mismatches
        .map(([field, expectedValue, observed]) => `${field} expected ${expectedValue}, observed ${observed}`)
        .join('; ')}.`
    );
  }
  return node;
}

function canonicalNodePointer(entry) {
  const pointer = entry.acquisition?.node;
  if (!pointer?.path || !pointer?.sha256) {
    throw new Error('Canonical manifest acquisition does not contain durable node evidence.');
  }
  if (entry.acquisition?.nodeSha256 !== pointer.sha256) {
    throw new Error('Canonical manifest node pointer contradicts acquisition metadata.');
  }
  return pointer;
}

export function loadCanonicalFigmaStructure({
  id,
  registry,
  manifest,
  referenceRun = null,
  durableEvidenceRoot = DURABLE_EVIDENCE_ROOT,
}) {
  const item = findRegistryItem(registry, id);
  const { key: manifestKey, entry } = findManifestEntry(manifest, id);
  if (referenceRun) {
    return loadReferenceRun({
      runId: referenceRun,
      id,
      registry,
      manifest,
      allowRemapCandidate: true,
      allowNodeNameChangeCandidate: true,
      allowSourceRemapCandidate: true,
      allowBoundsChange: true,
      requireCurrentCanonical: false,
    }).then((run) => ({
      item,
      manifestKey,
      entry,
      node: validateNodeIdentity(readJson(run.nodePath), {
        ...entry,
        figma: {
          ...entry.figma,
          nodeId: run.evidence.source.node.id,
          nodeName: run.evidence.source.node.name,
          nodeType: run.evidence.source.node.type,
          liveBounds: run.evidence.source.node.bounds,
        },
      }, id),
      source: {
        kind: 'staged-acquisition',
        runId: referenceRun,
        path: run.nodePath,
        sha256: sha256(readFileSync(run.nodePath)),
        durable: false,
      },
    }));
  }
  const pointer = canonicalNodePointer(entry);
  const path = resolveDurablePointer(pointer, {
    root: durableEvidenceRoot,
    extensions: ['json'],
    label: 'Canonical Figma node evidence',
  });
  return Promise.resolve({
    item,
    manifestKey,
    entry,
    node: validateNodeIdentity(readJson(path), entry, id),
    source: {
      kind: 'canonical-acquisition',
      path,
      sha256: pointer.sha256,
      acquisitionRunId: entry.acquisition?.runId ?? null,
      durable: true,
    },
  });
}

export async function loadLiveFigmaStructure({ id, registry, manifest, endpoint = DEFAULT_ENDPOINT }) {
  const item = findRegistryItem(registry, id);
  const { key: manifestKey, entry } = findManifestEntry(manifest, id);
  const files = await rpc('list_files', {}, { endpoint, timeoutMs: 3_000 });
  const file = selectConnectedFigmaFile(manifest, files);
  const context = await rpc(
    'get_editor_context',
    { fileKey: file.fileKey },
    { endpoint, timeoutMs: 5_000 }
  );
  if (!context?.fileName || context.fileName !== file.fileName || !Array.isArray(context.pages)) {
    throw new Error('Figmoon did not return a usable workspace context.');
  }
  const figma = entry.dailySyncFigma ?? entry.figma;
  const node = await rpc(
    'get_node',
    { nodeIds: [figma?.nodeId], fileKey: file.fileKey },
    { endpoint, timeoutMs: 15_000 }
  );
  return {
    item,
    manifestKey,
    entry,
    node: validateNodeIdentity(node, entry, id, figma),
    source: {
      kind: 'live-connect',
      endpoint,
      fileKey: file.fileKey,
      fileName: file.fileName,
      pluginBuild: file.pluginBuild,
      revision: context.revision ?? null,
      durable: false,
    },
  };
}

export async function loadFigmaStructure({
  id,
  registry,
  manifest,
  source = 'auto',
  referenceRun = null,
  endpoint = DEFAULT_ENDPOINT,
  durableEvidenceRoot = DURABLE_EVIDENCE_ROOT,
}) {
  if (!['auto', 'live', 'canonical'].includes(source)) {
    throw new Error(`Unsupported Figma structural source '${source}'.`);
  }
  if (referenceRun && source === 'live') {
    throw new Error('A staged reference run cannot be combined with --figma-source live.');
  }
  if (source === 'canonical' || referenceRun) {
    return loadCanonicalFigmaStructure({
      id,
      registry,
      manifest,
      referenceRun,
      durableEvidenceRoot,
    });
  }
  try {
    return await loadLiveFigmaStructure({ id, registry, manifest, endpoint });
  } catch (error) {
    if (source === 'live') throw error;
    const canonical = await loadCanonicalFigmaStructure({
      id,
      registry,
      manifest,
      durableEvidenceRoot,
    });
    canonical.source.liveFallbackReason = error instanceof Error ? error.message : String(error);
    return canonical;
  }
}
