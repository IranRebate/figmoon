import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const CODE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const CSS_EXTENSIONS = new Set(['.css', '.less', '.sass', '.scss']);
const TEXT_EXTENSIONS = new Set(['.graphql', '.gql', '.html', '.json', '.md', '.txt']);
const VISUAL_QA_FUNCTIONS = new Set(['getScenarioData', 'getVisualScenario', 'isVisualQA']);
const VISUAL_QA_STORAGE_KEYS = new Set(['VISUAL_QA', 'VISUAL_SCENARIO', 'VISUAL_SCENARIO_DATA']);
const VISUAL_QA_INFRASTRUCTURE_FILES = new Set([
  'client/e2e/fixtures/visual-data.ts',
  'client/e2e/helpers/setup.ts',
  'client/src/components/shared/VisualQABootstrap.tsx',
  'client/src/components/shared/VisualQAComponents.tsx',
  'client/src/lib/visualQA.ts',
  'client/src/lib/visualScenarios.ts',
  'client/src/test/visual-handlers.ts',
]);
const APPROVED_FOUNDATION_IMPORTS = new Set([
  '../../../../docs/design/figma/foundation/Blue.svg?url',
  '../../../../docs/design/figma/foundation/Typography_Secondary font.png?url',
]);
const STYLE_PROPERTIES = new Set(['className', 'cssText', 'style']);
const DOM_PROPERTIES = new Set([
  'checked',
  'disabled',
  'hidden',
  'innerHTML',
  'innerText',
  'open',
  'outerHTML',
  'selected',
  'src',
  'srcSet',
  'textContent',
  'value',
]);
const DOM_MUTATION_METHODS = new Set([
  'after',
  'append',
  'appendChild',
  'before',
  'insertAdjacentElement',
  'insertAdjacentHTML',
  'insertAdjacentText',
  'insertBefore',
  'prepend',
  'remove',
  'removeAttribute',
  'removeChild',
  'replaceChild',
  'replaceChildren',
  'replaceWith',
  'setAttribute',
  'setContent',
  'toggleAttribute',
  'write',
  'writeln',
]);
const CSSOM_MUTATION_METHODS = new Set([
  'addStyleTag',
  'deleteRule',
  'insertRule',
  'removeProperty',
  'replaceSync',
  'setProperty',
]);
const RENDERER_MUTATION_METHODS = new Set(['emulateMedia']);

function normalizeSlashes(value) {
  return value.split(sep).join('/');
}

function repoRelativePath(repoRoot, declaredPath) {
  const absolute = resolve(repoRoot, declaredPath);
  const repoRelative = relative(repoRoot, absolute);
  if (
    !repoRelative ||
    repoRelative === '..' ||
    repoRelative.startsWith(`..${sep}`) ||
    repoRelative.startsWith(sep)
  ) {
    return null;
  }
  return normalizeSlashes(repoRelative);
}

function isHarnessFile(file) {
  return file.startsWith('client/e2e/') || /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file);
}

