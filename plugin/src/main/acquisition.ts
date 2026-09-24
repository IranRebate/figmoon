// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { serializeNode } from './serializer';

const PROTOCOL_ID = 'figmoon-reference-acquisition/v1';
const PLUGIN_ID = 'figmoon';
const PLUGIN_VERSION = '1.0.0';
const BUILD_ID =
  '1.0.0+gethopp-v0.0.18.dc2ea5a.sha256.6003b643bea74a3fa67eb5c616a4d6f1709ffe442edd94c8955c8e7e66bcc60c';
let documentRevision = 0;
let documentChangeTracking = true;
let acquisitionInFlight = false;

const readFileKey = () => {
  try {
    return typeof figma.fileKey === 'string' && figma.fileKey ? figma.fileKey : null;
  } catch {
    return null;
  }
};

export const pluginIdentity = () => ({
  protocol: PROTOCOL_ID,
  plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION, build: BUILD_ID },
  file: { key: readFileKey(), name: figma.root.name },
});

export async function initializeAcquisition() {
  try {
    await figma.loadAllPagesAsync();
    figma.on('documentchange', () => {
      documentRevision += 1;
    });
  } catch {
    documentChangeTracking = false;
  }
}

const variableValue = (value) => {
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'VARIABLE_ALIAS') return { type: value.type, id: value.id };
  if ('r' in value && 'g' in value && 'b' in value)
    return { type: 'COLOR', r: value.r, g: value.g, b: value.b, a: 'a' in value ? value.a : 1 };
  return value;
};

async function readVariables() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  return {
    collections: await Promise.all(
      collections.map(async (collection) => ({
        id: collection.id,
        name: collection.name,
        defaultModeId: collection.defaultModeId,
        modes: collection.modes.map(({ modeId, name }) => ({ modeId, name })),
        variables: (
          await Promise.all(
            collection.variableIds.map((id) => figma.variables.getVariableByIdAsync(id))
          )
        )
          .filter(Boolean)
          .map((item) => ({
            id: item.id,
            key: item.key,
            name: item.name,
            description: item.description,
            resolvedType: item.resolvedType,
            scopes: item.scopes,
            valuesByMode: Object.fromEntries(
              Object.entries(item.valuesByMode).map(([id, value]) => [id, variableValue(value)])
            ),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }))
    ).then((items) => items.sort((a, b) => a.id.localeCompare(b.id))),
  };
}

function pageAncestor(node) {
  let current = node;
  while (current && current.type !== 'PAGE') current = current.parent;
  if (!current) throw new Error(`Node ${node.id} has no page ancestor.`);
  return { id: current.id, name: current.name };
}

async function snapshot(nodeId) {
  const start = documentRevision;
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE')
    throw new Error(`Scene node not found: ${nodeId}`);
  const ancestor = pageAncestor(node);
  const payload = {
    metadata: {
      fileKey: readFileKey(),
      fileName: figma.root.name,
      currentPageId: figma.currentPage.id,
      currentPageName: figma.currentPage.name,
      targetPageId: ancestor.id,
      targetPageName: ancestor.name,
      pageCount: figma.root.children.length,
      pages: figma.root.children.map(({ id, name }) => ({ id, name })),
    },
    node: serializeNode(node, 99),
    variables: await readVariables(),
    revision: { start, end: documentRevision },
  };
  return { node, ancestor, payload };
}

function validate(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('Acquisition request must be an object.');
  const keys = Object.keys(request).sort().join(',');
  if (keys !== 'export,nodeId,protocol,requestId,type')
    throw new Error('Request contains unsupported fields.');
  if (request.type !== 'acquire_reference' || request.protocol !== PROTOCOL_ID)
    throw new Error('Unsupported acquisition request.');
  if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(request.requestId))
    throw new Error('Invalid request ID.');
  if (typeof request.nodeId !== 'string' || !/^(?:I)?\d+:\d+(?:;\d+:\d+)*$/.test(request.nodeId))
    throw new Error('Invalid node ID.');
  if (
    !request.export ||
    Object.keys(request.export).sort().join(',') !== 'clip,format,scale' ||
    request.export.format !== 'PNG' ||
    request.export.scale !== 1 ||
    typeof request.export.clip !== 'boolean'
  )
    throw new Error('Only raw PNG exports at scale 1 are allowed.');
  return request;
}

export async function handleAcquisition(rawRequest) {
  const requestId = typeof rawRequest?.requestId === 'string' ? rawRequest.requestId : 'invalid';
  try {
    const request = validate(rawRequest);
    if (acquisitionInFlight) throw new Error('An acquisition is already in progress.');
    acquisitionInFlight = true;
    const before = await snapshot(request.nodeId);
    const bytes = await before.node.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: 1 },
      ...(request.export.clip ? { contentsOnly: true, useAbsoluteBounds: true } : {}),
    });
    const after = await snapshot(request.nodeId);
    return {
      type: 'acquisition_result',
      protocol: PROTOCOL_ID,
      requestId,
      data: {
        before: before.payload,
        export: {
          nodeId: request.nodeId,
          nodeName: before.payload.node.name,
          format: 'PNG',
          scale: 1,
          clip: request.export.clip,
          base64: figma.base64Encode(bytes),
        },
        after: after.payload,
        ancestry: { before: before.ancestor, after: after.ancestor },
        changeTracking: {
          supported: documentChangeTracking,
          beforeReadStart: before.payload.revision.start,
          beforeReadEnd: before.payload.revision.end,
          afterReadStart: after.payload.revision.start,
          afterReadEnd: after.payload.revision.end,
        },
      },
    };
  } catch (error) {
    return {
      type: 'acquisition_result',
      protocol: PROTOCOL_ID,
      requestId,
      error: {
        code: 'FIGMOON_ACQUISITION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    acquisitionInFlight = false;
  }
}
