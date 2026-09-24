import { readFileSync } from 'node:fs';
import ts from 'typescript';

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function declarationInitializer(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      if (!declaration.initializer) {
        throw new Error(`Visual scenario contract '${name}' has no initializer.`);
      }
      return unwrapExpression(declaration.initializer);
    }
  }
  throw new Error(`Visual scenario contract '${name}' is missing.`);
}

function propertyName(property, label) {
  if (!property.name || ts.isComputedPropertyName(property.name)) {
    throw new Error(`${label} requires static scenario names.`);
  }
  if (
    ts.isIdentifier(property.name) ||
    ts.isStringLiteral(property.name) ||
    ts.isNumericLiteral(property.name)
  ) {
    return property.name.text;
  }
  throw new Error(`${label} contains an unsupported scenario name.`);
}

function stringArray(expression, label) {
  const value = unwrapExpression(expression);
  if (!ts.isArrayLiteralExpression(value)) {
    throw new Error(`${label} must be a literal string array.`);
  }
  return value.elements.map((element) => {
    const entry = unwrapExpression(element);
    if (!ts.isStringLiteral(entry)) {
      throw new Error(`${label} must contain only literal strings.`);
    }
    return entry.text;
  });
}

function registryScenarioNames(sourceFile) {
  const initializer = declarationInitializer(sourceFile, 'registryScenarioIds');
  if (!ts.isObjectLiteralExpression(initializer)) {
    throw new Error("Visual scenario contract 'registryScenarioIds' must be an object literal.");
  }
  const names = new Set();
  for (const property of initializer.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(
        "Visual scenario contract 'registryScenarioIds' allows property assignments only."
      );
    }
    const name = propertyName(property, "Visual scenario contract 'registryScenarioIds'");
    if (names.has(name)) throw new Error(`Visual scenario '${name}' is declared more than once.`);
    stringArray(property.initializer, `Registry IDs for visual scenario '${name}'`);
    names.add(name);
  }
  return names;
}

function namedStringSet(sourceFile, name) {
  const initializer = declarationInitializer(sourceFile, name);
  if (
    !ts.isNewExpression(initializer) ||
    !ts.isIdentifier(initializer.expression) ||
    initializer.expression.text !== 'Set' ||
    initializer.arguments?.length !== 1
  ) {
    throw new Error(`Visual scenario contract '${name}' must be initialized with new Set([...]).`);
  }
  return new Set(stringArray(initializer.arguments[0], `Visual scenario contract '${name}'`));
}

export function parseVisualScenarioMetadata(source, fileName = 'visualScenarios.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  if (sourceFile.parseDiagnostics.length) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    throw new Error(
      `Visual scenario contract is invalid TypeScript: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`
    );
  }

  const scenarios = registryScenarioNames(sourceFile);
  const replicas = namedStringSet(sourceFile, 'replicaScenarios');
  const rawReferences = namedStringSet(sourceFile, 'rawReferenceScenarios');
  for (const name of replicas) {
    if (rawReferences.has(name)) {
      throw new Error(`Visual scenario '${name}' cannot be both replica and raw-reference.`);
    }
  }

  return new Map(
    [...scenarios].map((name) => [
      name,
      replicas.has(name) ? 'replica' : rawReferences.has(name) ? 'raw-reference' : 'app-dom',
    ])
  );
}

export function loadVisualScenarioMetadata(path) {
  return parseVisualScenarioMetadata(readFileSync(path, 'utf8'), path);
}
