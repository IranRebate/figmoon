// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
function rgbaToHex(value) {
  if (!value || typeof value !== 'object' || !('r' in value)) return value;
  const channel = (part) =>
    Math.round(part * 255)
      .toString(16)
      .padStart(2, '0');
  const hex = `#${channel(value.r)}${channel(value.g)}${channel(value.b)}`;
  return value.a === undefined || value.a === 1 ? hex : `${hex}${channel(value.a)}`;
}

function serializeValue(value) {
  if (Array.isArray(value)) return value.map(serializeValue);
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'VARIABLE_ALIAS') return `{alias:${value.id}}`;
  if ('r' in value && 'g' in value && 'b' in value) return rgbaToHex(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, serializeValue(child)])
  );
}

function requiredMethod(owner, method, label) {
  const candidate = owner?.[method];
  if (typeof candidate !== 'function') {
    throw new Error(`${label} is unavailable. Update Figma Desktop and re-import Figmoon.`);
  }
  return candidate.bind(owner);
}

const byNameAndId = (left, right) =>
  left.name.localeCompare(right.name) || left.id.localeCompare(right.id);

export async function exportDesignSystem() {
  const fileKey =
    typeof figma.fileKey === 'string' && figma.fileKey.trim() ? figma.fileKey.trim() : null;
  if (!fileKey) throw new Error('Stable Figma file identity is unavailable.');
  await requiredMethod(figma, 'loadAllPagesAsync', 'Dynamic document loading')();
  const [collections, variables, paint, text, effect, grid] = await Promise.all([
    requiredMethod(figma.variables, 'getLocalVariableCollectionsAsync', 'Variable collections')(),
    requiredMethod(figma.variables, 'getLocalVariablesAsync', 'Variables')(),
    requiredMethod(figma, 'getLocalPaintStylesAsync', 'Paint styles')(),
    requiredMethod(figma, 'getLocalTextStylesAsync', 'Text styles')(),
    requiredMethod(figma, 'getLocalEffectStylesAsync', 'Effect styles')(),
    requiredMethod(figma, 'getLocalGridStylesAsync', 'Grid styles')(),
  ]);
  const nodes = requiredMethod(
    figma.root,
    'findAllWithCriteria',
    'Component traversal'
  )({ types: ['COMPONENT', 'COMPONENT_SET'] });
  const components = nodes.filter((node) => node.type === 'COMPONENT').sort(byNameAndId);
  const componentSets = nodes.filter((node) => node.type === 'COMPONENT_SET').sort(byNameAndId);
  const collectionById = new Map(collections.map((item) => [item.id, item]));
  return {
    format: 'figmoon-design-system/v1',
    exportedAt: new Date().toISOString(),
    document: { name: figma.root.name, id: fileKey },
    variableCollections: [...collections].sort(byNameAndId).map((item) => ({
      id: item.id,
      name: item.name,
      modes: item.modes,
      variableIds: item.variableIds,
    })),
    variables: [...variables].sort(byNameAndId).map((item) => ({
      id: item.id,
      name: item.name,
      collectionId: item.variableCollectionId,
      collectionName: collectionById.get(item.variableCollectionId)?.name ?? null,
      resolvedType: item.resolvedType,
      description: item.description,
      scopes: item.scopes,
      modes: Object.fromEntries(
        Object.entries(item.valuesByMode).map(([modeId, value]) => [
          collectionById
            .get(item.variableCollectionId)
            ?.modes.find((mode) => mode.modeId === modeId)?.name ?? modeId,
          serializeValue(value),
        ])
      ),
    })),
    components: components.map((item) => {
      const componentSetId = item.parent?.type === 'COMPONENT_SET' ? item.parent.id : null;
      return {
        id: item.id,
        key: item.key,
        name: item.name,
        description: item.description,
        componentSetId,
        properties: componentSetId === null ? (item.componentPropertyDefinitions ?? {}) : {},
      };
    }),
    componentSets: componentSets.map((item) => ({
      id: item.id,
      key: item.key,
      name: item.name,
      description: item.description,
      properties: item.componentPropertyDefinitions ?? {},
      variantGroupProperties: item.variantGroupProperties ?? {},
      componentIds: (item.children ?? [])
        .filter((child) => child.type === 'COMPONENT')
        .map((child) => child.id),
    })),
    styles: {
      paint: [...paint]
        .sort(byNameAndId)
        .map(({ id, key, name, description }) => ({ id, key, name, description })),
      text: [...text]
        .sort(byNameAndId)
        .map(
          ({
            id,
            key,
            name,
            description,
            fontName,
            fontSize,
            fontWeight,
            lineHeight,
            letterSpacing,
          }) => ({
            id,
            key,
            name,
            description,
            fontName,
            fontSize,
            fontWeight,
            lineHeight,
            letterSpacing,
          })
        ),
      effect: [...effect].sort(byNameAndId).map(({ id, key, name, description, effects }) => ({
        id,
        key,
        name,
        description,
        effects: serializeValue(effects),
      })),
      grid: [...grid].sort(byNameAndId).map(({ id, key, name, description, layoutGrids }) => ({
        id,
        key,
        name,
        description,
        layoutGrids: serializeValue(layoutGrids),
      })),
    },
  };
}
