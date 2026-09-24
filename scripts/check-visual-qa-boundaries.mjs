#!/usr/bin/env node

import ts from 'typescript';
import Ajv2020 from 'ajv/dist/2020.js';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getFigmoonConfig } from '../lib/config.mjs';
const __figmoonConfig = getFigmoonConfig();
const clientRoot = __figmoonConfig.clientRoot;
const repoRoot = __figmoonConfig.consumerRoot;
const sourceRoot = resolve(clientRoot, 'src');
const policyPath = __figmoonConfig.visualQaPolicyPath;
const policySchemaPath = __figmoonConfig.visualQaPolicySchemaPath;
const today = new Date().toISOString().slice(0, 10);
const reportOnly = process.argv.includes('--report');
const jsonOnly = process.argv.includes('--json');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(dir, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    })
  );
  return nested.flat();
}

function repoPath(path) {
  return relative(repoRoot, path).split('\\').join('/');
}

function isVisualQaModule(specifier) {
  return /(?:^|\/)visualQA(?:\.[cm]?[jt]sx?)?$/.test(specifier);
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function importedBindings(sourceFile) {
  const bindings = new Map();
  const reExports = [];
  const dynamicImports = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        isVisualQaModule(statement.moduleSpecifier.text)
      ) {
        reExports.push({
          line: lineOf(sourceFile, statement),
          text: statement.getText(sourceFile).trim(),
        });
      }
      continue;
    }
    if (!isVisualQaModule(statement.moduleSpecifier.text)) continue;

    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) bindings.set(clause.name.text, 'default');
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, '*');
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        bindings.set(element.name.text, (element.propertyName ?? element.name).text);
      }
    }
  }

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      isVisualQaModule(node.arguments[0].text)
    ) {
      dynamicImports.push({
        line: lineOf(sourceFile, node),
        specifier: node.arguments[0].text,
        kind: 'dynamic import()',
      });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      isVisualQaModule(node.arguments[0].text)
    ) {
      dynamicImports.push({
        line: lineOf(sourceFile, node),
        specifier: node.arguments[0].text,
        kind: 'require()',
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { bindings, reExports, dynamicImports };
}

function referenceModuleSpecifiers(sourceFile, prohibitedReferences) {
  const references = [];
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      prohibitedReferences.some((value) => statement.moduleSpecifier.text.includes(value))
    ) {
      references.push({
        line: lineOf(sourceFile, statement),
        specifier: statement.moduleSpecifier.text,
      });
    }
  }
  return references;
}

