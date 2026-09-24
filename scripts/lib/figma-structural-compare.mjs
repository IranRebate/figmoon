const DEFAULT_TOLERANCES = Object.freeze({
  geometry: 1,
  fontSize: 0.5,
  lineHeight: 1,
  letterSpacing: 0.25,
  opacity: 0.01,
  radius: 1,
});

const SEMANTIC_TAGS = new Set([
  'a',
  'button',
  'h1',
  'h2',
  'h3',
  'h4',
  'img',
  'input',
  'label',
  'li',
  'p',
  'select',
  'textarea',
]);

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(number) ? number : null;
}

function rounded(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function normalizeText(value) {
  return String(value ?? '')
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeColor(value) {
  if (!value || value === 'none' || value === 'transparent') return null;
  const input = String(value).trim().toLowerCase();
  const shortHex = input.match(/^#([0-9a-f]{3})$/i);
  if (shortHex) {
    return `#${shortHex[1]
      .split('')
      .map((entry) => `${entry}${entry}`)
      .join('')}`;
  }
  const hex = input.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  if (hex) return `#${hex[1]}`;
  const rgb = input.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d+(?:\.\d+)?%?))?\s*\)$/);
  if (!rgb) return input;
  const alpha = rgb[4]
    ? rgb[4].endsWith('%')
      ? Number.parseFloat(rgb[4]) / 100
      : Number.parseFloat(rgb[4])
    : 1;
  if (alpha === 0) return null;
  return `#${[rgb[1], rgb[2], rgb[3]]
    .map((entry) => Math.max(0, Math.min(255, Math.round(Number(entry)))).toString(16).padStart(2, '0'))
    .join('')}`;
}

function firstSolidPaint(paints) {
  if (!Array.isArray(paints)) return null;
  const paint = paints.find((entry) => entry?.type === 'SOLID' && (entry.opacity ?? 1) > 0);
  return paint ? normalizeColor(paint.color) : null;
}

function fontLineHeight(value, fontSize) {
  if (!value || value === 'mixed') return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return finiteNumber(value);
  if (value.unit === 'AUTO') return null;
  if (value.unit === 'PIXELS') return finiteNumber(value.value);
  if (value.unit === 'PERCENT' && fontSize !== null) return (fontSize * finiteNumber(value.value)) / 100;
  return finiteNumber(value.value);
}

function letterSpacing(value, fontSize) {
  if (!value || value === 'mixed') return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return finiteNumber(value);
  if (value.unit === 'PERCENT' && fontSize !== null) return (fontSize * finiteNumber(value.value)) / 100;
  return finiteNumber(value.value);
}

function normalizeRect(rect, rootRect = { x: 0, y: 0 }) {
  if (!rect) return null;
  const x = finiteNumber(rect.x);
  const y = finiteNumber(rect.y);
  const width = finiteNumber(rect.width);
  const height = finiteNumber(rect.height);
  if ([x, y, width, height].some((entry) => entry === null) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    x: rounded(x - (rootRect.x ?? 0)),
    y: rounded(y - (rootRect.y ?? 0)),
    width: rounded(width),
    height: rounded(height),
  };
}

function depthValue(path) {
  return path.split('.').length - 1;
}

function clipRect(rect, bounds) {
  const left = Math.max(rect.x, bounds.x);
  const top = Math.max(rect.y, bounds.y);
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
  if (right <= left || bottom <= top) return null;
  return {
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
  };
}

