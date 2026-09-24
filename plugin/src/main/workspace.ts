// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
/* eslint-disable @typescript-eslint/no-explicit-any */
import { serializeNode } from './serializer';
import { analyzeDesignPatterns } from './pattern-analysis.mjs';

export const ADVANCED_REQUEST_TYPES = new Set([
  'get_editor_context',
  'create_figjam_sticky',
  'create_figjam_connector',
  'create_figjam_section',
  'create_slide',
  'search_nodes',
  'get_page',
  'get_components',
  'analyze_design_patterns',
  'get_library_assets',
  'get_annotations',
  'instantiate_library_component',
  'import_library_variable',
  'bind_variable',
  'set_instance_properties',
  'set_reactions',
  'set_annotations',
  'get_reactions',
  'audit_accessibility',
  'get_workspace_changes',
  'acquire_workspace_lock',
  'release_workspace_lock',
  'batch_transaction',
]);

let revision = 0;
const changes: Array<{ revision: number; at: string; kinds: string[]; nodeIds: string[] }> = [];
const locks = new Map<
  string,
  { id: string; owner: string; nodeIds: string[]; expiresAt: number; inFlight: boolean }
>();
const readCache = new Map<string, unknown>();

const cleanLocks = () => {
  const now = Date.now();
  for (const [id, lock] of locks) {
    if (lock.expiresAt <= now && !lock.inFlight) locks.delete(id);
  }
};

export const initializeWorkspace = async () => {
  await figma.loadAllPagesAsync();
  figma.on('documentchange', (event) => {
    revision += 1;
    readCache.clear();
    const documentChanges = Array.isArray(event?.documentChanges) ? event.documentChanges : [];
    changes.push({
      revision,
      at: new Date().toISOString(),
      kinds: [...new Set(documentChanges.map((change) => String(change.type)))],
      nodeIds: [
        ...new Set(
          documentChanges.flatMap((change) => [change.id, change.node?.id]).filter(Boolean)
        ),
      ],
    });
    if (changes.length > 1000) changes.splice(0, changes.length - 1000);
  });
};

const textOf = (node: any) => (node.type === 'TEXT' ? String(node.characters ?? '') : '');
const safeRead = (read: () => unknown) => {
  try {
    return read();
  } catch {
    return undefined;
  }
};
const ancestry = (node: any) => {
  const result = [];
  let current = node.parent;
  while (current && current.type !== 'DOCUMENT') {
    result.unshift({ id: current.id, name: current.name, type: current.type });
    current = current.parent;
  }
  return result;
};
const compactNode = (node: any) => ({
  id: node.id,
  name: node.name,
  type: node.type,
  visible: node.visible !== false,
  text: textOf(node) || undefined,
  pageId: ancestry(node).find((item) => item.type === 'PAGE')?.id,
  ancestry: ancestry(node),
  bounds: 'absoluteBoundingBox' in node ? node.absoluteBoundingBox : undefined,
});
const truncateTree = (node: any, depth: number, current = 0): any => {
  if (!node || typeof node !== 'object') return node;
  if (current >= depth) {
    const { children, ...rest } = node;
    return { ...rest, childCount: Array.isArray(children) ? children.length : 0 };
  }
  return {
    ...node,
    children: Array.isArray(node.children)
      ? node.children.map((child: any) => truncateTree(child, depth, current + 1))
      : node.children,
  };
};

const nodesUnder = (root: any) => [
  root,
  ...(typeof root.findAll === 'function' ? root.findAll(() => true) : []),
];
const findRoot = async (params: any) => {
  if (params.nodeId) return figma.getNodeByIdAsync(params.nodeId);
  if (params.pageId) return figma.getNodeByIdAsync(params.pageId);
  return figma.root;
};

