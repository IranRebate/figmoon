export const FIGMA_PROJECT_BY_VIEWPORT = Object.freeze({
  desktop: 'desktop',
  mobile: 'mobile',
  'tablet-landscape': 'tablet-landscape',
  'tablet-portrait': 'tablet-portrait',
});

export function visualProjectForTarget(item) {
  const viewportProject = FIGMA_PROJECT_BY_VIEWPORT[item?.viewport];
  if (item?.kind === 'component' && viewportProject === 'mobile') return 'mobile-components';
  return viewportProject ?? null;
}