export function flattenFigmaTree(root) {
  if (!root?.bounds) throw new Error('Figma structural evidence requires root bounds.');
  const result = [];
  const visit = (node, parentKey, path, parentOrigin, ancestorHidden = false) => {
    if (!node || typeof node !== 'object') return;
    const hidden = ancestorHidden || node.styles?.visible === false || (node.styles?.opacity ?? 1) === 0;
    const localRect = normalizeRect(node.bounds);
    const rect = localRect
      ? path === '0'
        ? { ...localRect, x: 0, y: 0 }
        : {
            ...localRect,
            x: rounded(parentOrigin.x + localRect.x),
            y: rounded(parentOrigin.y + localRect.y),
          }
      : null;
    if (!hidden && rect) {
      const fontSize = finiteNumber(node.styles?.fontSize);
      const key = node.id ?? `figma:${path}`;
      result.push({
        key,
        parentKey,
        path,
        depth: depthValue(path),
        id: node.id ?? null,
        name: node.name ?? null,
        type: node.type ?? null,
        text: node.type === 'TEXT' ? normalizeText(node.characters) : '',
        rect,
        style: {
          color: firstSolidPaint(node.styles?.fills),
          backgroundColor: node.type === 'TEXT' ? null : firstSolidPaint(node.styles?.fills),
          borderColor: firstSolidPaint(node.styles?.strokes),
          borderWidth: finiteNumber(node.styles?.strokeWeight),
          borderRadius:
            finiteNumber(node.styles?.cornerRadius) ??
            (node.styles?.cornerRadii
              ? Math.max(...Object.values(node.styles.cornerRadii).map((entry) => finiteNumber(entry) ?? 0))
              : null),
          fontFamily: node.styles?.fontFamily && node.styles.fontFamily !== 'mixed' ? node.styles.fontFamily : null,
          fontSize,
          fontWeight: finiteNumber(node.styles?.fontWeight),
          lineHeight: fontLineHeight(node.styles?.lineHeight, fontSize),
          letterSpacing: letterSpacing(node.styles?.letterSpacing, fontSize),
          opacity: finiteNumber(node.styles?.opacity) ?? 1,
          display: node.styles?.autoLayout?.direction ?? null,
          gap: finiteNumber(node.styles?.autoLayout?.gap),
          padding: node.styles?.padding ?? null,
          textAlign: node.styles?.textAlignHorizontal ?? null,
        },
        raw: node,
      });
    }
    const nextParent = rect && !hidden ? node.id ?? `figma:${path}` : parentKey;
    const nextOrigin = rect ? { x: rect.x, y: rect.y } : parentOrigin;
    (node.children ?? []).forEach((child, index) =>
      visit(child, nextParent, `${path}.${index}`, nextOrigin, hidden)
    );
  };
  visit(root, null, '0', { x: 0, y: 0 });
  const captureBounds = {
    x: 0,
    y: 0,
    width: finiteNumber(root.bounds.width),
    height: finiteNumber(root.bounds.height),
  };
  return result
    .map((entry) => ({ ...entry, rect: clipRect(entry.rect, captureBounds) }))
    .filter((entry) => entry.rect);
}

