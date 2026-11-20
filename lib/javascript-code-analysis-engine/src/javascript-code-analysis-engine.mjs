import { sha256Hex } from "@red-cup-engineering/semiotic-content-address-system";

import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { bindJavaScript, lineColumnOf, parseJavaScript, walkJavaScript } from "@red-cup-engineering/javascript-parser-service";

const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const OBSERVER = `${own.name}@${own.version}`;

export const EFFECTFUL_NODE_MODULES = new Set([
  "async_hooks", "child_process", "cluster", "dgram", "diagnostics_channel",
  "dns", "fs", "http", "http2", "https", "net", "perf_hooks", "readline", "repl",
  "stream", "tls", "tty", "v8", "vm", "worker_threads", "zlib",
]);
const CRYPTO_EFFECTS = new Map([...["randomBytes", "randomFill", "randomFillSync", "randomInt", "randomUUID", "generateKeyPair", "generateKeyPairSync", "generateKey", "generateKeySync", "generatePrime", "generatePrimeSync"].map(name => [name, "node:crypto:randomness"]),
  ...["setEngine", "setFips", "secureHeapUsed"].map(name => [name, "node:crypto:process-state"])]);
const GLOBAL_EFFECTS = new Map([["fetch", "host:fetch"], ["setTimeout", "host:timers"], ["setInterval", "host:timers"], ["setImmediate", "host:timers"],
  ["queueMicrotask", "host:timers"], ["console", "host:console"], ["Date", "host:clock"], ["performance", "host:clock"], ["crypto", "host:randomness"]]);
const PROCESS_EFFECTS = new Map([["env", "host:environment"], ["argv", "host:argv"], ["stdout", "host:stdio"], ["stderr", "host:stdio"], ["stdin", "host:stdio"],
  ["exit", "host:process"], ["exitCode", "host:process"], ["cwd", "host:process"], ["chdir", "host:process"], ["on", "host:process"], ["kill", "host:process"]]);
const COMMAND_EFFECTS = new Set(["host:argv", "host:stdio", "host:console"]);


const isFunction = node => node?.type === "FunctionDeclaration" || node?.type === "FunctionExpression" || node?.type === "ArrowFunctionExpression";

function topLevelFunctions(program) {
  const found = [];
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration ?? null : statement;
    if (!declaration) continue;
    if (isFunction(declaration)) found.push({ name: declaration.id?.name ?? "default", node: declaration, start: statement.start, end: statement.end });
    else if (declaration.type === "VariableDeclaration")
      for (const declarator of declaration.declarations)
        if (declarator.id.type === "Identifier" && isFunction(declarator.init)) found.push({ name: declarator.id.name, node: declarator.init, start: statement.start, end: statement.end });
  }
  return found;
}

function importsOf(program, path) {
  const imported = new Map();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const source = String(statement.source.value);
    const bare = source.replace(/^node:/u, "");
    const where = source.startsWith(".") ? resolve(dirname(path), source) : builtinModules.includes(bare) ? `node:${bare}` : source;
    for (const specifier of statement.specifiers)
      imported.set(specifier.local, { source: where, module: source.replace(/^node:/u, "").split("/")[0],
        name: specifier.type === "ImportDefaultSpecifier" ? "default" : specifier.type === "ImportNamespaceSpecifier" ? "*" : String(specifier.imported.name ?? specifier.imported.value) });
  }
  return imported;
}

const literal = node => node.regex ? `R:/${node.regex.pattern}/${node.regex.flags}` : node.bigint !== undefined ? `B:${node.bigint}` : `V:${JSON.stringify(node.value)}`;