function isReferencePath(value) {
  const normalized = value.replaceAll('\\', '/');
  return (
    /(?:^|\/)docs\/design\/figma(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)figma-refs(?:\/|$)/i.test(normalized) ||
    /\/images\/(?=[^\s"'`]*figma)(?=[^\s"'`]*(?:reference|snapshot|static))[^\s"'`]*/i.test(
      normalized
    )
  );
}

function isApprovedFoundationImport(file, value) {
  return (
    file === 'client/src/components/shared/VisualQAComponents.tsx' &&
    APPROVED_FOUNDATION_IMPORTS.has(value)
  );
}

function scriptKindFor(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.Unknown;
}

function propertyName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) {
    return node.expression.text;
  }
  return null;
}

function expressionMemberName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    return propertyName(expression.argumentExpression);
  }
  if (ts.isIdentifier(expression)) return expression.text;
  return null;
}

function assignmentOperator(kind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function lineText(source, sourceFile, node) {
  const position = node.getStart(sourceFile, false);
  const { line } = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    line: line + 1,
    text: source.split(/\r?\n/, line + 1)[line]?.trim() ?? node.getText(sourceFile).trim(),
  };
}

function findingAtNode(kind, file, source, sourceFile, node, detail) {
  return { kind, file, ...lineText(source, sourceFile, node), ...(detail ? { detail } : {}) };
}

function findingAtOffset(kind, file, source, offset, detail) {
  const before = source.slice(0, offset);
  const line = before.split(/\r?\n/).length;
  return {
    kind,
    file,
    line,
    text: source.split(/\r?\n/, line)[line - 1]?.trim() ?? '',
    ...(detail ? { detail } : {}),
  };
}

function nodeContainsVisualSignal(node, visualBindings, namespaceBindings) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (
      ts.isIdentifier(current) &&
      (visualBindings.has(current.text) ||
        current.text.replaceAll('_', '').toLowerCase().includes('visualqa'))
    ) {
      found = true;
      return;
    }
    if (
      ts.isPropertyAccessExpression(current) &&
      ts.isIdentifier(current.expression) &&
      namespaceBindings.has(current.expression.text) &&
      VISUAL_QA_FUNCTIONS.has(current.name.text)
    ) {
      found = true;
      return;
    }
    if (ts.isStringLiteralLike(current) && VISUAL_QA_STORAGE_KEYS.has(current.text)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function collectVisualBindings(sourceFile) {
  const visualBindings = new Set(VISUAL_QA_FUNCTIONS);
  const namespaceBindings = new Set();

  const inspectImports = (node) => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const moduleName = ts.isStringLiteralLike(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : '';
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (VISUAL_QA_FUNCTIONS.has(importedName)) visualBindings.add(element.name.text);
        }
      } else if (
        bindings &&
        ts.isNamespaceImport(bindings) &&
        /visualQA(?:\.[cm]?[jt]s)?$/.test(moduleName)
      ) {
        namespaceBindings.add(bindings.name.text);
      }
    }
    ts.forEachChild(node, inspectImports);
  };
  inspectImports(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    const inspectAliases = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        nodeContainsVisualSignal(node.initializer, visualBindings, namespaceBindings) &&
        !visualBindings.has(node.name.text)
      ) {
        visualBindings.add(node.name.text);
        changed = true;
      } else if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.body &&
        nodeContainsVisualSignal(node.body, visualBindings, namespaceBindings) &&
        !visualBindings.has(node.name.text)
      ) {
        visualBindings.add(node.name.text);
        changed = true;
      } else if (
        ts.isBinaryExpression(node) &&
        assignmentOperator(node.operatorToken.kind) &&
        ts.isIdentifier(node.left) &&
        nodeContainsVisualSignal(node.right, visualBindings, namespaceBindings) &&
        !visualBindings.has(node.left.text)
      ) {
        visualBindings.add(node.left.text);
        changed = true;
      }
      ts.forEachChild(node, inspectAliases);
    };
    inspectAliases(sourceFile);
  }
  return { visualBindings, namespaceBindings };
}

function collectDomAliases(sourceFile) {
  const styleAliases = new Set();
  const classListAliases = new Set();
  const datasetAliases = new Set();
  const aliasSets = new Map([
    ['style', styleAliases],
    ['classList', classListAliases],
    ['dataset', datasetAliases],
  ]);
  let changed = true;

  while (changed) {
    changed = false;
    const addAlias = (name, initializer) => {
      if (!ts.isIdentifier(name)) return;
      let owner = null;
      if (ts.isPropertyAccessExpression(initializer)) owner = initializer.name.text;
      else if (ts.isElementAccessExpression(initializer) && initializer.argumentExpression) {
        owner = propertyName(initializer.argumentExpression);
      } else if (ts.isIdentifier(initializer)) {
        for (const [kind, aliases] of aliasSets) {
          if (aliases.has(initializer.text)) owner = kind;
        }
      }
      const aliases = aliasSets.get(owner);
      if (aliases && !aliases.has(name.text)) {
        aliases.add(name.text);
        changed = true;
      }
    };
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) addAlias(node.name, node.initializer);
      if (
        ts.isBinaryExpression(node) &&
        assignmentOperator(node.operatorToken.kind) &&
        ts.isIdentifier(node.left)
      ) {
        addAlias(node.left, node.right);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { styleAliases, classListAliases, datasetAliases };
}

function expressionUsesAlias(expression, aliases, property) {
  if (ts.isIdentifier(expression) && aliases.has(expression.text)) return true;
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      expression.name.text === property ||
      expressionUsesAlias(expression.expression, aliases, property)
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    return (
      propertyName(expression.argumentExpression) === property ||
      expressionUsesAlias(expression.expression, aliases, property)
    );
  }
  return false;
}

function scanCode(file, source) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file)
  );
  const findings = [];
  const seen = new Set();
  const harness = isHarnessFile(file);
  const visualInfrastructure = VISUAL_QA_INFRASTRUCTURE_FILES.has(file);
  const { visualBindings, namespaceBindings } = collectVisualBindings(sourceFile);
  const { styleAliases, classListAliases, datasetAliases } = collectDomAliases(sourceFile);
  const add = (finding) => {
    const key = `${finding.kind}\n${finding.file}\n${finding.line}\n${finding.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push(finding);
    }
  };

  for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
    const offset = Math.max(0, diagnostic.start ?? 0);
    add(
      findingAtOffset(
        'target-source-parse-error',
        file,
        source,
        offset,
        ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
      )
    );
  }

  const visit = (node) => {
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
      isReferencePath(node.getText(sourceFile).replace(/^['"`]|['"`]$/g, ''))
    ) {
      const value = ts.isStringLiteralLike(node)
        ? node.text
        : node.getText(sourceFile).slice(1, -1);
      if (!isApprovedFoundationImport(file, value)) {
        add(findingAtNode('reference-image-substitution', file, source, sourceFile, node));
      }
    }

    if (!visualInfrastructure) {
      if (
        ts.isCallExpression(node) &&
        nodeContainsVisualSignal(node.expression, visualBindings, namespaceBindings)
      ) {
        add(findingAtNode('visual-qa-product-branch', file, source, sourceFile, node));
      } else if (
        (ts.isIfStatement(node) &&
          nodeContainsVisualSignal(node.expression, visualBindings, namespaceBindings)) ||
        (ts.isConditionalExpression(node) &&
          nodeContainsVisualSignal(node.condition, visualBindings, namespaceBindings)) ||
        (ts.isSwitchStatement(node) &&
          nodeContainsVisualSignal(node.expression, visualBindings, namespaceBindings)) ||
        (ts.isBinaryExpression(node) &&
          [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
          ].includes(node.operatorToken.kind) &&
          nodeContainsVisualSignal(node.left, visualBindings, namespaceBindings))
      ) {
        add(findingAtNode('visual-qa-product-branch', file, source, sourceFile, node));
      } else if (
        ts.isStringLiteralLike(node) &&
        VISUAL_QA_STORAGE_KEYS.has(node.text) &&
        !harness
      ) {
        add(findingAtNode('visual-qa-product-branch', file, source, sourceFile, node));
      }
    }

    if (harness && (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))) {
      if (propertyName(node.name) === 'mask') {
        add(findingAtNode('screenshot-mask', file, source, sourceFile, node));
      }
    }

    if (harness && ts.isBinaryExpression(node) && assignmentOperator(node.operatorToken.kind)) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
        const name = ts.isPropertyAccessExpression(left)
          ? left.name.text
          : propertyName(left.argumentExpression);
        const owner = left.expression;
        if (
          STYLE_PROPERTIES.has(name) ||
          expressionUsesAlias(owner, styleAliases, 'style') ||
          expressionUsesAlias(owner, classListAliases, 'classList') ||
          expressionUsesAlias(owner, datasetAliases, 'dataset')
        ) {
          add(findingAtNode('style-substitution', file, source, sourceFile, node));
        } else if (DOM_PROPERTIES.has(name)) {
          add(findingAtNode('dom-substitution', file, source, sourceFile, node));
        }
      }
    }

    if (harness && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const method = expressionMemberName(node);
      const receiver = node.expression;
      if (method === 'addStyleTag') {
        add(findingAtNode('style-substitution', file, source, sourceFile, node));
      } else if (RENDERER_MUTATION_METHODS.has(method)) {
        add(findingAtNode('renderer-substitution', file, source, sourceFile, node));
      } else if (method === 'addScriptTag' || DOM_MUTATION_METHODS.has(method)) {
        add(findingAtNode('dom-substitution', file, source, sourceFile, node));
      } else if (
        CSSOM_MUTATION_METHODS.has(method) ||
        expressionUsesAlias(receiver, styleAliases, 'style') ||
        expressionUsesAlias(receiver, classListAliases, 'classList')
      ) {
        add(findingAtNode('style-substitution', file, source, sourceFile, node));
      }
    }

    if (harness && ts.isCallExpression(node)) {
      const method = expressionMemberName(node.expression);
      const receiver =
        ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)
          ? node.expression.expression
          : null;
      if (method === 'addStyleTag') {
        add(findingAtNode('style-substitution', file, source, sourceFile, node));
      } else if (method === 'addScriptTag' || DOM_MUTATION_METHODS.has(method)) {
        add(findingAtNode('dom-substitution', file, source, sourceFile, node));
      } else if (
        CSSOM_MUTATION_METHODS.has(method) ||
        (receiver && expressionUsesAlias(receiver, styleAliases, 'style')) ||
        (receiver && expressionUsesAlias(receiver, classListAliases, 'classList'))
      ) {
        add(findingAtNode('style-substitution', file, source, sourceFile, node));
      } else if (
        method === 'assign' &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Object' &&
        node.arguments[0] &&
        (expressionUsesAlias(node.arguments[0], styleAliases, 'style') ||
          expressionUsesAlias(node.arguments[0], classListAliases, 'classList') ||
          expressionUsesAlias(node.arguments[0], datasetAliases, 'dataset'))
      ) {
        add(findingAtNode('style-substitution', file, source, sourceFile, node));
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function sourceWithoutBlockComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, ' '));
}

