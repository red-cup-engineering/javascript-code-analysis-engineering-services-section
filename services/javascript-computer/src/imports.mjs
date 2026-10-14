// imports — read the *demand* surface of JavaScript source.
//
// introspect.mts reads what a module *supplies* (its exported declarations).
// This reads what a module *demands*: the bindings it pulls in from other
// modules. Where introspect projects onto the type category, this projects onto
// the import relation — the dual half of the dependency graph at symbol
// granularity.
//
// This is a purely syntactic read over the house parser: no resolution is
// needed to see that `import { foo } from "x"` names `foo` from `"x"`.

import { readFileSync } from "node:fs";
import { parseJavaScript, walkJavaScript } from "@red-cup-engineering/javascript-node-services-section/javascript-parser";

/** One binding a source file pulls in from another module.
 *
 *  `mode` discriminates the precision of the read: a `named` binding names
 *  exactly one provider symbol, but `namespace`, `star-reexport`, and
 *  `dynamic` reach a provider without naming which of its symbols are used.
 *  Any "is this symbol unused?" analysis must treat the coarse modes as
 *  usage-indeterminate, never as evidence of non-use. JavaScript has no
 *  type-only imports, so `typeOnly` is always false. */

const nameOf = (node) => (node.type === "Identifier" ? node.name : node.value);

/** Read every import/re-export/dynamic-import binding from one file's source text. */
export function readImports(sourceText) {
  const program = parseJavaScript(sourceText);
  const out = [];
  for (const node of program.body) {
    if (node.type === "ImportDeclaration") {
      const specifier = node.source.value;
      // Executing a module without importing a binding still depends on its
      // evaluation. Do not let whole-package dead-code sweeps erase it.
      if (node.specifiers.length === 0) out.push({ specifier, mode: "side-effect", typeOnly: false });
      for (const item of node.specifiers) {
        if (item.type === "ImportDefaultSpecifier") out.push({ specifier, mode: "default", name: "default", typeOnly: false });
        else if (item.type === "ImportNamespaceSpecifier") out.push({ specifier, mode: "namespace", typeOnly: false });
        else out.push({ specifier, mode: "named", name: nameOf(item.imported), typeOnly: false });
      }
    } else if (node.type === "ExportAllDeclaration") {
      out.push({ specifier: node.source.value, mode: node.exported ? "namespace" : "star-reexport", typeOnly: false });
    } else if (node.type === "ExportNamedDeclaration" && node.source) {
      for (const item of node.specifiers) out.push({ specifier: node.source.value, mode: "named", name: nameOf(item.local), typeOnly: false });
    }
  }
  walkJavaScript(program, (node) => {
    if (node.type === "ImportExpression") {
      out.push({ specifier: node.source.type === "Literal" && typeof node.source.value === "string" ? node.source.value : undefined, mode: "dynamic", typeOnly: false });
    }
  });
  return out;
}

/** Read imports from a set of files on disk. Unreadable files are skipped (they
 *  contribute no demand), so a partial tree still yields a usable surface. */
export function introspectImports(files) {
  const out = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    out.push({ file, bindings: readImports(text, file) });
  }
  return out;
}