function cleanBrowserStyle(style = {}) {
  return {
    color: normalizeColor(style.color),
    backgroundColor: normalizeColor(style.backgroundColor),
    borderColor: normalizeColor(style.borderColor),
    borderWidth: finiteNumber(style.borderWidth),
    borderRadius: finiteNumber(style.borderRadius),
    fontFamily: style.fontFamily ? String(style.fontFamily).split(',')[0].replace(/["']/g, '').trim() : null,
    fontSize: finiteNumber(style.fontSize),
    fontWeight: finiteNumber(style.fontWeight),
    lineHeight: finiteNumber(style.lineHeight),
    letterSpacing: finiteNumber(style.letterSpacing),
    opacity: finiteNumber(style.opacity) ?? 1,
    display: style.display ?? null,
    gap: finiteNumber(style.gap),
    padding: style.padding
      ? {
          top: finiteNumber(style.padding.top),
          right: finiteNumber(style.padding.right),
          bottom: finiteNumber(style.padding.bottom),
          left: finiteNumber(style.padding.left),
        }
      : null,
    textAlign: style.textAlign ?? null,
    boxShadow: style.boxShadow ?? null,
    outline: style.outline ?? null,
    outlineOffset: style.outlineOffset ?? null,
    visibility: style.visibility ?? null,
  };
}

export function flattenBrowserTree(evidence) {
  if (!evidence?.captureRect || !Array.isArray(evidence.elements)) {
    throw new Error('Browser structural evidence is missing captureRect/elements.');
  }
  return evidence.elements
    .map((element, index) => ({
      key: element.key ?? `browser:${index}`,
      parentKey: element.parentKey ?? null,
      path: element.path ?? String(index),
      depth: element.depth ?? depthValue(element.path ?? String(index)),
      tag: element.tag ?? null,
      role: element.role ?? null,
      testId: element.testId ?? null,
      owner: element.owner ?? null,
      name: element.name ?? null,
      accessibleName: element.accessibleName ?? null,
      type: element.inputType ?? null,
      text: normalizeText(element.text),
      rect: normalizeRect(element.rect),
      style: cleanBrowserStyle(element.style),
      reactStack: element.reactStack ?? [],
      sourceCandidates: element.sourceCandidates ?? [],
      raw: element,
    }))
    .filter((element) => element.rect);
}

function area(rect) {
  return rect.width * rect.height;
}

function intersectionArea(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

function rectIou(left, right) {
  const intersection = intersectionArea(left, right);
  const union = area(left) + area(right) - intersection;
  return union > 0 ? intersection / union : 0;
}

function geometryDistance(left, right, rootWidth, rootHeight) {
  const scaleX = Math.max(rootWidth, 1);
  const scaleY = Math.max(rootHeight, 1);
  return (
    Math.abs(left.x - right.x) / scaleX +
    Math.abs(left.y - right.y) / scaleY +
    Math.abs(left.width - right.width) / scaleX +
    Math.abs(left.height - right.height) / scaleY
  );
}

function kindCompatibility(figma, browser) {
  if (figma.type === 'TEXT') return browser.text ? 1 : 0;
  if (figma.type === 'INSTANCE' || figma.type === 'COMPONENT' || figma.type === 'COMPONENT_SET') {
    return browser.owner || browser.testId ? 0.9 : 0.55;
  }
  if (['RECTANGLE', 'ELLIPSE', 'VECTOR', 'LINE', 'BOOLEAN_OPERATION'].includes(figma.type)) {
    return ['img', 'svg', 'path', 'button'].includes(browser.tag) ? 0.75 : 0.35;
  }
  return 0.6;
}

function candidateScore(figma, browser, rootBounds) {
  const textExact = figma.text && browser.text && figma.text === browser.text;
  const textPartial =
    figma.text && browser.text && (figma.text.includes(browser.text) || browser.text.includes(figma.text));
  const iou = rectIou(figma.rect, browser.rect);
  const distance = geometryDistance(figma.rect, browser.rect, rootBounds.width, rootBounds.height);
  const sizeSimilarity = Math.max(
    0,
    1 -
      (Math.abs(figma.rect.width - browser.rect.width) / Math.max(figma.rect.width, browser.rect.width, 1) +
        Math.abs(figma.rect.height - browser.rect.height) / Math.max(figma.rect.height, browser.rect.height, 1)) /
        2
  );
  const styleMatches = [
    figma.style.color && browser.style.color && figma.style.color === browser.style.color,
    figma.style.backgroundColor &&
      browser.style.backgroundColor &&
      figma.style.backgroundColor === browser.style.backgroundColor,
    figma.style.fontSize !== null &&
      browser.style.fontSize !== null &&
      Math.abs(figma.style.fontSize - browser.style.fontSize) <= 0.5,
  ].filter(Boolean).length;
  const identity = [browser.owner, browser.testId, browser.name]
    .filter(Boolean)
    .map((entry) => normalizeText(entry).toLowerCase());
  const figmaIdentity = normalizeText(figma.name).toLowerCase();
  const identityMatch = figmaIdentity && identity.some((entry) => entry.includes(figmaIdentity) || figmaIdentity.includes(entry));
  const score =
    (textExact ? 0.48 : textPartial ? 0.28 : 0) +
    (identityMatch ? 0.22 : 0) +
    iou * 0.18 +
    sizeSimilarity * 0.08 +
    kindCompatibility(figma, browser) * 0.06 +
    styleMatches * 0.025 -
    Math.min(distance, 1) * 0.14;
  return {
    score: Math.max(0, Math.min(1, score)),
    textExact,
    identityMatch,
    iou,
    distance,
  };
}

function browserEligible(element) {
  return Boolean(
    element.text ||
      element.role ||
      element.testId ||
      element.owner ||
      SEMANTIC_TAGS.has(element.tag) ||
      element.style.backgroundColor ||
      element.style.borderColor
  );
}

function figmaEligible(element) {
  return Boolean(
    element.type === 'TEXT' ||
      ['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(element.type) ||
      element.style.backgroundColor ||
      element.style.borderColor
  );
}

function matchConfidence(score, gap) {
  if (score >= 0.88 && gap >= 0.12) return 'exact';
  if (score >= 0.68 && gap >= 0.08) return 'high';
  if (score >= 0.5 && gap >= 0.04) return 'medium';
  return 'low';
}

export function matchStructuralElements(figmaElements, browserElements, rootBounds) {
  const candidates = [];
  for (const figma of figmaElements.filter(figmaEligible)) {
    for (const browser of browserElements.filter(browserEligible)) {
      const score = candidateScore(figma, browser, rootBounds);
      if (score.score >= 0.24) candidates.push({ figma, browser, ...score });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const usedFigma = new Set();
  const usedBrowser = new Set();
  const matches = [];
  for (const candidate of candidates) {
    if (usedFigma.has(candidate.figma.key) || usedBrowser.has(candidate.browser.key)) continue;
    const alternatives = candidates
      .filter(
        (entry) =>
          entry.figma.key === candidate.figma.key &&
          entry.browser.key !== candidate.browser.key &&
          !usedBrowser.has(entry.browser.key)
      )
      .slice(0, 2);
    const gap = candidate.score - (alternatives[0]?.score ?? 0);
    if (candidate.score < 0.34) continue;
    usedFigma.add(candidate.figma.key);
    usedBrowser.add(candidate.browser.key);
    matches.push({
      figma: candidate.figma,
      browser: candidate.browser,
      score: rounded(candidate.score),
      confidence: matchConfidence(candidate.score, gap),
      ambiguous: gap < 0.04,
      signals: {
        textExact: candidate.textExact,
        identityMatch: candidate.identityMatch,
        intersectionOverUnion: rounded(candidate.iou),
        normalizedGeometryDistance: rounded(candidate.distance),
        nextBestGap: rounded(gap),
      },
      alternatives: alternatives.map((entry) => ({
        browserKey: entry.browser.key,
        text: entry.browser.text,
        score: rounded(entry.score),
      })),
    });
  }
  return {
    matches,
    unmatchedFigma: figmaElements.filter(figmaEligible).filter((entry) => !usedFigma.has(entry.key)),
    unmatchedBrowser: browserElements.filter(browserEligible).filter((entry) => !usedBrowser.has(entry.key)),
  };
}

function compareNumber(name, left, right, tolerance, output) {
  if (left === null || right === null) return;
  const delta = rounded(right - left);
  if (Math.abs(delta) > tolerance) {
    output.push({ property: name, figma: left, browser: right, delta, tolerance });
  }
}

function compareExact(name, left, right, output) {
  if (left === null || right === null || left === '' || right === '') return;
  if (String(left).toLowerCase() !== String(right).toLowerCase()) {
    output.push({ property: name, figma: left, browser: right });
  }
}

function comparePadding(figma, browser, output, tolerance) {
  if (!figma || !browser) return;
  for (const side of ['top', 'right', 'bottom', 'left']) {
    compareNumber(`padding.${side}`, finiteNumber(figma[side]), finiteNumber(browser[side]), tolerance, output);
  }
}

function comparePair(match, tolerances) {
  const geometry = [];
  const visual = [];
  const content = [];
  for (const key of ['x', 'y', 'width', 'height']) {
    compareNumber(`rect.${key}`, match.figma.rect[key], match.browser.rect[key], tolerances.geometry, geometry);
  }
  if (match.figma.text && match.browser.text && match.figma.text !== match.browser.text) {
    content.push({ property: 'text', figma: match.figma.text, browser: match.browser.text });
  }
  compareExact('color', match.figma.style.color, match.browser.style.color, visual);
  compareExact(
    'backgroundColor',
    match.figma.style.backgroundColor,
    match.browser.style.backgroundColor,
    visual
  );
  compareExact('borderColor', match.figma.style.borderColor, match.browser.style.borderColor, visual);
  compareExact('fontFamily', match.figma.style.fontFamily, match.browser.style.fontFamily, visual);
  compareExact('textAlign', match.figma.style.textAlign, match.browser.style.textAlign?.toUpperCase?.(), visual);
  compareNumber('borderWidth', match.figma.style.borderWidth, match.browser.style.borderWidth, tolerances.geometry, visual);
  compareNumber('borderRadius', match.figma.style.borderRadius, match.browser.style.borderRadius, tolerances.radius, visual);
  compareNumber('fontSize', match.figma.style.fontSize, match.browser.style.fontSize, tolerances.fontSize, visual);
  compareNumber('fontWeight', match.figma.style.fontWeight, match.browser.style.fontWeight, 50, visual);
  compareNumber('lineHeight', match.figma.style.lineHeight, match.browser.style.lineHeight, tolerances.lineHeight, visual);
  compareNumber(
    'letterSpacing',
    match.figma.style.letterSpacing,
    match.browser.style.letterSpacing,
    tolerances.letterSpacing,
    visual
  );
  compareNumber('opacity', match.figma.style.opacity, match.browser.style.opacity, tolerances.opacity, visual);
  compareNumber('gap', match.figma.style.gap, match.browser.style.gap, tolerances.geometry, visual);
  comparePadding(match.figma.style.padding, match.browser.style.padding, visual, tolerances.geometry);
  return { geometry, visual, content };
}

function authoritySignals(item, productDecisions = []) {
  const recordedDecisions = [item?.designDecision, ...productDecisions].filter(Boolean);
  const hasOpenDecision = recordedDecisions.some((decision) => decision.status === 'open');
  const text = normalizeText(
    `${item?.notes ?? ''} ${recordedDecisions.map((decision) => decision.reason ?? '').join(' ')}`
  ).toLowerCase();
  return {
    blocking:
      item?.referenceStatus !== 'mapped' ||
      item?.parityStatus === 'not-comparable' ||
      hasOpenDecision,
    terminal: item?.referenceStatus !== 'mapped' || hasOpenDecision,
    conflict:
      hasOpenDecision ||
      /(conflict|forbidden|safety regression|must remain|must not|intentional|تعارض|ایمنی|نباید)/i.test(text),
    source:
      recordedDecisions.find((decision) => decision.status === 'open')?.reason ||
      recordedDecisions[0]?.reason ||
      item?.notes ||
      null,
  };
}

export function workflowForComparison(authority, counts) {
  const authorityConflict = counts['product-authority-conflict'] > 0;

  if (authorityConflict || authority.blocking) {
    const terminalBlocker = authorityConflict || authority.terminal;
    return {
      workflowLane: 'authority-remediation',
      measurementAllowed: false,
      terminalBlocker,
      requiredAction: terminalBlocker
        ? 'Resolve the qualified reference, mapping, or recorded product-authority decision. Raster measurement remains closed until one valid production state is authoritative.'
        : 'Continue the task by rendering and inspecting the exact qualified route/state and resolving element identity or mapping. Rerun figma:inspect before CSS or raster measurement.',
    };
  }

  if (counts['content-difference'] > 0) {
    return {
      workflowLane: 'content-remediation',
      measurementAllowed: false,
      terminalBlocker: false,
      requiredAction:
        'Continue the task: render the qualified Figma records, order, dates, values, and copy through production props/state/store or a production-valid API-shaped fixture. If the view cannot express that valid state, extend its real component model or separate ConnectedContainer from PureView. Rerun figma:inspect until content-difference is zero.',
    };
  }

  if (counts['state/mapping-difference'] > 0) {
    return {
      workflowLane: 'authority-remediation',
      measurementAllowed: false,
      terminalBlocker: false,
      requiredAction:
        'Continue the task by rendering and inspecting the exact qualified route/state and resolving element identity or mapping. Rerun figma:inspect before CSS or raster measurement.',
    };
  }

  return {
    workflowLane: 'visual-remediation',
    measurementAllowed: true,
    terminalBlocker: false,
    requiredAction:
      'Content, state, and mapping are comparable. Treat any unresolved non-content elements as visual identity or geometry work, fix one bounded production visual cause, rerun structural inspection, then use pixel and edge measurement as confirmation.',
  };
}

export function compareStructuralEvidence({
  figma,
  browser,
  item,
  productDecisions = [],
  tolerances = {},
}) {
  const effectiveTolerances = { ...DEFAULT_TOLERANCES, ...tolerances };
  const figmaElements = flattenFigmaTree(figma);
  const browserElements = flattenBrowserTree(browser);
  const rootBounds = { width: figma.bounds.width, height: figma.bounds.height };
  const matching = matchStructuralElements(figmaElements, browserElements, rootBounds);
  const authority = authoritySignals(item, productDecisions);
  const findings = matching.matches.map((match) => {
    const differences = comparePair(match, effectiveTolerances);
    let classification = 'match';
    if (differences.content.length) {
      classification = authority.conflict ? 'product-authority-conflict' : 'content-difference';
    } else if (differences.geometry.length || differences.visual.length) {
      classification = 'visual-difference';
    }
    if (match.ambiguous && classification === 'match') classification = 'unresolved';
    return {
      classification,
      match: {
        confidence: match.confidence,
        score: match.score,
        ambiguous: match.ambiguous,
        signals: match.signals,
        alternatives: match.alternatives,
      },
      figma: {
        key: match.figma.key,
        id: match.figma.id,
        name: match.figma.name,
        type: match.figma.type,
        text: match.figma.text,
        rect: match.figma.rect,
      },
      browser: {
        key: match.browser.key,
        tag: match.browser.tag,
        role: match.browser.role,
        testId: match.browser.testId,
        owner: match.browser.owner,
        text: match.browser.text,
        rect: match.browser.rect,
        style: match.browser.style,
        reactStack: match.browser.reactStack,
        sourceCandidates: match.browser.sourceCandidates,
      },
      differences,
      authority: classification === 'product-authority-conflict' ? authority.source : null,
    };
  });
  const unmatchedFigmaFindings = matching.unmatchedFigma.map((entry) => {
      const sameRectBrowser = matching.unmatchedBrowser
        .filter((browserEntry) => rectIou(entry.rect, browserEntry.rect) >= 0.6)
        .sort((left, right) => rectIou(entry.rect, right.rect) - rectIou(entry.rect, left.rect))[0];
      const nearbyTextBrowser = entry.text
        ? matching.unmatchedBrowser
            .filter((browserEntry) => {
              if (!browserEntry.text) return false;
              const verticalGap = Math.abs(
                entry.rect.y + entry.rect.height / 2 -
                  (browserEntry.rect.y + browserEntry.rect.height / 2)
              );
              const horizontalGap = Math.abs(
                entry.rect.x + entry.rect.width / 2 -
                  (browserEntry.rect.x + browserEntry.rect.width / 2)
              );
              return (
                verticalGap <= Math.max(entry.rect.height, browserEntry.rect.height, 20) &&
                horizontalGap <= 180 &&
                browserEntry.rect.width >= entry.rect.width * 0.45 &&
                browserEntry.rect.width <= Math.max(entry.rect.width * 3, 180)
              );
            })
            .sort((left, right) => {
              const leftDistance =
                Math.abs(entry.rect.x - left.rect.x) + Math.abs(entry.rect.y - left.rect.y);
              const rightDistance =
                Math.abs(entry.rect.x - right.rect.x) + Math.abs(entry.rect.y - right.rect.y);
              return leftDistance - rightDistance;
            })[0]
        : null;
      const browserCandidate = sameRectBrowser ?? nearbyTextBrowser;
      const contentMismatch = Boolean(entry.text && entry.text !== browserCandidate?.text);
      return {
        classification:
          contentMismatch && authority.conflict
            ? 'product-authority-conflict'
            : authority.blocking
              ? 'state/mapping-difference'
              : contentMismatch
                ? 'content-difference'
                : 'unresolved',
        figma: {
          key: entry.key,
          id: entry.id,
          name: entry.name,
          type: entry.type,
          text: entry.text,
          rect: entry.rect,
        },
        browser: browserCandidate
          ? {
              key: browserCandidate.key,
              tag: browserCandidate.tag,
              role: browserCandidate.role,
              testId: browserCandidate.testId,
              owner: browserCandidate.owner,
              text: browserCandidate.text,
              rect: browserCandidate.rect,
              style: browserCandidate.style,
              reactStack: browserCandidate.reactStack,
              sourceCandidates: browserCandidate.sourceCandidates,
            }
          : null,
        differences: {
          geometry: [],
          visual: [],
          content: contentMismatch
            ? [{ property: 'text', figma: entry.text, browser: browserCandidate?.text ?? null }]
            : [],
        },
        authority:
          contentMismatch && authority.conflict
            ? authority.source
            : authority.blocking
              ? authority.source
              : null,
      };
    });
  const associatedBrowserKeys = new Set(
    unmatchedFigmaFindings.map((finding) => finding.browser?.key).filter(Boolean)
  );
  findings.push(
    ...unmatchedFigmaFindings,
    ...matching.unmatchedBrowser
      .filter((entry) => !associatedBrowserKeys.has(entry.key))
      .map((entry) => {
        const contentMismatch = Boolean(entry.text);
        return {
          classification:
            contentMismatch && authority.conflict
              ? 'product-authority-conflict'
              : authority.blocking
                ? 'state/mapping-difference'
                : contentMismatch
                  ? 'content-difference'
                  : 'unresolved',
          figma: null,
          browser: {
            key: entry.key,
            tag: entry.tag,
            role: entry.role,
            testId: entry.testId,
            owner: entry.owner,
            text: entry.text,
            rect: entry.rect,
            style: entry.style,
            reactStack: entry.reactStack,
            sourceCandidates: entry.sourceCandidates,
          },
          differences: {
            geometry: [],
            visual: [],
            content: contentMismatch
              ? [{ property: 'text', figma: null, browser: entry.text }]
              : [],
          },
          authority:
            contentMismatch && authority.conflict
              ? authority.source
              : authority.blocking
                ? authority.source
                : null,
        };
      })
  );
  const counts = Object.fromEntries(
    [
      'match',
      'visual-difference',
      'content-difference',
      'state/mapping-difference',
      'product-authority-conflict',
      'unresolved',
    ].map((classification) => [
      classification,
      findings.filter((finding) => finding.classification === classification).length,
    ])
  );
  const workflow = workflowForComparison(authority, counts);
  return {
    schemaVersion: 2,
    tolerances: effectiveTolerances,
    workflow,
    authority: {
      blocking: authority.blocking || counts['product-authority-conflict'] > 0,
      reason: authority.source,
    },
    summary: {
      figmaElements: figmaElements.length,
      browserElements: browserElements.length,
      matchedPairs: matching.matches.length,
      unmatchedFigma: matching.unmatchedFigma.length,
      unmatchedBrowser: matching.unmatchedBrowser.length,
      counts,
    },
    findings,
  };
}
