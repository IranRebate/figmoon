const RAW_PATTERN_ROOT_TYPES = new Set(['FRAME', 'GROUP', 'SECTION']);
const AUTHORED_BOUNDARY_TYPES = new Set(['COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

const safeRead = (read, fallback = undefined) => {
  try {
    const value = read();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
};

const quantize = (value, precision = 100) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * precision) / precision
    : value;

const normalizeValue = (value, depth = 0) => {
  if (depth > 6 || value === undefined || typeof value === 'function') return undefined;
  if (typeof value === 'symbol') return 'mixed';
  if (typeof value === 'number') return quantize(value, 1000);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .flatMap((key) => {
          const normalized = normalizeValue(
            safeRead(() => value[key]),
            depth + 1
          );
          return normalized === undefined ? [] : [[key, normalized]];
        })
    );
  }
  return String(value);
};

const stableJson = (value) => JSON.stringify(normalizeValue(value));

const colorDescriptor = (color) =>
  color
    ? [
        quantize(color.r, 255),
        quantize(color.g, 255),
        quantize(color.b, 255),
        quantize(color.a ?? 1, 255),
      ]
    : undefined;

const paintDescriptor = (paints, includeContent) => {
  if (typeof paints === 'symbol') return 'mixed';
  if (!Array.isArray(paints)) return undefined;
  return paints
    .filter((paint) => paint?.visible !== false)
    .map((paint) => {
      if (paint.type === 'SOLID') {
        return ['SOLID', colorDescriptor(paint.color), quantize(paint.opacity ?? 1, 255)];
      }
      if (String(paint.type).startsWith('GRADIENT_')) {
        return [
          paint.type,
          (paint.gradientStops ?? []).map((stop) => [
            quantize(stop.position, 1000),
            colorDescriptor(stop.color),
          ]),
          quantize(paint.opacity ?? 1, 255),
        ];
      }
      if (paint.type === 'IMAGE') {
        // Image identity is content. Its paint role and fitting mode are template structure.
        return ['IMAGE', paint.scaleMode, includeContent ? paint.imageHash : undefined];
      }
      return [paint.type];
    });
};

const effectsDescriptor = (effects) => {
  if (!Array.isArray(effects)) return undefined;
  return effects
    .filter((effect) => effect?.visible !== false)
    .map((effect) => [
      effect.type,
      quantize(effect.radius),
      quantize(effect.spread),
      effect.offset ? [quantize(effect.offset.x), quantize(effect.offset.y)] : undefined,
      colorDescriptor(effect.color),
      effect.blendMode,
    ]);
};

const semanticBindings = (node) => {
  const styleFields = [
    'fillStyleId',
    'strokeStyleId',
    'textStyleId',
    'effectStyleId',
    'gridStyleId',
  ];
  const styleReferences = Object.fromEntries(
    styleFields.flatMap((field) => {
      if (!(field in node)) return [];
      const value = safeRead(() => node[field]);
      return value === undefined || value === ''
        ? []
        : [[field, typeof value === 'symbol' ? 'mixed' : value]];
    })
  );
  const boundVariables = safeRead(() => node.boundVariables);
  const explicitVariableModes = safeRead(() => node.explicitVariableModes);
  return {
    styleReferences: Object.keys(styleReferences).length ? styleReferences : undefined,
    boundVariables,
    explicitVariableModes,
    detachedInfo: safeRead(() => node.detachedInfo),
    variantProperties: safeRead(() => node.variantProperties),
  };
};

const componentPropertyShape = (properties) => {
  if (!properties || typeof properties !== 'object') return undefined;
  return Object.keys(properties)
    .sort()
    .map((key) => [key, safeRead(() => properties[key]?.type)]);
};

const componentPropertyContent = (properties) => {
  if (!properties || typeof properties !== 'object') return undefined;
  return Object.keys(properties)
    .sort()
    .map((key) => [
      key,
      safeRead(() => properties[key]?.type),
      safeRead(() => properties[key]?.value),
    ]);
};

