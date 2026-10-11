// documentation — read the *documentary* surface of JavaScript source.
//
// introspect projects declarations onto the type category (names, domains,
// codomains). This reads the surface a documenter needs: each exported symbol's
// verbatim signature and its leading JSDoc description. It is a per-file
// syntactic read over the house parser, sharing documentation-edit's locator.

import { readFileSync } from "node:fs";
import { jsdocOf, parseJavaScript } from "@red-cup-engineering/javascript-node-services-section/javascript-parser";
import { collapseDoc, exportedDeclarations, stripBlockComment } from "./documentation-edit.mjs";

/** Parse one source file's exported declarations into documentary surfaces:
 *  `{ name, kind, signature, doc }`, where `kind` is function, class, const
 *  (a function-valued binding) or variable, `signature` is the declaration
 *  head with its body elided, and `doc` is the leading JSDoc description
 *  (`""` when undocumented). `text` may be passed to read already-loaded
 *  source; otherwise the file is read from disk. */
export function extractDocSurface(file, text) {
  const src = text ?? readFileSync(file, "utf8");
  const program = parseJavaScript(src);
  return Object.freeze(exportedDeclarations(program).map((entry) => {
    const block = jsdocOf(program, entry.statement);
    const doc = block ? collapseDoc(stripBlockComment(src.slice(block.start, block.end))) : "";
    return Object.freeze({ name: entry.name, kind: entry.kind, signature: tidy(signatureOf(entry, src)), doc });
  }));
}

function signatureOf(entry, src) {
  const { statement, declaration, declarator } = entry;
  if (entry.kind === "function") return withExport(src.slice(statement.start, declaration.body.start));
  if (entry.kind === "class") return withExport(src.slice(statement.start, declaration.body.start));
  const keyword = declaration.kind;
  if (entry.kind === "const") {
    const fn = declarator.init;
    const params = fn.params.map((param) => src.slice(param.start, param.end)).join(", ");
    return `export ${keyword} ${entry.name} = ${fn.async ? "async " : ""}(${params}) => …`;
  }
  return `export ${keyword} ${entry.name}`;
}

function withExport(sig) {
  const trimmed = sig.trim();
  return /^export\b/.test(trimmed) ? trimmed : `export ${trimmed}`;
}

function tidy(value) {
  return value.replace(/\s+/g, " ").trim();
}
