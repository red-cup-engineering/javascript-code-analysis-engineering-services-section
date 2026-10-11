// module-corpus — one index over a set of JavaScript modules, answering the
// cross-module questions a single file cannot: which declaration an imported
// name finally denotes (through re-exports), which module a node belongs to,
// and what contract types a declaration's JSDoc states. Nothing outside the
// admitted set is read; a specifier the caller's resolver cannot place inside
// the set resolves to no declaration.

import { bindJavaScript, jsdocOf, lineColumnOf, parseJavaScript, parseJsdoc, walkJavaScript } from "@red-cup-engineering/javascript-node-services-section/javascript-parser";

const JSDOC_TYPE_WORDS = new Set([
  "any", "unknown", "never", "void", "undefined", "null", "string", "number", "boolean", "bigint", "symbol", "object",
  "true", "false", "function", "typeof", "keyof", "readonly", "import", "extends", "infer", "is", "asserts", "unique", "new",
]);

const nameOf = (node) => (node.type === "Identifier" ? node.name : node.value);

/**
 * Index modules for cross-module reading.
 * @param {{ files: readonly { absolutePath: string, content: string }[], resolve: (specifier: string, fromFile: string) => string | undefined }} request
 */
export function indexModuleCorpus({ files, resolve }) {
  const modules = new Map();
  const moduleOfNode = new WeakMap();
  const parentOfNode = new WeakMap();
  for (const file of files) {
    let program;
    try { program = parseJavaScript(file.content); } catch { continue; }
    const module = { fileName: file.absolutePath, text: file.content, program, binding: null, typedefs: null };
    walkJavaScript(program, (node, parent) => {
      moduleOfNode.set(node, module);
      if (parent) parentOfNode.set(node, parent);
    });
    modules.set(file.absolutePath, module);
  }
  const bindingOfModule = (module) => {
    module.binding ??= bindJavaScript(module.program);
    return module.binding;
  };
  const typedefsOf = (module) => {
    if (module.typedefs) return module.typedefs;
    const typedefs = new Map();
    for (const comment of module.program.comments) {
      if (comment.type !== "Block" || !comment.value.startsWith("*")) continue;
      for (const tag of parseJsdoc(comment.value).tags) {
        if ((tag.tag === "typedef" || tag.tag === "callback") && tag.name) {
          typedefs.set(tag.name, Object.freeze({ type: "JSDocTypedef", name: tag.name, typeText: tag.type, start: comment.start, end: comment.end, module }));
        }
      }
    }
    module.typedefs = typedefs;
    return typedefs;
  };

  const moduleOf = (node) => moduleOfNode.get(node) ?? (node?.type === "JSDocTypedef" ? node.module : undefined);
  const parentOf = (node) => parentOfNode.get(node);
  const lineOf = (node) => {
    const module = moduleOf(node);
    return module ? lineColumnOf(module.text, node.start).line : undefined;
  };
  const targetModule = (specifier, fromModule) => {
    const resolved = resolve(specifier, fromModule.fileName);
    return resolved === undefined ? undefined : modules.get(resolved);
  };

  /** The declaration node a local binding names: a function or class
   * declaration, a variable declarator, or (for parameters and destructured
   * names) the binding identifier itself. */
  const declarationOfBinding = (binding) => {
    const parent = parentOfNode.get(binding.identifier);
    if (!parent) return binding.identifier;
    if ((parent.type === "FunctionDeclaration" || parent.type === "ClassDeclaration" || parent.type === "FunctionExpression" || parent.type === "ClassExpression") && parent.id === binding.identifier) return parent;
    if (parent.type === "VariableDeclarator" && parent.id === binding.identifier) return parent;
    return binding.identifier;
  };

  /** Every declaration `name` denotes when imported from `module`, following
   * re-exports; `"*"` denotes the module itself. */
  const exportedDeclarations = (module, name, seen = new Set()) => {
    const key = `${module.fileName}\0${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    if (name === "*") return [module.program];
    const found = [];
    const localDeclarations = (localName) => {
      const binding = bindingOfModule(module).bindings.find((candidate) => candidate.name === localName && candidate.scope.node === module.program);
      if (!binding) return [];
      if (binding.kind === "import") return importedDeclarationsOf(module, binding.identifier, seen);
      return [declarationOfBinding(binding)];
    };
    for (const statement of module.program.body) {
      if (statement.type === "ExportDefaultDeclaration" && name === "default") {
        const declaration = statement.declaration;
        found.push(declaration.type === "Identifier" ? localDeclarations(declaration.name)[0] ?? declaration : declaration);
      } else if (statement.type === "ExportNamedDeclaration") {
        const declaration = statement.declaration;
        if (declaration) {
          if ((declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && declaration.id?.name === name) found.push(declaration);
          if (declaration.type === "VariableDeclaration") for (const declarator of declaration.declarations) if (declarator.id.type === "Identifier" && declarator.id.name === name) found.push(declarator);
        }
        for (const specifier of statement.specifiers) {
          if (nameOf(specifier.exported) !== name) continue;
          if (statement.source) {
            const target = targetModule(statement.source.value, module);
            if (target) found.push(...exportedDeclarations(target, nameOf(specifier.local), seen));
          } else {
            found.push(...localDeclarations(nameOf(specifier.local)));
          }
        }
      } else if (statement.type === "ExportAllDeclaration") {
        const target = targetModule(statement.source.value, module);
        if (!target) continue;
        if (statement.exported) { if (nameOf(statement.exported) === name) found.push(target.program); }
        else if (name !== "default") found.push(...exportedDeclarations(target, name, seen));
      }
    }
    return found.filter(Boolean);
  };

  /** The declarations an import binding's identifier finally denotes. */
  const importedDeclarationsOf = (module, identifier, seen = new Set()) => {
    const specifier = parentOfNode.get(identifier);
    const declaration = specifier ? parentOfNode.get(specifier) : undefined;
    if (!declaration || declaration.type !== "ImportDeclaration") return [];
    const target = targetModule(declaration.source.value, module);
    if (!target) return [];
    const imported = specifier.type === "ImportDefaultSpecifier" ? "default" : specifier.type === "ImportNamespaceSpecifier" ? "*" : nameOf(specifier.imported);
    return exportedDeclarations(target, imported, seen);
  };

  /** The local binding an identifier reference resolves to, or null (a global
   * or a name outside the admitted modules). */
  const bindingOf = (identifier) => {
    const module = moduleOf(identifier);
    return module ? bindingOfModule(module).references.get(identifier) ?? null : null;
  };

  /** Every declaration an identifier denotes: its own local declaration, or,
   * for an import, the declaration(s) it finally names in the corpus. */
  const declarationsOf = (identifier) => {
    const binding = bindingOf(identifier);
    if (!binding) return [];
    if (binding.kind === "import") return importedDeclarationsOf(moduleOf(binding.identifier), binding.identifier);
    return [declarationOfBinding(binding)];
  };

  /** The module specifier an identifier was imported through, if it was. */
  const importSpecifierOf = (identifier) => {
    const binding = bindingOf(identifier);
    if (!binding || binding.kind !== "import") return undefined;
    const declaration = parentOfNode.get(parentOfNode.get(binding.identifier));
    return declaration?.type === "ImportDeclaration" ? declaration.source.value : undefined;
  };

  /** The statement a declaration's JSDoc attaches to. */
  const documentedStatementOf = (node) => {
    let current = node;
    if (current.type === "VariableDeclarator") current = parentOfNode.get(current) ?? current;
    const parent = parentOfNode.get(current);
    if (parent && (parent.type === "ExportNamedDeclaration" || parent.type === "ExportDefaultDeclaration")) current = parent;
    return current;
  };

  /** The JSDoc contract of a declaration: `{ params: [{ name, type }], returns, type }`. */
  const contractOf = (node) => {
    const module = moduleOf(node);
    if (!module) return { params: [], returns: undefined, type: undefined };
    const block = jsdocOf(module.program, documentedStatementOf(node));
    if (!block) return { params: [], returns: undefined, type: undefined };
    const tags = parseJsdoc(block.value).tags;
    return {
      params: tags.filter((tag) => tag.tag === "param" && !tag.name.includes(".")).map((tag) => ({ name: tag.name, type: tag.type })),
      returns: tags.find((tag) => tag.tag === "returns" || tag.tag === "return")?.type ?? undefined,
      type: tags.find((tag) => tag.tag === "type")?.type ?? undefined,
    };
  };

  /** The declarations a JSDoc type expression names, as seen from `module`:
   * local typedefs and classes, imported names, and `import("x").Name`. */
  const typeDeclarations = (module, typeText) => {
    if (!typeText) return [];
    const found = [];
    for (const match of typeText.matchAll(/import\(\s*["']([^"']+)["']\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/gu)) {
      const target = targetModule(match[1], module);
      if (target) {
        const typedef = typedefsOf(target).get(match[2]);
        if (typedef) found.push(typedef); else found.push(...exportedDeclarations(target, match[2]));
      }
    }
    const bare = typeText.replace(/import\(\s*["'][^"']+["']\s*\)\s*\.\s*[A-Za-z_$][\w$]*/gu, " ").replace(/(["'])(?:\\.|(?!\1).)*\1/gu, " ");
    for (const match of bare.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/gu)) {
      const name = match[1];
      if (JSDOC_TYPE_WORDS.has(name)) continue;
      const typedef = typedefsOf(module).get(name);
      if (typedef) { found.push(typedef); continue; }
      const binding = bindingOfModule(module).bindings.find((candidate) => candidate.name === name && candidate.scope.node === module.program);
      if (!binding) { found.push(Object.freeze({ type: "UnresolvedType", name })); continue; }
      if (binding.kind === "import") found.push(...importedDeclarationsOf(module, binding.identifier));
      else found.push(declarationOfBinding(binding));
    }
    return found;
  };

  /** The declared name of a declaration node, as a symbol name. */
  const declarationName = (node) => {
    if (node.type === "JSDocTypedef" || node.type === "UnresolvedType") return node.name;
    if (node.type === "Program") return "*";
    if (node.id?.type === "Identifier") return node.id.name;
    if (node.type === "Identifier") return node.name;
    return "default";
  };

  return Object.freeze({
    modules,
    moduleOf,
    parentOf,
    lineOf,
    bindingOf,
    declarationsOf,
    importSpecifierOf,
    exportedDeclarations: (fileName, name) => { const module = modules.get(fileName); return module ? exportedDeclarations(module, name) : []; },
    contractOf,
    typeDeclarations,
    declarationName,
    typedefsOf,
  });
}
