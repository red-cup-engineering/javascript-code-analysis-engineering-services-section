import { declarationBindings } from './declaration-bindings.mjs';
// documentation-edit — read full declaration source and rewrite the
// documentary layer (JSDoc) of exported symbols, without touching code.
//
// documentation reads the *surface* a documenter needs (signature + leading
// JSDoc). This goes one step further so the doc layer can be *managed* through
// the computer: it locates each exported declaration with its exact character
// spans, hands back the *full* declaration text (body and all), and offers a
// pure `setJsDoc(source, name, doc)` that returns new source with the symbol's
// JSDoc inserted or replaced. The transform is purely textual — it splices a
// freshly formatted `/** … */` block above the declaration and leaves every
// other byte, including the code body, exactly as written.

import { readFileSync } from "node:fs";
import { bindJavaScript, jsdocOf, parseJavaScript } from "@red-cup-engineering/javascript-node-services-section/javascript-parser";

const FUNCTION_TYPES = new Set(["FunctionExpression", "ArrowFunctionExpression"]);

/** Every exported top-level declaration of a parsed program as
 *  `{ name, kind, statement, declaration, declarator }`, in source order. JSDoc
 *  on an export attaches to the whole export statement. */
export function exportedDeclarations(program) {
  const out = [];
  const binding = bindJavaScript(program);
  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration" && statement.type !== "ExportDefaultDeclaration") continue;
    const declaration = statement.declaration;
    if (!declaration) continue;
    if (declaration.type === "FunctionDeclaration" && declaration.id) out.push({ name: declaration.id.name, kind: "function", statement, declaration });
    else if (declaration.type === "ClassDeclaration" && declaration.id) out.push({ name: declaration.id.name, kind: "class", statement, declaration });
    else if (declaration.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        const isFunction = declarator.id.type === 'Identifier' && declarator.init !== null && FUNCTION_TYPES.has(declarator.init.type);
        for (const item of declarationBindings(program, declarator.id, binding))
          out.push({ name: item.binding.name, kind: isFunction ? "const" : "variable", statement, declaration, declarator });
      }
    }
  }
  return out;
}

/** Locate every exported top-level declaration in a source file, with the spans
 *  and text needed to read or re-document it. `text` may be passed to operate on
 *  already-loaded source; otherwise the file is read from disk. */
export function locateDocSymbols(file, text) {
  const src = text ?? readFileSync(file, "utf8");
  const program = parseJavaScript(src);
  return Object.freeze(exportedDeclarations(program).map((entry) => {
    const { start, end } = entry.statement;
    const block = jsdocOf(program, entry.statement);
    const doc = block ? collapseDoc(stripBlockComment(src.slice(block.start, block.end))) : "";
    const base = { name: entry.name, kind: entry.kind, doc, documented: doc.trim() !== "", text: src.slice(start, end), start, end, indent: leadingIndent(src, start) };
    return Object.freeze(block ? { ...base, jsDocStart: block.start, jsDocEnd: block.end } : base);
  }));
}

/** Read the full source text of one exported symbol. `includeDoc` prepends the
 *  symbol's existing JSDoc block. Returns `undefined` when no such export
 *  exists. This is "show me this whole function/class/type" through the computer. */
export function readSymbolSource(
  file,
  name,
  opts = {},
  text,
) {
  const sym = locateDocSymbols(file, text).find((s) => s.name === name);
  if (!sym) return undefined;
  const src = text ?? readFileSync(file, "utf8");
  const from = opts.includeDoc && sym.jsDocStart !== undefined ? sym.jsDocStart : sym.start;
  return src.slice(from, sym.end);
}

/** Pure: return new source text with `name`'s leading JSDoc set to `doc`,
 *  replacing any existing block or inserting a fresh one above the declaration.
 *  The code body and every other byte are preserved verbatim. Throws when the
 *  file has no exported symbol of that name. `width` controls prose wrapping
 *  (default 80 columns). */
export function setJsDoc(
  source,
  name,
  doc,
  opts = {},
) {
  const sym = locateDocSymbols("<memory>.mjs", source).find((s) => s.name === name);
  if (!sym) throw new Error(`no exported symbol named "${name}"`);
  const block = formatJsDoc(doc, sym.indent, opts.width ?? 80);

  // The line on which the declaration starts; its indent lives between here and
  // sym.start. The new block replaces everything from the start of the existing
  // JSDoc's line (if any) up to this line — collapsing stray blank lines and
  // re-indenting the comment to match the declaration.
  const declLineStart = source.lastIndexOf("\n", sym.start - 1) + 1;
  const replaceFrom =
    sym.jsDocStart !== undefined ? source.lastIndexOf("\n", sym.jsDocStart - 1) + 1 : declLineStart;
  return source.slice(0, replaceFrom) + block + "\n" + source.slice(declLineStart);
}

/** Pure: format a JSDoc description into a `/** … *​/` block at `indent`. A
 *  description that fits one line becomes `/** text *​/`; longer prose is word-
 *  wrapped into ` * ` continuation lines. Explicit newlines in `doc` are honored
 *  as hard breaks. */
export function formatJsDoc(doc, indent, width = 80) {
  const text = doc.trim();
  if (text === "") return `${indent}/** */`;

  const inner = Math.max(20, width - indent.length - 3); // " * " framing
  const wrapped = [];
  for (const para of text.split("\n")) wrapped.push(...wrapLine(para.trim(), inner));

  if (wrapped.length === 1) {
    const only = wrapped[0] ?? "";
    if (indent.length + only.length + 7 <= width) return `${indent}/** ${only} */`;
  }
  const body = wrapped.map((line) => (line === "" ? `${indent} *` : `${indent} * ${line}`)).join("\n");
  return `${indent}/**\n${body}\n${indent} */`;
}

function wrapLine(line, width) {
  if (line === "") return [""];
  const words = line.split(/\s+/);
  const out = [];
  let cur = "";
  for (const word of words) {
    if (cur === "") cur = word;
    else if (cur.length + 1 + word.length <= width) cur += " " + word;
    else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}

// ---------- shared syntactic helpers ----------

function leadingIndent(text, start) {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const slice = text.slice(lineStart, start);
  const m = /^\s*/.exec(slice);
  return m ? m[0] : "";
}

export function stripBlockComment(raw) {
  return raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, ""))
    .filter((line) => !/^@\w+/.test(line.trim()))
    .join("\n");
}

export function collapseDoc(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !/^@\w+/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
