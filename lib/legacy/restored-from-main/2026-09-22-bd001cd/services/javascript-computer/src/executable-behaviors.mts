import { createHash } from "node:crypto";
import ts from "typescript";

export type ExecutableBehaviorKind =
  | "function"
  | "method"
  | "constructor"
  | "getter"
  | "setter"
  | "arrow"
  | "function-expression";

export interface ExecutableBehavior {
  readonly name: string;
  readonly kind: ExecutableBehaviorKind;
  readonly line: number;
  readonly bytes: number;
  /** Ignores local names and literal values while retaining control flow,
   * operators, invoked APIs, and accessed properties. */
  readonly semanticFingerprint: string;
  /** Retains the complete parsed implementation, used to expose variants
   * within one semantic family instead of silently discarding them. */
  readonly implementationFingerprint: string;
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (/\.tsx$/iu.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/iu.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.[cm]?ts$/iu.test(fileName)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function behaviorKind(node: ts.Node): ExecutableBehaviorKind | undefined {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isGetAccessorDeclaration(node)) return "getter";
  if (ts.isSetAccessorDeclaration(node)) return "setter";
  if (ts.isArrowFunction(node)) return "arrow";
  if (ts.isFunctionExpression(node)) return "function-expression";
  return undefined;
}

function behaviorBody(node: ts.Node): ts.Node | undefined {
  if (
    ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
  ) return node.body;
  return undefined;
}

function behaviorName(node: ts.Node, source: ts.SourceFile): string {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return node.name.getText(source);
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent)) return parent.name.getText(source);
  }
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `<anonymous:${start.line + 1}>`;
}

function isDirectCallee(node: ts.Identifier): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node
    || ts.isNewExpression(node.parent) && node.parent.expression === node;
}

function isSemanticPropertyName(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isPropertyAssignment(parent) && parent.name === node
    || ts.isShorthandPropertyAssignment(parent) && parent.name === node
    || ts.isMethodDeclaration(parent) && parent.name === node
    || ts.isPropertyDeclaration(parent) && parent.name === node
    || ts.isGetAccessorDeclaration(parent) && parent.name === node
    || ts.isSetAccessorDeclaration(parent) && parent.name === node
    || ts.isPropertySignature(parent) && parent.name === node
    || ts.isMethodSignature(parent) && parent.name === node
    || ts.isBindingElement(parent) && parent.propertyName === node;
}

function semanticPropertyKey(node: ts.PropertyName, source: ts.SourceFile, locals: ReadonlySet<string>): string {
  if (ts.isComputedPropertyName(node)) {
    const expression = node.expression;
    if (ts.isStringLiteralLike(expression)) return `KEY:${JSON.stringify(expression.text)}`;
    if (ts.isNumericLiteral(expression)) return `KEY:${expression.text}`;
    return `KEY:[${semanticForm(expression, source, locals)}]`;
  }
  if (ts.isIdentifier(node)) return `KEY:${JSON.stringify(node.text)}`;
  if (ts.isStringLiteralLike(node)) return `KEY:${JSON.stringify(node.text)}`;
  if (ts.isNumericLiteral(node)) return `KEY:${node.text}`;
  return `KEY:${node.getText(source)}`;
}

/** Names bound within the behavior itself (parameters, destructured
 * bindings, locally declared variables/functions/classes, catch bindings,
 * and the behavior's own type parameters). Any other identifier reaching
 * `semanticForm` refers to a binding from an outer scope -- an import, a
 * module-level constant, a global -- and is retained, never erased to the
 * generic "ID" token, because which outer binding a call or cast targets
 * (e.g. which contract a `X.assert(input) as T` wrapper delegates to) is
 * exactly the kind of "invoked API" this fingerprint is documented to
 * retain, not local naming noise to ignore. */
function collectLocalBindingNames(node: ts.Node, names: Set<string>): void {
  const addBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) { names.add(name.text); return; }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) addBindingName(element.name);
    }
  };
  if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
    addBindingName(node.name);
  }
  if (ts.isCatchClause(node) && node.variableDeclaration) {
    addBindingName(node.variableDeclaration.name);
  }
  if (
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))
    && node.name
  ) {
    names.add(node.name.text);
  }
  if (ts.isTypeParameterDeclaration(node)) names.add(node.name.text);
  node.forEachChild((child) => { collectLocalBindingNames(child, names); });
}

function semanticForm(node: ts.Node, source: ts.SourceFile, locals: ReadonlySet<string>): string {
  if (isSemanticPropertyName(node)) return semanticPropertyKey(node as ts.PropertyName, source, locals);
  if (ts.isIdentifier(node)) {
    if (isDirectCallee(node)) return `CALL:${node.text}`;
    if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return `PROP:${node.text}`;
    return locals.has(node.text) ? "ID" : `FREE:${node.text}`;
  }
  // Encoding arguments select a transformation, not interchangeable policy:
  // erasing them groups UTF-8 -> hex with its inverse. Use Node's own
  // encoding vocabulary instead of maintaining a second codec-name table.
  if (ts.isStringLiteralLike(node)) {
    if (ts.isCallExpression(node.parent) && node.parent.arguments.includes(node)
      && Buffer.isEncoding(node.text)) return `ENCODING:${JSON.stringify(node.text)}`;
    return "STRING";
  }
  if (ts.isNumericLiteral(node)) return "NUMBER";
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return "BOOLEAN";
  if (node.kind === ts.SyntaxKind.NullKeyword) return "NULL";
  const children: string[] = [];
  node.forEachChild((child) => { children.push(semanticForm(child, source, locals)); });
  return `${ts.SyntaxKind[node.kind]}(${children.join(",")})`;
}

/** Parse a source file and expose its executable behavior carriers. This uses
 * the upstream TypeScript parser, so comments, formatting, and identifier
 * spelling cannot create false implementation differences. */
export function extractExecutableBehaviors(sourceText: string, fileName: string): readonly ExecutableBehavior[] {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ES2024,
    true,
    scriptKind(fileName),
  );
  const behaviors: ExecutableBehavior[] = [];
  const visit = (node: ts.Node): void => {
    const kind = behaviorKind(node);
    const body = behaviorBody(node);
    if (kind !== undefined && body !== undefined) {
      const start = node.getStart(source);
      const end = node.getEnd();
      const locals = new Set<string>();
      collectLocalBindingNames(node, locals);
      behaviors.push(Object.freeze({
        name: behaviorName(node, source),
        kind,
        line: source.getLineAndCharacterOfPosition(start).line + 1,
        bytes: Buffer.byteLength(sourceText.slice(start, end)),
        semanticFingerprint: hash(semanticForm(body, source, locals)),
        implementationFingerprint: hash(body.getText(source)),
      }));
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return Object.freeze(behaviors);
}