const localDescriptor = (node, includeContent) => {
  const descriptor = {
    type: node.type,
    width: quantize(safeRead(() => node.width)),
    height: quantize(safeRead(() => node.height)),
    opacity: quantize(
      safeRead(() => node.opacity, 1),
      1000
    ),
    blendMode: safeRead(() => node.blendMode),
    rotation: quantize(safeRead(() => node.rotation, 0)),
    layout: {
      mode: safeRead(() => node.layoutMode),
      wrap: safeRead(() => node.layoutWrap),
      itemSpacing: quantize(safeRead(() => node.itemSpacing)),
      counterAxisSpacing: quantize(safeRead(() => node.counterAxisSpacing)),
      primaryAxisAlign: safeRead(() => node.primaryAxisAlignItems),
      counterAxisAlign: safeRead(() => node.counterAxisAlignItems),
      primaryAxisSizing: safeRead(() => node.primaryAxisSizingMode),
      counterAxisSizing: safeRead(() => node.counterAxisSizingMode),
      sizingHorizontal: safeRead(() => node.layoutSizingHorizontal),
      sizingVertical: safeRead(() => node.layoutSizingVertical),
      align: safeRead(() => node.layoutAlign),
      grow: quantize(safeRead(() => node.layoutGrow)),
      padding: [
        quantize(safeRead(() => node.paddingTop)),
        quantize(safeRead(() => node.paddingRight)),
        quantize(safeRead(() => node.paddingBottom)),
        quantize(safeRead(() => node.paddingLeft)),
      ],
      constraints: safeRead(() => node.constraints),
      clipsContent: safeRead(() => node.clipsContent),
    },
    visual: {
      fills: paintDescriptor(
        safeRead(() => node.fills),
        includeContent
      ),
      strokes: paintDescriptor(
        safeRead(() => node.strokes),
        includeContent
      ),
      strokeWeight: normalizeValue(safeRead(() => node.strokeWeight)),
      strokeAlign: safeRead(() => node.strokeAlign),
      cornerRadius: normalizeValue(safeRead(() => node.cornerRadius)),
      cornerRadii:
        'topLeftRadius' in node
          ? [
              quantize(safeRead(() => node.topLeftRadius)),
              quantize(safeRead(() => node.topRightRadius)),
              quantize(safeRead(() => node.bottomRightRadius)),
              quantize(safeRead(() => node.bottomLeftRadius)),
            ]
          : undefined,
      effects: effectsDescriptor(safeRead(() => node.effects)),
    },
    typography:
      node.type === 'TEXT'
        ? {
            fontName: normalizeValue(safeRead(() => node.fontName)),
            fontSize: normalizeValue(safeRead(() => node.fontSize)),
            fontWeight: normalizeValue(safeRead(() => node.fontWeight)),
            lineHeight: normalizeValue(safeRead(() => node.lineHeight)),
            letterSpacing: normalizeValue(safeRead(() => node.letterSpacing)),
            decoration: normalizeValue(safeRead(() => node.textDecoration)),
            horizontal: normalizeValue(safeRead(() => node.textAlignHorizontal)),
            vertical: normalizeValue(safeRead(() => node.textAlignVertical)),
            resize: normalizeValue(safeRead(() => node.textAutoResize)),
          }
        : undefined,
    semantics: semanticBindings(node),
  };

  if (AUTHORED_BOUNDARY_TYPES.has(node.type)) {
    descriptor.authored = {
      // Component/instance names are authored identifiers. Generic frame names are not.
      name: node.name,
      key: safeRead(() => node.key),
      remote: safeRead(() => node.remote),
      properties: includeContent
        ? componentPropertyContent(safeRead(() => node.componentProperties))
        : componentPropertyShape(safeRead(() => node.componentProperties)),
      definitions: componentPropertyShape(safeRead(() => node.componentPropertyDefinitions)),
    };
  }

  if (includeContent && node.type === 'TEXT') {
    descriptor.characters = safeRead(() => node.characters, '');
  }
  if (includeContent && (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION')) {
    const vectorContent = safeRead(() => node.vectorPaths) ?? safeRead(() => node.vectorNetwork);
    if (vectorContent) descriptor.vectorContentDigest = digest(stableJson(vectorContent));
  }
  return stableJson(descriptor);
};

const hash32 = (text, seed) => {
  let hash = (seed ^ text.length) >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x5bd1e995) >>> 0;
    hash ^= hash >>> 13;
  }
  hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca6b) >>> 0;
  return hash.toString(16).padStart(8, '0');
};