const relativeLuminance = ({ r, g, b }: any) => {
  const channel = (value: number) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const solidColor = (paints: any) =>
  Array.isArray(paints) && paints.length === 1 && paints[0]?.type === 'SOLID'
    ? paints[0].color
    : null;

const requireLock = (owner: string, lockId: string) => {
  cleanLocks();
  const lock = locks.get(lockId);
  if (!lock || lock.owner !== owner)
    throw new Error('A live owner-bound workspace lock is required.');
  return lock;
};

const BATCH_OPERATION_TYPES = new Set([
  'set_node_visibility',
  'set_text_content',
  'set_node_properties',
  'set_solid_fill',
  'set_gradient_fill',
  'set_effects',
  'set_stroke_properties',
  'set_auto_layout',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const sameNodeSet = (left: string[], right: string[]) =>
  left.length === right.length && left.every((id) => right.includes(id));

const uniqueNodeIds = (value: unknown, label: string, maximum = 200) => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (value.length > maximum) throw new Error(`${label} may contain at most ${maximum} nodes.`);
  const nodeIds = value.map((id) => {
    if (typeof id !== 'string' || !id) throw new Error(`${label} must contain node ID strings.`);
    return id;
  });
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new Error(`${label} must contain unique node IDs.`);
  }
  return nodeIds;
};

const normalizeBatchOperation = (operation: unknown, index: number) => {
  if (!isRecord(operation)) throw new Error(`Batch operation ${index} must be an object.`);
  const type = operation.type;
  if (typeof type !== 'string' || !BATCH_OPERATION_TYPES.has(type)) {
    throw new Error(`Batch operation ${index} has an unsupported type.`);
  }
  const params = operation.params === undefined ? {} : operation.params;
  if (!isRecord(params)) throw new Error(`Batch operation ${index} params must be an object.`);
  if ('nodeId' in params || 'fileKey' in params) {
    throw new Error(
      `Batch operation ${index} must declare targets only through its canonical node fields.`
    );
  }

  if (type === 'set_node_visibility') {
    const rawItems = params.items;
    if (!Array.isArray(rawItems) || !rawItems.length) {
      throw new Error(`Batch operation ${index} visibility params.items is required.`);
    }
    if (rawItems.length > 200) {
      throw new Error(`Batch operation ${index} visibility may target at most 200 nodes.`);
    }
    const items = rawItems.map((item, itemIndex) => {
      if (
        !isRecord(item) ||
        typeof item.nodeId !== 'string' ||
        !item.nodeId ||
        typeof item.visible !== 'boolean'
      ) {
        throw new Error(
          `Batch operation ${index} visibility item ${itemIndex} requires nodeId and visible.`
        );
      }
      return { nodeId: item.nodeId, visible: item.visible };
    });
    const nodeIds = uniqueNodeIds(
      items.map((item) => item.nodeId),
      `Batch operation ${index} visibility targets`
    );
    if (operation.nodeIds !== undefined) {
      const declared = uniqueNodeIds(
        operation.nodeIds,
        `Batch operation ${index} declared nodeIds`
      );
      if (!sameNodeSet(declared, nodeIds)) {
        throw new Error(
          `Batch operation ${index} declared nodeIds do not match visibility params.items.`
        );
      }
    }
    return { index, type, nodeIds, params: { items } };
  }

  const nodeIds = uniqueNodeIds(operation.nodeIds, `Batch operation ${index} nodeIds`);
  if (nodeIds.length !== 1) {
    throw new Error(`Batch operation ${index} ${type} requires exactly one target node ID.`);
  }
  return { index, type, nodeIds, params };
};

const resolveScopeNodes = async (
  nodeIds: string[],
  label: string,
  { allowPage = true }: { allowPage?: boolean } = {}
) => {
  const nodes = await Promise.all(nodeIds.map((id) => figma.getNodeByIdAsync(id)));
  return nodes.map((node, index) => {
    if (!node || node.type === 'DOCUMENT' || (!allowPage && node.type === 'PAGE')) {
      throw new Error(`${label} node not found: ${nodeIds[index]}`);
    }
    return node;
  });
};

const isWithinSubtree = (node: any, root: any) => {
  let current = node;
  while (current && current.type !== 'DOCUMENT') {
    if (current.id === root.id) return true;
    current = current.parent;
  }
  return false;
};

const scopesOverlap = (left: any[], right: any[]) =>
  left.some((leftNode) =>
    right.some(
      (rightNode) => isWithinSubtree(leftNode, rightNode) || isWithinSubtree(rightNode, leftNode)
    )
  );

export async function handleAdvancedRequest(
  request: any,
  executeBase: (request: any) => Promise<any>
) {
  const params = request.params ?? {};
  switch (request.type) {
    case 'get_editor_context':
      return {
        revision,
        editorType: figma.editorType,
        fileName: figma.root.name,
        currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
        pages: figma.root.children.map((page: any) => ({
          id: page.id,
          name: page.name,
          type: page.type,
        })),
        slideGrid:
          figma.editorType === 'slides' && figma.getSlideGrid
            ? figma.getSlideGrid().map((row: any[]) => row.map(compactNode))
            : undefined,
      };
    case 'create_figjam_sticky': {
      if (figma.editorType !== 'figjam') throw new Error('This tool requires FigJam.');
      const sticky = figma.createSticky();
      sticky.x = Number(params.x) || 0;
      sticky.y = Number(params.y) || 0;
      await figma.loadFontAsync(sticky.text.fontName);
      sticky.text.characters = String(params.text);
      return { revision, sticky: compactNode(sticky) };
    }
    case 'create_figjam_connector': {
      if (figma.editorType !== 'figjam') throw new Error('This tool requires FigJam.');
      const start = await figma.getNodeByIdAsync(String(params.startNodeId));
      const end = await figma.getNodeByIdAsync(String(params.endNodeId));
      if (!start || !end) throw new Error('Connector endpoints must exist.');
      const connector = figma.createConnector();
      connector.connectorStart = { endpointNodeId: start.id, magnet: 'AUTO' };
      connector.connectorEnd = { endpointNodeId: end.id, magnet: 'AUTO' };
      return { revision, connector: compactNode(connector) };
    }
    case 'create_figjam_section': {
      if (figma.editorType !== 'figjam') throw new Error('This tool requires FigJam.');
      const section = figma.createSection();
      section.name = String(params.name);
      section.x = Number(params.x) || 0;
      section.y = Number(params.y) || 0;
      section.resize(Number(params.width) || 800, Number(params.height) || 600);
      return { revision, section: compactNode(section) };
    }
    case 'create_slide': {
      if (figma.editorType !== 'slides') throw new Error('This tool requires Figma Slides.');
      const slide = figma.createSlide(params.row, params.column);
      if (params.name) slide.name = String(params.name);
      return { revision, slide: compactNode(slide) };
    }
    case 'search_nodes': {
      const query = String(params.query ?? '')
        .trim()
        .toLocaleLowerCase();
      const types = new Set(Array.isArray(params.types) ? params.types.map(String) : []);
      const root = params.pageId ? await figma.getNodeByIdAsync(params.pageId) : figma.root;
      if (!root) throw new Error('Search page not found.');
      const limit = Math.min(Number(params.limit) || 100, 500);
      const cacheKey = `search:${revision}:${JSON.stringify(params)}`;
      const cached = readCache.get(cacheKey);
      if (cached) return { ...(cached as any), cached: true };
      const matches = nodesUnder(root)
        .filter((node: any) => {
          if (node.type === 'DOCUMENT' || (!params.includeHidden && node.visible === false))
            return false;
          if (types.size && !types.has(node.type)) return false;
          return !query || `${node.name}\n${textOf(node)}`.toLocaleLowerCase().includes(query);
        })
        .slice(0, limit)
        .map(compactNode);
      const response = {
        query,
        count: matches.length,
        truncated: matches.length === limit,
        revision,
        matches,
      };
      readCache.set(cacheKey, response);
      return { ...response, cached: false };
    }
    case 'get_page': {
      const page = await figma.getNodeByIdAsync(String(params.pageId));
      if (!page || page.type !== 'PAGE') throw new Error('Page not found.');
      const cacheKey = `page:${revision}:${page.id}:${Number(params.depth) || 4}`;
      const cached = readCache.get(cacheKey);
      if (cached) return { revision, cached: true, page: cached };
      const serialized = truncateTree(serializeNode(page), Number(params.depth) || 4);
      readCache.set(cacheKey, serialized);
      return { revision, cached: false, page: serialized };
    }
    case 'get_components': {
      const query = String(params.query ?? '').toLocaleLowerCase();
      const limit = Math.min(Number(params.limit) || 200, 500);
      const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
      const allowed = new Set([
        'COMPONENT',
        'COMPONENT_SET',
        ...(params.includeInstances ? ['INSTANCE'] : []),
      ]);
      const matches = figma.root.findAll(
        (node: any) =>
          allowed.has(node.type) && (!query || node.name.toLocaleLowerCase().includes(query))
      );
      const selected = matches.slice(offset, offset + limit);
      const items = await Promise.all(
        selected.map(async (node: any) => {
          let mainComponent;
          if (node.type === 'INSTANCE') {
            try {
              mainComponent =
                typeof node.getMainComponentAsync === 'function'
                  ? await node.getMainComponentAsync()
                  : node.mainComponent;
            } catch {
              mainComponent = undefined;
            }
          }
          return {
            ...compactNode(node),
            key: safeRead(() => node.key),
            remote: safeRead(() => node.remote),
            description: safeRead(() => node.description),
            componentPropertyDefinitions: safeRead(() => node.componentPropertyDefinitions),
            componentProperties: safeRead(() => node.componentProperties),
            boundVariables: safeRead(() => node.boundVariables),
            explicitVariableModes: safeRead(() => node.explicitVariableModes),
            mainComponentId: mainComponent?.id,
            mainComponentKey: safeRead(() => mainComponent?.key),
            mainComponentName: mainComponent?.name,
            mainComponentRemote: safeRead(() => mainComponent?.remote),
          };
        })
      );
      const nextOffset = offset + items.length;
      return {
        revision,
        total: matches.length,
        offset,
        count: items.length,
        truncated: nextOffset < matches.length,
        nextOffset: nextOffset < matches.length ? nextOffset : undefined,
        items,
      };
    }
    case 'analyze_design_patterns': {
      const root = await findRoot(params);
      if (!root) throw new Error('Pattern-analysis scope not found.');
      const cacheKey = `patterns:${revision}:${root.id}:${JSON.stringify(params)}`;
      const cached = readCache.get(cacheKey);
      if (cached) return { revision, cached: true, analysis: cached };
      const analysis = analyzeDesignPatterns(root, params);
      readCache.set(cacheKey, analysis);
      return { revision, cached: false, analysis };
    }
    case 'get_library_assets': {
      const query = String(params.query ?? '').toLocaleLowerCase();
      const output: any = { components: [], variableCollections: [] };
      if (
        params.includeComponents !== false &&
        figma.teamLibrary?.getAvailableLibraryComponentsAsync
      ) {
        output.components = (await figma.teamLibrary.getAvailableLibraryComponentsAsync()).filter(
          (item: any) =>
            !query || `${item.name} ${item.libraryName}`.toLocaleLowerCase().includes(query)
        );
      }
      if (
        params.includeVariables !== false &&
        figma.teamLibrary?.getAvailableLibraryVariableCollectionsAsync
      ) {
        const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
        output.variableCollections = await Promise.all(
          collections
            .filter(
              (item: any) =>
                !query || `${item.name} ${item.libraryName}`.toLocaleLowerCase().includes(query)
            )
            .map(async (collection: any) => ({
              ...collection,
              variables: await figma.teamLibrary.getVariablesInLibraryCollectionAsync(
                collection.key
              ),
            }))
        );
      }
      return { revision, ...output };
    }
    case 'instantiate_library_component': {
      if (figma.editorType === 'dev')
        throw new Error('Component instantiation requires the design editor.');
      const component = await figma.importComponentByKeyAsync(String(params.componentKey));
      const instance = component.createInstance();
      instance.x = Number(params.x) || 0;
      instance.y = Number(params.y) || 0;
      if (params.parentId) {
        const parent: any = await figma.getNodeByIdAsync(String(params.parentId));
        if (!parent || typeof parent.appendChild !== 'function')
          throw new Error('Component parent cannot contain children.');
        parent.appendChild(instance);
      } else figma.currentPage.appendChild(instance);
      return { revision, component: compactNode(component), instance: compactNode(instance) };
    }
    case 'import_library_variable': {
      if (figma.editorType === 'dev')
        throw new Error('Variable import requires the design editor.');
      const variable = await figma.variables.importVariableByKeyAsync(String(params.variableKey));
      return {
        revision,
        variable: {
          id: variable.id,
          key: variable.key,
          name: variable.name,
          resolvedType: variable.resolvedType,
        },
      };
    }
    case 'bind_variable': {
      if (figma.editorType === 'dev')
        throw new Error('Variable binding requires the design editor.');
      const node: any = await figma.getNodeByIdAsync(String(params.nodeId));
      if (!node || typeof node.setBoundVariable !== 'function')
        throw new Error('Node field does not support variable binding.');
      const variable =
        params.variableId === null
          ? null
          : await figma.variables.getVariableByIdAsync(String(params.variableId));
      if (params.variableId !== null && !variable) throw new Error('Variable not found.');
      node.setBoundVariable(String(params.field), variable);
      return { revision, nodeId: node.id, field: params.field, variableId: variable?.id ?? null };
    }
    case 'set_instance_properties': {
      if (figma.editorType === 'dev')
        throw new Error('Instance editing requires the design editor.');
      const node: any = await figma.getNodeByIdAsync(String(params.nodeId));
      if (!node || node.type !== 'INSTANCE') throw new Error('Instance not found.');
      node.setProperties(params.properties ?? {});
      return { revision, node: compactNode(node), componentProperties: node.componentProperties };
    }
    case 'set_reactions': {
      if (figma.editorType === 'dev')
        throw new Error('Prototype editing requires the design editor.');
      const node: any = await figma.getNodeByIdAsync(String(params.nodeId));
      if (!node || typeof node.setReactionsAsync !== 'function')
        throw new Error('Node does not support prototype reactions.');
      await node.setReactionsAsync(params.reactions ?? []);
      return { revision, node: compactNode(node), reactions: await node.getReactionsAsync() };
    }
    case 'set_annotations': {
      if (figma.editorType === 'dev')
        throw new Error('Annotation editing requires the design editor.');
      const node: any = await figma.getNodeByIdAsync(String(params.nodeId));
      if (!node || !('annotations' in node)) throw new Error('Node does not support annotations.');
      node.annotations = params.annotations ?? [];
      return { revision, node: compactNode(node), annotations: node.annotations };
    }
    case 'get_annotations': {
      const root = await findRoot(params);
      if (!root) throw new Error('Annotation scope not found.');
      const items = nodesUnder(root)
        .filter((node: any) => Array.isArray(node.annotations) && node.annotations.length)
        .slice(0, Number(params.limit) || 300)
        .map((node: any) => ({ ...compactNode(node), annotations: node.annotations }));
      return { revision, count: items.length, items };
    }
    case 'get_reactions': {
      const items = await Promise.all(
        (params.nodeIds ?? []).map(async (id: string) => {
          const node: any = await figma.getNodeByIdAsync(id);
          if (!node) return { nodeId: id, error: 'not-found' };
          const reactions =
            typeof node.getReactionsAsync === 'function'
              ? await node.getReactionsAsync()
              : node.reactions;
          return { node: compactNode(node), reactions: reactions ?? [] };
        })
      );
      return { revision, items };
    }
    case 'audit_accessibility': {
      const root: any = await findRoot(params);
      if (!root) throw new Error('Accessibility scope not found.');
      const findings: any[] = [];
      for (const node of nodesUnder(root).slice(0, Number(params.limit) || 1000) as any[]) {
        if (node.visible === false) continue;
        if (node.type === 'TEXT') {
          const fontSize = typeof node.fontSize === 'number' ? node.fontSize : null;
          if (!String(node.characters ?? '').trim())
            findings.push({ severity: 'warning', rule: 'empty-text', node: compactNode(node) });
          if (fontSize !== null && fontSize < 11)
            findings.push({
              severity: 'warning',
              rule: 'small-text',
              value: fontSize,
              node: compactNode(node),
            });
          const foreground = solidColor(node.fills);
          const background = solidColor(node.parent?.fills);
          if (foreground && background) {
            const [lighter, darker] = [
              relativeLuminance(foreground),
              relativeLuminance(background),
            ].sort((a, b) => b - a);
            const ratio = (lighter + 0.05) / (darker + 0.05);
            if (ratio < 4.5)
              findings.push({
                severity: 'error',
                rule: 'text-contrast',
                value: Number(ratio.toFixed(2)),
                node: compactNode(node),
              });
          }
        }
        if (
          ['FRAME', 'COMPONENT', 'INSTANCE'].includes(node.type) &&
          /button|icon button|cta/i.test(node.name) &&
          (node.width < 44 || node.height < 44)
        )
          findings.push({
            severity: 'warning',
            rule: 'touch-target',
            value: { width: node.width, height: node.height },
            node: compactNode(node),
          });
      }
      return { revision, scope: compactNode(root), findingCount: findings.length, findings };
    }
    case 'get_workspace_changes': {
      const since = Number(params.sinceRevision) || 0;
      const limit = Math.min(Number(params.limit) || 200, 500);
      return {
        revision,
        resetRequired: since > revision || (changes[0] && since < changes[0].revision - 1),
        changes: changes.filter((item) => item.revision > since).slice(-limit),
      };
    }
    case 'acquire_workspace_lock': {
      cleanLocks();
      if (typeof params.owner !== 'string') {
        throw new Error('Workspace lock owner must be a string.');
      }
      const owner = params.owner;
      if (owner.length < 3 || owner.length > 120) {
        throw new Error('Workspace lock owner must contain 3 through 120 characters.');
      }
      const nodeIds = uniqueNodeIds(params.nodeIds ?? [], 'Workspace lock nodeIds');
      const ttlMs = Number(params.ttlMs ?? 30000);
      if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) {
        throw new Error('Workspace lock ttlMs must be an integer from 1000 through 300000.');
      }
      const requestedNodes = await resolveScopeNodes(nodeIds, 'Workspace lock');
      for (const lock of locks.values()) {
        let overlaps = !lock.nodeIds.length || !nodeIds.length;
        if (!overlaps) {
          try {
            const lockedNodes = await resolveScopeNodes(lock.nodeIds, 'Existing workspace lock');
            overlaps = scopesOverlap(lockedNodes, requestedNodes);
          } catch {
            // A missing scope cannot be proven disjoint. Keep the expiring lock
            // conservative instead of silently allowing an overlapping writer.
            overlaps = true;
          }
        }
        if (overlaps) throw new Error(`Workspace is locked by ${lock.owner}.`);
      }
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const lock = {
        id,
        owner,
        nodeIds,
        expiresAt: Date.now() + ttlMs,
        inFlight: false,
      };
      locks.set(id, lock);
      return { revision, lock };
    }
    case 'release_workspace_lock': {
      const lock = requireLock(String(params.owner), String(params.lockId));
      if (lock.inFlight) throw new Error('Workspace lock is active in a batch transaction.');
      locks.delete(String(params.lockId));
      return { released: true, revision };
    }
    case 'batch_transaction': {
      requireLock(String(params.owner), String(params.lockId));
      if (!Number.isInteger(params.expectedRevision) || params.expectedRevision < 0) {
        throw new Error('Batch expectedRevision must be a non-negative integer.');
      }
      if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean') {
        throw new Error('Batch dryRun must be a boolean.');
      }
      if (params.expectedRevision !== revision)
        throw new Error(
          `Revision conflict: expected ${params.expectedRevision}, current ${revision}.`
        );
      if (!Array.isArray(params.operations) || !params.operations.length) {
        throw new Error('Batch requires at least one operation.');
      }
      if (params.operations.length > 100) {
        throw new Error('Batch may contain at most 100 operations.');
      }
      const plan = params.operations.map(normalizeBatchOperation);
      const lock = requireLock(String(params.owner), String(params.lockId));
      const targetIds = [...new Set(plan.flatMap((operation) => operation.nodeIds))];
      const targetNodes = await resolveScopeNodes(targetIds, 'Batch target', { allowPage: false });
      if (lock.nodeIds.length) {
        const leaseNodes = await resolveScopeNodes(lock.nodeIds, 'Workspace lock');
        const outsideLease = targetNodes
          .filter((node) => !leaseNodes.some((root) => isWithinSubtree(node, root)))
          .map((node) => node.id);
        if (outsideLease.length)
          throw new Error(
            `Batch targets nodes outside its lease: ${[...new Set(outsideLease)].join(', ')}`
          );
      }
      if (params.expectedRevision !== revision) {
        throw new Error(
          `Revision conflict: expected ${params.expectedRevision}, current ${revision}.`
        );
      }
      // Scope resolution is asynchronous. Revalidate both the revision and the
      // expiring owner-bound lease immediately before returning a dry run or
      // entering the mutation group.
      const commitLock = requireLock(String(params.owner), String(params.lockId));
      if (commitLock.inFlight) throw new Error('Workspace lock already has an active transaction.');
      if (params.dryRun !== false)
        return { dryRun: true, revision, operationCount: plan.length, plan };
      const results = [];
      commitLock.inFlight = true;
      try {
        figma.commitUndo();
        for (let index = 0; index < plan.length; index += 1) {
          const operation = plan[index];
          const response = await executeBase({
            ...operation,
            requestId: `${request.requestId}:${index}`,
          });
          if (response.error) throw new Error(`Batch operation ${index} failed: ${response.error}`);
          const itemErrors = Array.isArray(response.data?.results)
            ? response.data.results.filter((item: any) => item?.error)
            : [];
          if (itemErrors.length) {
            throw new Error(
              `Batch operation ${index} failed: ${itemErrors
                .map((item: any) => String(item.error))
                .join('; ')}`
            );
          }
          results.push(response.data);
        }
        figma.commitUndo();
      } catch (error) {
        figma.triggerUndo();
        throw new Error(
          `Batch rolled back: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      } finally {
        commitLock.inFlight = false;
        if (commitLock.expiresAt <= Date.now() && locks.get(commitLock.id) === commitLock) {
          locks.delete(commitLock.id);
        }
      }
      return {
        dryRun: false,
        committed: true,
        rollbackAvailableInFigma: true,
        startingRevision: params.expectedRevision,
        revision,
        results,
      };
    }
    default:
      throw new Error(`Unknown advanced request: ${request.type}`);
  }
}
