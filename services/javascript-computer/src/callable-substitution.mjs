import { bindJavaScript, parseJavaScript } from "@red-cup-engineering/javascript-node-services-section/javascript-parser";

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const SCALAR_FIELDS = ["operator", "prefix", "async", "generator", "computed", "kind", "static", "optional", "shorthand", "method", "delegate", "await", "tail"];
const GLOBALS = new Set(["undefined", "NaN", "Infinity", "Object", "Array", "Number", "String", "Boolean", "BigInt", "Math", "JSON", "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "Promise", "Symbol", "Error", "TypeError", "RangeError", "Buffer", "Uint8Array"]);

function findCallable(program, name) {
  let callable;
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement;
    if (!declaration) continue;
    if (declaration.type === "FunctionDeclaration" && declaration.id?.name === name) callable = declaration;
    if (declaration.type === "VariableDeclaration") for (const declarator of declaration.declarations) {
      if (declarator.id.type === "Identifier" && declarator.id.name === name && declarator.init && FUNCTION_TYPES.has(declarator.init.type)) callable = declarator.init;
    }
  }
  return callable;
}

function childEntries(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) { for (const item of value) out.push(item && typeof item.type === "string" ? item : null); }
    else if (value && typeof value === "object" && typeof value.type === "string") out.push(value);
  }
  return out;
}

/** A conservative comparison form for a module-level callable. Unlike the
 * discovery fingerprint, this retains constants, parameter defaults, binding
 * relationships and captured module identity. Null means unsupported syntax.
 * It assumes the same standard JavaScript globals in the receiving runtime;
 * it is not a proof about effects, reflection or arbitrary program equivalence. */
export function callableSubstitutionForm(text, file, name) {
  const program = parseJavaScript(text);
  const callable = findCallable(program, name);
  if (!callable?.body) return null;
  const { references } = bindJavaScript(program);
  const root = callable;
  const locals = new Map();
  // Number every binding declared inside the callable in first-occurrence order.
  const collect = (node) => {
    if (node.type === "Identifier") {
      const binding = references.get(node);
      if (binding && binding.identifier.start >= root.start && binding.identifier.end <= root.end && !locals.has(binding)) locals.set(binding, locals.size);
    }
    for (const child of childEntries(node)) if (child) collect(child);
  };
  collect(root);
  let unsupported = false;
  const form = (node, parent) => {
    if (node === null) return null;
    // These observe the binding environment or callable identity in ways that
    // renaming or re-homing cannot preserve under this comparison.
    if (node.type === "ThisExpression" || node.type === "Super" || node.type === "MetaProperty" || (node.type === "Identifier" && (node.name === "eval" || node.name === "arguments"))) unsupported = true;
    if (node.type === "Identifier") {
      if (!references.has(node)) return ["property", node.name];
      if (parent?.type === "Property" && parent.shorthand && parent.value === node) return ["shorthand", node.name];
      const binding = references.get(node);
      if (binding && locals.has(binding)) return ["local", locals.get(binding)];
      if (!binding && GLOBALS.has(node.name)) return ["global", node.name];
      return ["capture", file, node.name];
    }
    if (node.type === "Literal") return ["Literal", node.regex ? `regex:/${node.regex.pattern}/${node.regex.flags}` : `${typeof node.value}:${String(node.value)}`];
    if (node.type === "TemplateElement") return ["TemplateElement", node.value.cooked];
    const scalars = SCALAR_FIELDS.filter((field) => field in node).map((field) => [field, node[field]]);
    const children = childEntries(node).filter((child) => !(node === root && child === root.id)).map((child) => form(child, node));
    return [node.type, scalars, ...children];
  };
  const result = JSON.stringify(form(root, null));
  return unsupported ? null : result;
}
