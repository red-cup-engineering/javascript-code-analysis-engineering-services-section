import { lineColumnOf, parseJavaScript, walkJavaScript } from "@red-cup-engineering/javascript-node-services-section/javascript-parser";
import { sha256Hex } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/integrity";


/** The kind of executable behavior a node is, or undefined. A method's
 * function value is read through its MethodDefinition, never twice. */
function behaviorKind(node, parent) {
  if (node.type === "FunctionDeclaration") return "function";
  if (node.type === "MethodDefinition") return node.kind === "constructor" ? "constructor" : node.kind === "get" ? "getter" : node.kind === "set" ? "setter" : "method";
  if (node.type === "Property" && (node.method || node.kind === "get" || node.kind === "set")) return node.kind === "get" ? "getter" : node.kind === "set" ? "setter" : "method";
  if (node.type === "ArrowFunctionExpression") return "arrow";
  if (node.type === "FunctionExpression" && !(parent?.type === "MethodDefinition" || (parent?.type === "Property" && (parent.method || parent.kind !== "init")))) return "function-expression";
  return undefined;
}

function behaviorFunction(node) {
  return node.type === "MethodDefinition" || node.type === "Property" ? node.value : node;
}

function keyText(key, text) {
  if (key.type === "Identifier") return key.name;
  if (key.type === "PrivateIdentifier") return `#${key.name}`;
  return text.slice(key.start, key.end);
}

function behaviorName(node, parent, text) {
  if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") && node.id) return node.id.name;
  if (node.type === "MethodDefinition") return node.kind === "constructor" ? "constructor" : keyText(node.key, text);
  if (node.type === "Property") return keyText(node.key, text);
  if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
  if (parent?.type === "Property" && parent.value === node) return keyText(parent.key, text);
  return `<anonymous:${lineColumnOf(text, node.start).line}>`;
}

function patternNames(pattern, names) {
  if (!pattern) return;
  if (pattern.type === "Identifier") names.add(pattern.name);
  else if (pattern.type === "ObjectPattern") for (const property of pattern.properties) patternNames(property.type === "RestElement" ? property.argument : property.value, names);
  else if (pattern.type === "ArrayPattern") for (const element of pattern.elements) patternNames(element, names);
  else if (pattern.type === "RestElement") patternNames(pattern.argument, names);
  else if (pattern.type === "AssignmentPattern") patternNames(pattern.left, names);
}

/** Names bound within the behavior itself: parameters, destructured bindings,
 * locally declared variables, functions and classes, and catch bindings. Any
 * other identifier reaching `semanticForm` refers to an outer binding (an
 * import, a module constant, a global) and is retained, never erased, because
 * which outer binding a call targets is part of the invoked API this
 * fingerprint is documented to retain. */
function localBindingNames(fn) {
  const names = new Set();
  walkJavaScript(fn, (node) => {
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      if (node.id) names.add(node.id.name);
      for (const param of node.params) patternNames(param, names);
    } else if (node.type === "VariableDeclarator") patternNames(node.id, names);
    else if (node.type === "CatchClause") patternNames(node.param, names);
    else if ((node.type === "ClassDeclaration" || node.type === "ClassExpression") && node.id) names.add(node.id.name);
  });
  return names;
}

function isPropertyKey(node, parent) {
  if (!parent) return false;
  if ((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent.key === node) return true;
  return false;
}

function childNodes(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "regex") continue;
    if (key === "value" && node.type === "Literal") continue;
    const value = node[key];
    if (Array.isArray(value)) { for (const item of value) if (item && typeof item.type === "string") out.push(item); }
    else if (value && typeof value === "object" && typeof value.type === "string") out.push(value);
  }
  return out;
}

function semanticForm(node, parent, locals) {
  if (isPropertyKey(node, parent) && !(parent.type === "Property" && parent.shorthand)) {
    if (!parent.computed) {
      if (node.type === "Identifier") return `KEY:${JSON.stringify(node.name)}`;
      if (node.type === "PrivateIdentifier") return `KEY:${JSON.stringify(`#${node.name}`)}`;
      if (node.type === "Literal") return typeof node.value === "number" ? `KEY:${node.value}` : `KEY:${JSON.stringify(String(node.value))}`;
    }
    if (node.type === "Literal" && typeof node.value === "string") return `KEY:${JSON.stringify(node.value)}`;
    if (node.type === "Literal" && typeof node.value === "number") return `KEY:${node.value}`;
    return `KEY:[${semanticForm(node, null, locals)}]`;
  }
  if (node.type === "Identifier") {
    if ((parent?.type === "CallExpression" || parent?.type === "NewExpression") && parent.callee === node) return `CALL:${node.name}`;
    if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return `PROP:${node.name}`;
    return locals.has(node.name) ? "ID" : `FREE:${node.name}`;
  }
  if (node.type === "PrivateIdentifier") return `PROP:#${node.name}`;
  // Encoding arguments select a transformation, not interchangeable policy:
  // erasing them groups UTF-8 -> hex with its inverse.
  if (node.type === "Literal" && typeof node.value === "string") {
    if (parent?.type === "CallExpression" && parent.arguments.includes(node) && Buffer.isEncoding(node.value)) return `ENCODING:${JSON.stringify(node.value)}`;
    return "STRING";
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return "STRING";
  if (node.type === "Literal" && (typeof node.value === "number" || node.bigint !== undefined)) return "NUMBER";
  if (node.type === "Literal" && typeof node.value === "boolean") return "BOOLEAN";
  if (node.type === "Literal" && node.value === null && !node.regex) return "NULL";
  if (node.type === "Literal" && node.regex) return `REGEX:${node.regex.pattern}/${node.regex.flags}`;
  const tag = node.operator ? `${node.type}:${node.operator}` : node.type;
  return `${tag}(${childNodes(node).map((child) => semanticForm(child, node, locals)).join(",")})`;
}

/** Parse a source file and expose its executable behavior carriers. The
 * house parser supplies the syntax tree, so comments, formatting, and
 * identifier spelling cannot create false implementation differences. */
export function extractExecutableBehaviors(sourceText) {
  const program = parseJavaScript(sourceText);
  const behaviors = [];
  walkJavaScript(program, (node, parent) => {
    const kind = behaviorKind(node, parent);
    if (kind === undefined) return;
    const fn = behaviorFunction(node);
    const body = fn?.body;
    if (!body) return;
    const locals = localBindingNames(fn);
    // An exported declaration's span includes its export keyword.
    const start = parent?.type === "ExportNamedDeclaration" || parent?.type === "ExportDefaultDeclaration" ? parent.start : node.start;
    behaviors.push(Object.freeze({
      name: behaviorName(node, parent, sourceText),
      kind,
      line: lineColumnOf(sourceText, start).line,
      bytes: Buffer.byteLength(sourceText.slice(start, node.end)),
      semanticFingerprint: sha256Hex(semanticForm(body, fn, locals)),
      implementationFingerprint: sha256Hex(sourceText.slice(body.start, body.end)),
    }));
  });
  return Object.freeze(behaviors);
}