const digest = (text) => `${hash32(text, 0x9747b28c)}${hash32(text, 0x27d4eb2f)}`;

const intern = (table, key) => {
  const current = table.get(key);
  if (current !== undefined) return current;
  const next = table.size + 1;
  table.set(key, next);
  return next;
};

const assignCodes = (groups, prefix, digestKey) => {
  const lengths = new Map(groups.map((group) => [group.id, 8]));
  for (;;) {
    const byCode = new Map();
    for (const group of groups) {
      const length = lengths.get(group.id);
      const code = group[digestKey].slice(0, length);
      const bucket = byCode.get(code) ?? [];
      bucket.push(group);
      byCode.set(code, bucket);
    }
    let changed = false;
    for (const bucket of byCode.values()) {
      const fullDigests = new Set(bucket.map((group) => group[digestKey]));
      if (fullDigests.size <= 1) continue;
      for (const group of bucket) {
        const length = lengths.get(group.id);
        if (length < 16) lengths.set(group.id, length + 1);
      }
      changed = true;
    }
    if (!changed) break;
  }
  return new Map(
    groups.map((group) => [
      group.id,
      `${prefix}-${group[digestKey].slice(0, lengths.get(group.id)).toUpperCase()}`,
    ])
  );
};

const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

const topNames = (records, limit = 4) => {
  const names = new Map();
  for (const record of records) increment(names, record.name || '(unnamed)');
  return [...names.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
};

const unique = (values) => [...new Set(values)];

export const analyzeDesignPatterns = (root, options = {}) => {
  const minimumOccurrences = Math.max(2, Number(options.minimumOccurrences) || 2);
  const minimumSubtreeNodes = Math.max(2, Number(options.minimumSubtreeNodes) || 4);
  const maximumSubtreeNodes = Math.max(
    minimumSubtreeNodes,
    Number(options.maximumSubtreeNodes) || 250
  );
  const clusterLimit = Math.max(1, Math.min(Number(options.clusterLimit) || 50, 200));
  const variantLimit = Math.max(1, Math.min(Number(options.variantLimit) || 30, 100));
  const maximumScannedNodes = Math.max(1000, Number(options.maximumScannedNodes) || 100000);
  const includeHidden = options.includeHidden === true;

  const shapeIntern = new Map();
  const templateIntern = new Map();
  const contentIntern = new Map();
  const resultByNode = new Map();
  const rawParentByNode = new Map();
  const candidates = [];
  const typeCounts = new Map();
  const authoredNames = { COMPONENT: [], COMPONENT_SET: [] };
  const detachedNodes = [];
  let detachedNodeCount = 0;
  let scannedNodeCount = 0;

  const stack = [
    {
      node: root,
      exit: false,
      pageId: root.type === 'PAGE' ? root.id : undefined,
      pageName: root.type === 'PAGE' ? root.name : undefined,
      authoredAncestor: false,
      rawParent: undefined,
    },
  ];

  while (stack.length) {
    const entry = stack.pop();
    const { node } = entry;
    if (!node || (node.visible === false && !includeHidden)) continue;

    if (!entry.exit) {
      scannedNodeCount += 1;
      if (scannedNodeCount > maximumScannedNodes) {
        throw new Error(
          `Pattern analysis exceeded maximumScannedNodes (${maximumScannedNodes}). Narrow the page/node scope or raise the bound.`
        );
      }
      increment(typeCounts, String(node.type));
      if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
        if (authoredNames[node.type].length < 30) authoredNames[node.type].push(node.name);
      }
      const detachedInfo = safeRead(() => node.detachedInfo);
      if (detachedInfo) {
        detachedNodeCount += 1;
        if (detachedNodes.length < 100) {
          detachedNodes.push({ nodeId: node.id, name: node.name, detachedInfo });
        }
      }

      const pageId = node.type === 'PAGE' ? node.id : entry.pageId;
      const pageName = node.type === 'PAGE' ? node.name : entry.pageName;
      const isRawRoot = RAW_PATTERN_ROOT_TYPES.has(node.type);
      const isAuthoredBoundary = AUTHORED_BOUNDARY_TYPES.has(node.type);
      stack.push({ ...entry, exit: true, pageId, pageName });

      if (!isAuthoredBoundary && Array.isArray(node.children)) {
        const nextRawParent = isRawRoot ? node : entry.rawParent;
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          const child = node.children[index];
          if (isRawRoot) rawParentByNode.set(child, node);
          else if (entry.rawParent) rawParentByNode.set(child, entry.rawParent);
          stack.push({
            node: child,
            exit: false,
            pageId,
            pageName,
            authoredAncestor: entry.authoredAncestor || isAuthoredBoundary,
            rawParent: nextRawParent,
          });
        }
      }
      continue;
    }

    const childResults =
      !AUTHORED_BOUNDARY_TYPES.has(node.type) && Array.isArray(node.children)
        ? node.children.map((child) => resultByNode.get(child)).filter(Boolean)
        : [];
    const shapeLocal = stableJson(
      AUTHORED_BOUNDARY_TYPES.has(node.type) ? [node.type, node.name] : [node.type]
    );
    const templateLocal = localDescriptor(node, false);
    const contentLocal = localDescriptor(node, true);
    const shapeKey = `${shapeLocal}\u001f${childResults.map((child) => child.shapeId).join(',')}`;
    const templateKey = `${templateLocal}\u001f${childResults
      .map((child) => child.templateId)
      .join(',')}`;
    const contentKey = `${contentLocal}\u001f${childResults
      .map((child) => child.contentId)
      .join(',')}`;
    const ownText = node.type === 'TEXT' ? String(safeRead(() => node.characters, '')).trim() : '';
    const textSamples = unique([
      ...(ownText ? [ownText.slice(0, 160)] : []),
      ...childResults.flatMap((child) => child.textSamples),
    ]).slice(0, 4);
    const record = {
      node,
      id: node.id,
      name: node.name,
      type: node.type,
      pageId: entry.pageId,
      pageName: entry.pageName,
      shapeId: intern(shapeIntern, shapeKey),
      templateId: intern(templateIntern, templateKey),
      contentId: intern(contentIntern, contentKey),
      shapeDigest: digest(
        `${shapeLocal}|${childResults.map((child) => child.shapeDigest).join('.')}`
      ),
      templateDigest: digest(
        `${templateLocal}|${childResults.map((child) => child.templateDigest).join('.')}`
      ),
      subtreeNodeCount: 1 + childResults.reduce((sum, child) => sum + child.subtreeNodeCount, 0),
      textNodeCount:
        (node.type === 'TEXT' ? 1 : 0) +
        childResults.reduce((sum, child) => sum + child.textNodeCount, 0),
      vectorNodeCount:
        (node.type === 'VECTOR' ? 1 : 0) +
        childResults.reduce((sum, child) => sum + child.vectorNodeCount, 0),
      textSamples,
      authoredAncestor: entry.authoredAncestor,
    };
    resultByNode.set(node, record);

    if (
      RAW_PATTERN_ROOT_TYPES.has(node.type) &&
      !entry.authoredAncestor &&
      record.subtreeNodeCount >= minimumSubtreeNodes &&
      record.subtreeNodeCount <= maximumSubtreeNodes
    ) {
      candidates.push(record);
    }
  }

  const candidateByNode = new Map(candidates.map((candidate) => [candidate.node, candidate]));
  for (const candidate of candidates) {
    let parentNode = rawParentByNode.get(candidate.node);
    while (parentNode && !candidateByNode.has(parentNode))
      parentNode = rawParentByNode.get(parentNode);
    candidate.parentCandidate = parentNode ? candidateByNode.get(parentNode) : undefined;
  }

  const exactById = new Map();
  const shapeById = new Map();
  for (const candidate of candidates) {
    const exact = exactById.get(candidate.templateId) ?? [];
    exact.push(candidate);
    exactById.set(candidate.templateId, exact);
    const shape = shapeById.get(candidate.shapeId) ?? [];
    shape.push(candidate);
    shapeById.set(candidate.shapeId, shape);
  }

  const exactGroups = [...exactById.entries()].map(([id, records]) => ({
    id,
    records,
    templateDigest: records[0].templateDigest,
  }));
  const shapeGroups = [...shapeById.entries()].map(([id, records]) => ({
    id,
    records,
    shapeDigest: records[0].shapeDigest,
  }));
  const templateCodes = assignCodes(exactGroups, 'T', 'templateDigest');
  const shapeCodes = assignCodes(shapeGroups, 'S', 'shapeDigest');

  const repeatedTemplateIds = new Set(
    exactGroups
      .filter((group) => group.records.length >= minimumOccurrences)
      .map((group) => group.id)
  );

  const exactClusters = exactGroups
    .filter((group) => group.records.length >= minimumOccurrences)
    .map((group) => {
      const { records } = group;
      const pages = unique(records.map((record) => record.pageName).filter(Boolean));
      const contentVariantCount = new Set(records.map((record) => record.contentId)).size;
      const repeatedParents = records
        .map((record) => record.parentCandidate)
        .filter((parent) => parent && repeatedTemplateIds.has(parent.templateId));
      const contexts = unique(
        records.map((record) =>
          record.parentCandidate ? `T:${record.parentCandidate.templateId}` : 'ROOT'
        )
      );
      const vectorRatio =
        records[0].subtreeNodeCount > 0
          ? records[0].vectorNodeCount / records[0].subtreeNodeCount
          : 0;
      const nestedRatio = repeatedParents.length / records.length;
      const score =
        records.length *
        Math.log2(records[0].subtreeNodeCount + 1) *
        (1 + Math.log2(contexts.length + 1)) *
        (1 + Math.max(0, pages.length - 1) * 0.2) *
        (vectorRatio > 0.75 ? 0.25 : 1) *
        (1 - nestedRatio * 0.35);
      return {
        code: templateCodes.get(group.id),
        occurrenceCount: records.length,
        subtreeNodeCount: records[0].subtreeNodeCount,
        textNodeCount: records[0].textNodeCount,
        contentVariantCount,
        hasContentSlotEvidence: contentVariantCount > 1,
        pageNames: pages,
        contextCount: contexts.length,
        nestedInRepeatedPatternOccurrences: repeatedParents.length,
        vectorRatio: quantize(vectorRatio, 1000),
        names: topNames(records),
        samples: records.slice(0, 5).map((record) => ({
          nodeId: record.id,
          name: record.name,
          pageId: record.pageId,
          pageName: record.pageName,
          text: record.textSamples,
        })),
        score: quantize(score, 1000),
      };
    })
    .filter(
      (cluster) =>
        cluster.nestedInRepeatedPatternOccurrences < cluster.occurrenceCount ||
        cluster.contextCount >= 2
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.subtreeNodeCount - left.subtreeNodeCount ||
        right.occurrenceCount - left.occurrenceCount
    );

  const variantFamilies = shapeGroups
    .map((group) => {
      const templateIds = unique(group.records.map((record) => record.templateId));
      if (group.records.length < minimumOccurrences || templateIds.length < 2) return null;
      const pages = unique(group.records.map((record) => record.pageName).filter(Boolean));
      const score =
        group.records.length *
        Math.log2(Math.max(...group.records.map((record) => record.subtreeNodeCount)) + 1) *
        Math.log2(templateIds.length + 1) *
        (1 + Math.max(0, pages.length - 1) * 0.2);
      return {
        code: shapeCodes.get(group.id),
        occurrenceCount: group.records.length,
        templateVariantCount: templateIds.length,
        contentVariantCount: new Set(group.records.map((record) => record.contentId)).size,
        subtreeNodeCountRange: [
          Math.min(...group.records.map((record) => record.subtreeNodeCount)),
          Math.max(...group.records.map((record) => record.subtreeNodeCount)),
        ],
        pageNames: pages,
        names: topNames(group.records),
        templateVariants: templateIds
          .map((templateId) => ({
            code: templateCodes.get(templateId),
            occurrenceCount: exactById.get(templateId)?.length ?? 0,
          }))
          .sort((left, right) => right.occurrenceCount - left.occurrenceCount)
          .slice(0, 8),
        samples: group.records.slice(0, 5).map((record) => ({
          nodeId: record.id,
          name: record.name,
          pageId: record.pageId,
          pageName: record.pageName,
          templateCode: templateCodes.get(record.templateId),
        })),
        score: quantize(score, 1000),
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) => right.score - left.score || right.occurrenceCount - left.occurrenceCount
    );

  return {
    schemaVersion: 'figmoon-design-pattern-index/v1',
    summary: {
      scannedNodeCount,
      nodeTypeCounts: Object.fromEntries([...typeCounts.entries()].sort()),
      authoredComponentCount: typeCounts.get('COMPONENT') ?? 0,
      authoredComponentSetCount: typeCounts.get('COMPONENT_SET') ?? 0,
      authoredInstanceCount: typeCounts.get('INSTANCE') ?? 0,
      detachedNodeCount,
      rawCandidateCount: candidates.length,
      uniqueShapeSignatureCount: shapeIntern.size,
      uniqueTemplateSignatureCount: templateIntern.size,
      repeatedExactTemplateClusterCount: exactClusters.length,
      relaxedVariantFamilyCount: variantFamilies.length,
      returnedExactTemplateClusterCount: Math.min(clusterLimit, exactClusters.length),
      returnedVariantFamilyCount: Math.min(variantLimit, variantFamilies.length),
    },
    authoredModel: {
      componentSamples: unique(authoredNames.COMPONENT).slice(0, 20),
      componentSetSamples: unique(authoredNames.COMPONENT_SET).slice(0, 20),
      detachedNodeSamples: detachedNodes.slice(0, 20),
      note: 'Declared components and instances are authoritative boundaries and are treated as opaque leaves. Use get_components for their properties and main-component identity.',
    },
    exactTemplateClusters: exactClusters.slice(0, clusterLimit),
    relaxedVariantFamilies: variantFamilies.slice(0, variantLimit),
    method: {
      retained:
        'node type, ordered child structure, quantized geometry, auto-layout, constraints, visible paints/effects, typography, named-style references, and variable bindings',
      abstracted:
        'node IDs, absolute position, generic layer names, literal text, image identity, and vector paths are excluded from template equivalence but retained separately as content-variant evidence',
      codeContract:
        'T codes identify exact template-equivalence classes; S codes identify relaxed ordered-tree shapes. Equality uses collision-safe interned canonical signatures; the displayed hash prefix is only a compact label.',
      caveat:
        'A repeated tree is evidence for review, not proof of one product abstraction. Page role, interaction, responsive intent, visual similarity, and human confirmation remain required before refactoring.',
    },
  };
};