function scanText(file, source, { css = false } = {}) {
  const findings = [];
  const clean = sourceWithoutBlockComments(source);
  const referencePattern =
    /(?:^|\/)docs\/design\/figma(?:\/|$)|(?:^|\/)figma-refs(?:\/|$)|\/images\/(?=[^\s"'`]*figma)(?=[^\s"'`]*(?:reference|snapshot|static))[^\s"'`]*/gim;
  for (const match of clean.matchAll(referencePattern)) {
    findings.push(findingAtOffset('reference-image-substitution', file, source, match.index ?? 0));
  }
  if (css) {
    const visualSelector =
      /(?:^|[,{\s])(?:html)?\.visual-qa\b|\[(?:data-visual-qa|data-visual-scenario)(?:\]|\s*=)/i;
    const rulePattern = /([^{}]+)\{/g;
    for (const match of clean.matchAll(rulePattern)) {
      if (visualSelector.test(match[1])) {
        const selectorStart = Math.max(0, match[1].search(/\S/));
        findings.push(
          findingAtOffset(
            'visual-qa-style-substitution',
            file,
            source,
            (match.index ?? 0) + selectorStart
          )
        );
      }
    }
  }
  return findings;
}

function annotateException(finding, exceptionRegistry) {
  if (finding.kind === 'reference-image-substitution') {
    const exception = (exceptionRegistry.referenceImageExceptions ?? []).find(
      (candidate) =>
        candidate.file === finding.file &&
        Boolean(candidate.sourceContains) &&
        finding.text.includes(candidate.sourceContains)
    );
    if (!exception) return finding;
    return {
      ...finding,
      exceptionId: exception.id,
      category: 'intentional-design-deviation',
      rationale: exception.reason,
      reviewBy: exception.reviewBy,
      allowedByPolicy: true,
    };
  }
  const exception = (exceptionRegistry.exceptions ?? []).find(
    (candidate) => candidate.file === finding.file && candidate.source === finding.text
  );
  if (!exception) return finding;
  return {
    ...finding,
    exceptionId: exception.id,
    category: exception.category,
    rationale: exception.rationale,
    reviewBy: exception.reviewBy,
    allowedByPolicy: true,
  };
}

export function auditTargetMaskingFiles({ repoRoot, files, exceptionRegistry = {} }) {
  if (!repoRoot) throw new Error('Target masking audit requires repoRoot.');
  const findings = [];
  const inspectedFiles = [];
  const declaredFiles = [...new Set(files ?? [])].sort();

  for (const declaredPath of declaredFiles) {
    const file = repoRelativePath(repoRoot, declaredPath);
    if (!file) {
      findings.push({
        kind: 'target-source-path-invalid',
        file: String(declaredPath),
        line: 1,
        text: 'Target source path escapes or resolves to the repository root.',
      });
      continue;
    }
    const absolute = resolve(repoRoot, file);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
      findings.push({
        kind: 'target-source-unavailable',
        file,
        line: 1,
        text: 'Target source file is missing or is not a regular file.',
      });
      continue;
    }

    const extension = extname(file).toLowerCase();
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) {
      inspectedFiles.push({ file, scanner: 'binary' });
      continue;
    }
    const source = bytes.toString('utf8');
    if (CODE_EXTENSIONS.has(extension)) {
      inspectedFiles.push({ file, scanner: 'typescript-ast' });
      findings.push(...scanCode(file, source));
    } else if (CSS_EXTENSIONS.has(extension)) {
      inspectedFiles.push({ file, scanner: 'css' });
      findings.push(...scanText(file, source, { css: true }));
    } else {
      inspectedFiles.push({
        file,
        scanner: TEXT_EXTENSIONS.has(extension) ? 'structured-text' : 'text-fallback',
      });
      findings.push(...scanText(file, source));
    }
  }

  const uniqueFindings = new Map();
  for (const finding of findings) {
    const annotated = annotateException(finding, exceptionRegistry);
    const key = `${annotated.kind}\n${annotated.file}\n${annotated.line}\n${annotated.text}`;
    uniqueFindings.set(key, annotated);
  }
  return {
    inspectedFiles,
    findings: [...uniqueFindings.values()].sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.kind.localeCompare(right.kind)
    ),
  };
}