function normalForm(fn, references, imported, path) {
  const ordinals = new Map(), inside = binding => binding.identifier.start >= fn.start && binding.identifier.end <= fn.end;
  const identifier = node => {
    if (!references.has(node)) return `P:${node.name}`;
    const binding = references.get(node);
    if (binding === null) return `G:${node.name}`;
    if (inside(binding)) { if (!ordinals.has(binding)) ordinals.set(binding, ordinals.size); return `$${ordinals.get(binding)}`; }
    if (binding.kind === "import") { const from = imported.get(binding.identifier); return `I:${from.source}#${from.name}`; }
    return `M:${path}#${binding.name}@${binding.identifier.start}`;
  };
  const form = node => {
    if (node.type === "Identifier") return identifier(node);
    if (node.type === "PrivateIdentifier") return `P:#${node.name}`;
    if (node.type === "Literal") return literal(node);
    if (node.type === "TemplateElement") return `T:${JSON.stringify(node.value?.cooked ?? node.value?.raw ?? "")}`;
    const parts = [];
    for (const key of Object.keys(node)) {
      if (["type", "start", "end", "comments", "tokens", "raw", "loc", "range"].includes(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) parts.push(`${key}[${value.map(item => item && typeof item.type === "string" ? form(item) : JSON.stringify(item ?? null)).join(",")}]`);
      else if (value && typeof value === "object" && typeof value.type === "string") parts.push(`${key}=${form(value)}`);
      else if (value !== undefined && (typeof value !== "object" || value === null)) parts.push(`${key}:${JSON.stringify(value)}`);
    }
    return `${node.type}(${parts.join(";")})`;
  };
  return form({ ...fn, id: null });
}

function directEffects(fn, references, imported, path) {
  const effects = new Set(), internal = new Set(), unresolved = new Set();
  walkJavaScript(fn, (node, parent) => {
    if (node.type !== "Identifier" || !references.has(node)) return;
    const binding = references.get(node);
    const member = parent?.type === "MemberExpression" && parent.object === node && !parent.computed ? parent.property.name : null;
    const called = (parent?.type === "CallExpression" || parent?.type === "NewExpression") && parent.callee === node;
    if (binding === null) {
      if (node.name === "process" && member && PROCESS_EFFECTS.has(member)) effects.add(PROCESS_EFFECTS.get(member));
      else if (node.name === "Math" && member === "random") effects.add("host:randomness");
      else if (GLOBAL_EFFECTS.has(node.name) && (node.name !== "Date" || called || member === "now")) effects.add(GLOBAL_EFFECTS.get(node.name));
      return;
    }
    if (binding.identifier.start >= fn.start && binding.identifier.end <= fn.end) return;
    if (binding.kind === "import") {
      const from = imported.get(binding.identifier);
      if (from.module === "crypto") { const effect = CRYPTO_EFFECTS.get(member ?? from.name); if (effect) effects.add(effect); }
      else if (EFFECTFUL_NODE_MODULES.has(from.module) && from.source.startsWith("node:")) effects.add(`node:${from.module}`);
      else if (called || member) unresolved.add(`${from.source}#${from.name}`);
      return;
    }
    if (called || member) internal.add(`${path}#${binding.name}`);
  });
  return { effects, internal, unresolved };
}

export function layerOf(effects, unresolved) {
  if (effects.length >= 2) return "services";
  if (unresolved.length > 0) return null;
  if (effects.length === 0) return "domain";
  return COMMAND_EFFECTS.has(effects[0]) ? "commands" : "adapters";
}

function dataShapes(program) {
  const shapes = [];
  walkJavaScript(program, node => {
    if (node.type !== "ObjectExpression") return;
    const keys = [];
    let plain = true;
    for (const property of node.properties) {
      if (property.type !== "Property" || property.computed) { plain = false; continue; }
      const key = property.key.type === "Identifier" ? property.key.name : String(property.key.value);
      keys.push(key);
      if ((key === "kind" || key === "$id") && property.value.type === "Literal" && typeof property.value.value === "string")
        shapes.push({ shape: `${key}:${property.value.value}`, start: node.start });
    }
    if (plain && keys.length >= 4) shapes.push({ shape: `fields:${[...new Set(keys)].sort().join(",")}`, start: node.start });
  });
  return shapes;
}

export function analyzeModule(source, path) {
  const program = parseJavaScript(source);
  const { references } = bindJavaScript(program);
  const imported = importsOf(program, path);
  const units = topLevelFunctions(program).map(unit => ({ ...unit, key: `${path}#${unit.name}`, ...directEffects(unit.node, references, imported, path),
    form: normalForm(unit.node, references, imported, path) }));
  const byKey = new Map(units.map(unit => [unit.key, unit]));
  for (let changed = true; changed;) {
    changed = false;
    for (const unit of units) for (const key of unit.internal) {
      const callee = byKey.get(key);
      if (!callee) continue;
      for (const effect of callee.effects) if (!unit.effects.has(effect)) { unit.effects.add(effect); changed = true; }
      for (const call of callee.unresolved) if (!unit.unresolved.has(call)) { unit.unresolved.add(call); changed = true; }
    }
  }
  return {
    functions: units.map(unit => {
      const effects = [...unit.effects].sort(), unresolved = [...unit.unresolved].sort();
      return { name: unit.name, start: unit.start, end: unit.end, line: lineColumnOf(source, unit.start).line, bytes: Buffer.byteLength(source.slice(unit.start, unit.end)),
        sameFunctionKey: sha256Hex(unit.form), effects, unresolved: unresolved.length, layer: layerOf(effects, unresolved) };
    }),
    shapes: dataShapes(program).map(({ shape, start }) => ({ shape, line: lineColumnOf(source, start).line })),
  };
}
