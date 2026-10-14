import { declarationBindings } from './declaration-bindings.mjs';
// Read explicitly authored type/function contracts and their source coordinates.
// JavaScript carries its contracts in JSDoc: `@param` and `@returns` types give a
// function's domain and codomain, `@typedef` names a type alias, and a class
// names a type whose `extends` clause gives its supertype.
import path from "node:path";
import { readFileSync } from "node:fs";
import { discoverJavaScriptSourceFiles } from "./source-files.mjs";
import { bindJavaScript, jsdocOf, lineColumnOf, parseJavaScript, parseJsdoc } from "@red-cup-engineering/javascript-node-services-section/javascript-parser";
import { typeCatalog, jsType, jsFn } from "@red-cup-engineering/javascript-algebra";

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function tagsFor(program, node) {
  const block = jsdocOf(program, node);
  return block ? parseJsdoc(block.value).tags : [];
}

function fnFrom(name, callable, tags) {
  const params = tags.filter((tag) => tag.tag === "param" && !tag.name.includes("."));
  const domain = callable.params.map((param, index) => params[index]?.type ?? "unknown");
  const returns = tags.find((tag) => tag.tag === "returns" || tag.tag === "return");
  return jsFn(returns?.type ? { name, domain, codomain: returns.type } : { name, domain });
}

function superName(node) {
  return node.superClass?.type === "Identifier" ? [node.superClass.name] : [];
}

function typedefsOf(program) {
  const types = [];
  for (const comment of program.comments) {
    if (comment.type !== "Block" || !comment.value.startsWith("*")) continue;
    for (const tag of parseJsdoc(comment.value).tags) {
      if ((tag.tag === "typedef" || tag.tag === "callback") && tag.name) types.push(jsType(tag.name, "type-alias"));
    }
  }
  return types;
}

/** Exact source evidence for every exported declaration, with one-based
 * positions. Syntax projection only: no build, no dependency resolution. */
export function introspectDeclarationsByFile(entryFiles) {
  const out = [];
  for (const file of entryFiles) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    let program;
    try { program = parseJavaScript(text); } catch { continue; }
    const types = typedefsOf(program);
    const functions = [];
    const subtypes = [];
    const locations = [];
    const reexports = [];
    const exports = [];
    const locate = (name, node) => {
      const start = lineColumnOf(text, node.start);
      const end = lineColumnOf(text, node.end);
      locations.push({ name, line: start.line, column: start.column, endLine: end.line });
    };
    const declarations = new Map();
    const binding = bindJavaScript(program);
    const record = (name, declaration, docNode) => {
      if (declaration.type === "ClassDeclaration" || declaration.type === "ClassExpression") {
        types.push(jsType(name, "class"));
        for (const base of superName(declaration)) subtypes.push([name, base]);
      } else if (FUNCTION_TYPES.has(declaration.type)) {
        functions.push(fnFrom(name, declaration, tagsFor(program, docNode)));
      } else if (declaration.type === "VariableDeclarator" && declaration.init && FUNCTION_TYPES.has(declaration.init.type)) {
        functions.push(fnFrom(name, declaration.init, tagsFor(program, docNode)));
      }
    };
    for (const statement of program.body) {
      const exported = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration";
      const declaration = exported ? statement.declaration : statement;
      if (!declaration) continue;
      if ((declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && declaration.id) {
        declarations.set(declaration.id.name, { declaration, docNode: statement });
        if (exported) {
          const exportName = statement.type === "ExportDefaultDeclaration" ? "default" : declaration.id.name;
          locate(declaration.id.name, statement);
          exports.push({ name: exportName, local: declaration.id.name });
          record(declaration.id.name, declaration, statement);
        }
      } else if (statement.type === "ExportDefaultDeclaration") {
        locate("default", statement);
        exports.push({ name: "default", local: "default" });
        record("default", declaration, statement);
      } else if (declaration.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          for (const item of declarationBindings(program, declarator.id, binding)) {
            declarations.set(item.name, { declaration: declarator.id.type === 'Identifier' ? declarator : item.identifier, docNode: statement });
            if (exported) {
              locate(item.name, declarator.id.type === 'Identifier' ? declarator : item.identifier);
              exports.push({ name: item.name, local: item.name });
              if (declarator.id.type === 'Identifier') record(item.name, declarator, statement);
            }
          }
        }
      }
    }
    const exportedName = (node) => (node.type === "Identifier" ? node.name : node.value);
    for (const statement of program.body) {
      if (statement.type === "ExportAllDeclaration") {
        reexports.push(statement.exported ? { specifier: statement.source.value, imported: "*", exported: exportedName(statement.exported) } : { specifier: statement.source.value });
        continue;
      }
      if (statement.type !== "ExportNamedDeclaration" || statement.declaration) continue;
      if (statement.source) {
        for (const specifier of statement.specifiers) reexports.push({ specifier: statement.source.value, imported: exportedName(specifier.local), exported: exportedName(specifier.exported) });
        continue;
      }
      for (const specifier of statement.specifiers) {
        const name = exportedName(specifier.local);
        const found = declarations.get(name);
        if (!found) continue;
        exports.push({ name: exportedName(specifier.exported), local: name });
        if (functions.some((value) => value.name === name) || types.some((value) => value.name === name)) continue;
        locate(name, found.declaration);
        record(name, found.declaration, found.docNode);
      }
    }
    out.push({ file: path.resolve(file), catalog: typeCatalog({ types, functions, subtypes }), locations, reexports, exports });
  }
  return out;
}

export function introspectDeclarations(entryFiles) {
  const parts = introspectDeclarationsByFile(entryFiles).map((entry) => entry.catalog);
  return typeCatalog({ types: parts.flatMap((part) => [...part.types]), functions: parts.flatMap((part) => [...part.functions]), subtypes: parts.flatMap((part) => [...part.subtypes]) });
}

/** Read authored source, stopping at nested package boundaries. */
export function introspectDirectory(dir) {
  return introspectDeclarations(discoverJavaScriptSourceFiles(dir, { stopAtPackageBoundary: true }));
}