function expressionUsesKnownName(node, known) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (ts.isIdentifier(child) && known.has(child.text)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function resolveAliases(sourceFile, imported) {
  const known = new Set(imported.keys());
  let changed = true;
  while (changed) {
    changed = false;
    const addBindingNames = (name) => {
      if (ts.isIdentifier(name)) {
        if (known.has(name.text)) return;
        known.add(name.text);
        changed = true;
        return;
      }
      if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
        for (const element of name.elements) {
          if (ts.isBindingElement(element)) addBindingNames(element.name);
        }
      }
    };
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        expressionUsesKnownName(node.initializer, known)
      ) {
        addBindingNames(node.name);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return known;
}

function resolveCallableAliases(sourceFile, imported) {
  const known = new Set(imported.keys());
  let changed = true;

  while (changed) {
    changed = false;
    const addBindingNames = (name) => {
      if (ts.isIdentifier(name)) {
        if (known.has(name.text)) return;
        known.add(name.text);
        changed = true;
        return;
      }
      if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
        for (const element of name.elements) {
          if (ts.isBindingElement(element)) addBindingNames(element.name);
        }
      }
    };
    const isCallableAlias = (expression) => {
      if (ts.isIdentifier(expression)) return known.has(expression.text);
      return (
        ts.isPropertyAccessExpression(expression) &&
        expressionUsesKnownName(expression.expression, known)
      );
    };
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        isCallableAlias(node.initializer)
      ) {
        addBindingNames(node.name);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return known;
}

function collectUses(sourceFile, known) {
  const uses = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && known.has(node.text)) {
      const parent = node.parent;
      const isImportName =
        ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent);
      const isVariableName = ts.isVariableDeclaration(parent) && parent.name === node;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isImportName && !isVariableName && !isPropertyName) {
        uses.push({
          line: lineOf(sourceFile, node),
          name: node.text,
          kind: ts.SyntaxKind[parent.kind],
          text: parent.getText(sourceFile).trim(),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return uses;
}

function scenarioDependentNames(sourceFile, known) {
  const dependent = new Set(known);
  let changed = true;

  while (changed) {
    changed = false;
    const visit = (node) => {
      const addName = (name, body) => {
        if (!name || !body || dependent.has(name.text)) return;
        if (!expressionUsesKnownName(body, dependent)) return;
        dependent.add(name.text);
        changed = true;
      };

      if (ts.isFunctionDeclaration(node)) addName(node.name, node.body);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        addName(node.name, node.initializer.body);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return dependent;
}

function canonicalCatalogScenarioUses(sourceFile, endpointPaths, known) {
  const endpoints = new Set(endpointPaths ?? []);
  if (!endpoints.size) return [];

  const namedHandlers = new Map();
  const indexHandlers = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      namedHandlers.set(node.name.text, node.body);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      namedHandlers.set(node.name.text, node.initializer.body);
    }
    ts.forEachChild(node, indexHandlers);
  };
  indexHandlers(sourceFile);

  const violations = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'http' &&
      node.expression.name.text === 'get' &&
      ts.isStringLiteral(node.arguments[0]) &&
      endpoints.has(node.arguments[0].text)
    ) {
      const candidate = node.arguments.at(-1);
      const handlerBody =
        candidate && (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate))
          ? candidate.body
          : candidate && ts.isIdentifier(candidate)
            ? namedHandlers.get(candidate.text)
            : null;
      if (handlerBody && expressionUsesKnownName(handlerBody, known)) {
        violations.push({
          line: lineOf(sourceFile, node),
          endpoint: node.arguments[0].text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

const [policySource, policySchemaSource, files] = await Promise.all([
  readFile(policyPath, 'utf8'),
  readFile(policySchemaPath, 'utf8'),
  walk(sourceRoot),
]);
const policy = JSON.parse(policySource);
const errors = [];
const validatePolicy = new Ajv2020({ allErrors: true, strict: false }).compile(
  JSON.parse(policySchemaSource)
);
if (!validatePolicy(policy)) {
  for (const error of validatePolicy.errors ?? []) {
    errors.push(
      'docs/design/visual-qa-policy.json' +
        (error.instancePath || '/') +
        ': ' +
        (error.message ?? 'schema violation')
    );
  }
}
const inventory = [];
const approved = policy.approvedImports ?? {};
const approvedReferenceImports = policy.approvedReferenceImports ?? {};

for (const file of files.filter((path) => /\.(ts|tsx|css)$/.test(path))) {
  const relativePath = repoPath(file);
  const source = await readFile(file, 'utf8');
  const isTest = /\.(test|spec)\.(ts|tsx)$/.test(file);

  if (/\.css$/.test(file)) {
    for (const value of policy.policy?.prohibitedReferences ?? []) {
      if (source.includes(value)) errors.push(relativePath + ': prohibited Figma reference in CSS: ' + value);
    }
    continue;
  }
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const referenceApproval = approvedReferenceImports[relativePath];
  for (const reference of referenceModuleSpecifiers(
    sourceFile,
    policy.policy?.prohibitedReferences ?? []
  )) {
    if (!referenceApproval) {
      errors.push(
        relativePath +
          ':' +
          reference.line +
          ' imports a prohibited Figma reference without policy approval: ' +
          reference.specifier
      );
    } else if (referenceApproval.reviewBy < today) {
      errors.push(relativePath + ': Figma reference approval expired on ' + referenceApproval.reviewBy + '.');
    }
  }
  if (isTest) continue;
  const { bindings, reExports, dynamicImports } = importedBindings(sourceFile);
  if (!bindings.size && !reExports.length && !dynamicImports.length) {
    for (const value of policy.policy?.prohibitedReferences ?? []) {
      if (source.includes(value)) {
        const approval = approvedReferenceImports[relativePath];
        if (!approval) errors.push(relativePath + ': prohibited Figma reference: ' + value);
        else if (approval.reviewBy < today) {
          errors.push(relativePath + ': Figma reference approval expired on ' + approval.reviewBy + '.');
        }
      }
    }
    continue;
  }

  if (dynamicImports.length) {
    for (const dynamicImport of dynamicImports) {
      errors.push(
        relativePath +
          ':' +
          dynamicImport.line +
          ' uses ' +
          dynamicImport.kind +
          ' for visualQA (' +
          dynamicImport.specifier +
          '); dynamic loading is forbidden because it bypasses policy-owned binding analysis.'
      );
    }
  }

  if (!bindings.size && !reExports.length) continue;

  const approval = approved[relativePath];
  const importedSymbols = [...bindings.values()];
  const aliases = resolveAliases(sourceFile, bindings);
  const uses = collectUses(sourceFile, aliases);
  const scenarioBindings = new Map(
    [...bindings].filter(([, importedSymbol]) => importedSymbol === 'getVisualScenario')
  );
  const catalogScenarioUses = canonicalCatalogScenarioUses(
    sourceFile,
    policy.policy?.canonicalCatalogEndpoints,
    scenarioDependentNames(sourceFile, resolveCallableAliases(sourceFile, scenarioBindings))
  );
  inventory.push({
    file: relativePath,
    importedSymbols,
    aliases: [...aliases].filter((name) => !bindings.has(name)),
    calls: uses,
    catalogScenarioUses,
    approval: approval?.category ?? null,
  });

  if (!approval) {
    errors.push(relativePath + ': imports visualQA without a policy approval.');
    continue;
  }
  if (approval.reviewBy < today) {
    errors.push(relativePath + ': visual QA approval expired on ' + approval.reviewBy + '.');
  }
  for (const symbol of importedSymbols) {
    if (!approval.symbols.includes(symbol)) {
      errors.push(relativePath + ': import ' + symbol + ' is not approved by its visual QA policy.');
    }
  }
  if (reExports.length) {
    errors.push(relativePath + ': visualQA re-export is forbidden because it bypasses import ownership.');
  }
  if (approval.maxCallSites !== undefined && uses.length > approval.maxCallSites) {
    errors.push(
      relativePath +
        ': has ' +
        uses.length +
        ' visual QA data-flow use(s); policy allows at most ' +
        approval.maxCallSites +
        '.'
    );
  }
  for (const violation of catalogScenarioUses) {
    if (
      approval.category !== 'harness' ||
      policy.policy?.fixturePolicy?.scenarioCatalogData !==
        'qualified-target-exact-data-allowed'
    ) {
      errors.push(
        relativePath +
          ':' +
          violation.line +
          ' changes catalog endpoint ' +
          violation.endpoint +
          ' outside the approved target-qualified API fixture harness.'
      );
    }
  }
  if (approval.category !== 'harness') {
    for (const value of policy.policy?.prohibitedDomPatches ?? []) {
      if (source.includes(value)) {
        errors.push(relativePath + ': non-harness visual QA module performs prohibited DOM patch ' + value + '.');
      }
    }
  }
}

const approvedFiles = new Set(Object.keys(approved));
const inventoryFiles = new Set(inventory.map((row) => row.file));
for (const file of approvedFiles) {
  if (!inventoryFiles.has(file)) {
    errors.push(file + ': stale visual QA policy approval has no matching import.');
  }
}

const result = {
  checkedAt: new Date().toISOString(),
  policy: repoPath(policyPath),
  approvedImportFiles: approvedFiles.size,
  importedFiles: inventory.length,
  errors,
  inventory,
};

if (jsonOnly) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('\n── Visual QA Boundary Check ─────────────────────────────────────\n');
  console.log('  Approved import files: ' + result.approvedImportFiles);
  console.log('  Imported source files:  ' + result.importedFiles);
  console.log('  Errors:                 ' + result.errors.length);
  if (result.errors.length) {
    console.log('\nErrors:\n');
    for (const error of result.errors) console.log('  - ' + error);
  }
}

if (errors.length && !reportOnly) process.exit(1);
