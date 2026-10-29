// Read explicitly authored type/function contracts and their source coordinates.
import path from "node:path";
import { readFileSync } from "node:fs";
import { discoverJavaScriptSourceFiles } from "./source-files.mjs";
import ts from "typescript";
import {
  typeCatalog,
  jsType,
  jsFn,
  type TypeCatalog,
  type JsType,
  type JsFn,
  type SubtypeEdge,
} from "@red-cup-engineering/javascript-algebra";

function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function heritageNames(
  node: ts.ClassDeclaration | ts.InterfaceDeclaration,
): readonly string[] {
  const names: string[] = [];
  for (const clause of node.heritageClauses ?? []) {
    for (const t of clause.types) {
      if (ts.isIdentifier(t.expression)) names.push(t.expression.text);
    }
  }
  return names;
}

function typeNameOf(node: ts.TypeNode | undefined, source: ts.SourceFile): string {
  if (!node) return "unknown";
  // Primitives (string, number, void, …) are keyword type nodes; getText needs
  // the owning source file to resolve their span.
  return node.getText(source);
}

function fnFrom(
  name: string,
  node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.FunctionTypeNode,
  source: ts.SourceFile,
): JsFn {
  const domain = node.parameters.map((p) => typeNameOf(p.type, source));
  const codomain = node.type ? typeNameOf(node.type, source) : undefined;
  return jsFn(codomain === undefined ? { name, domain } : { name, domain, codomain });
}

// Collect the exported declarations directly authored in one source file.
function collectFromSource(source: ts.SourceFile): {
  types: JsType[];
  functions: JsFn[];
  subtypes: SubtypeEdge[];
} {
  const types: JsType[] = [];
  const functions: JsFn[] = [];
  const subtypes: SubtypeEdge[] = [];
  source.forEachChild((node) => {
    if (ts.isClassDeclaration(node) && isExported(node)) {
      types.push(jsType(node.name?.text ?? "default", "class"));
      for (const sup of heritageNames(node)) subtypes.push([node.name?.text ?? "default", sup]);
    } else if (ts.isInterfaceDeclaration(node) && isExported(node)) {
      types.push(jsType(node.name.text, "interface"));
      for (const sup of heritageNames(node)) subtypes.push([node.name.text, sup]);
    } else if (ts.isTypeAliasDeclaration(node) && isExported(node)) {
      types.push(jsType(node.name.text, "type-alias"));
    } else if (ts.isFunctionDeclaration(node) && isExported(node)) {
      functions.push(fnFrom(node.name?.text ?? "default", node, source));
    } else if (ts.isExportAssignment(node) && (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression))) {
      functions.push(fnFrom("default", node.expression, source));
    } else if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        // .d.ts form: `declare const f: (...) => T` — a function type annotation.
        if (decl.type && ts.isFunctionTypeNode(decl.type)) {
          functions.push(fnFrom(decl.name.text, decl.type, source));
        } else if (
          // source form: `const f = (...) => ...`
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          functions.push(fnFrom(decl.name.text, decl.initializer, source));
        }
      }
    }
  });
  return { types, functions, subtypes };
}

/** Exact source evidence for an exported declaration, with one-based positions. */
export interface DeclarationLocation {
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
}

export interface Reexport {
  readonly specifier: string;
  readonly imported?: string;
  readonly exported?: string;
}

export interface FileCatalog {
  readonly file: string;
  readonly catalog: TypeCatalog;
  readonly locations: readonly DeclarationLocation[];
  readonly reexports: readonly Reexport[];
  readonly exports: readonly Readonly<{ name: string; local: string }>[];
}

/** Syntax projection requires neither a build nor a compiler program: no
 * dependency resolution, standard-library loading, or inferred types. */
export function introspectDeclarationsByFile(entryFiles: readonly string[]): readonly FileCatalog[] {
  const out: FileCatalog[] = [];
  for (const file of entryFiles) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const part = collectFromSource(source);
    const locations: DeclarationLocation[] = [];
    const reexports: Reexport[] = [];
    const exports: { name: string; local: string }[] = [];
    const locate = (name: string, node: ts.Node): void => {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source));
      const end = source.getLineAndCharacterOfPosition(node.end);
      locations.push({ name, line: start.line + 1, column: start.character + 1, endLine: end.line + 1 });
    };
    const declarations = new Map<string, ts.Node>();
    for (const node of source.statements) {
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) {
        declarations.set(node.name.text, node);
        if (isExported(node)) {
          locate(node.name.text, node);
          exports.push({ name: (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default) ? "default" : node.name.text, local: node.name.text });
        }
      } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && isExported(node)) {
        locate("default", node); exports.push({ name: "default", local: "default" });
      } else if (ts.isExportAssignment(node) && (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression))) {
        locate("default", node); exports.push({ name: "default", local: "default" });
      } else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          declarations.set(declaration.name.text, declaration);
          if (isExported(node)) { locate(declaration.name.text, declaration); exports.push({ name: declaration.name.text, local: declaration.name.text }); }
        }
      }
    }
    for (const node of source.statements) {
      if (!ts.isExportDeclaration(node)) continue;
      const specifier = node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
      if (specifier !== undefined) {
        if (!node.exportClause) reexports.push({ specifier });
        else if (ts.isNamedExports(node.exportClause)) for (const element of node.exportClause.elements) {
          reexports.push({ specifier, imported: (element.propertyName ?? element.name).text, exported: element.name.text });
        }
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const declaration = declarations.get((element.propertyName ?? element.name).text);
          if (!declaration) continue;
          const name = (element.propertyName ?? element.name).text;
          exports.push({ name: element.name.text, local: name });
          if (part.functions.some((value) => value.name === name) || part.types.some((value) => value.name === name)) continue;
          locate(name, declaration);
          if (ts.isFunctionDeclaration(declaration)) part.functions.push(fnFrom(name, declaration, source));
          else if (ts.isClassDeclaration(declaration)) { part.types.push(jsType(name, "class")); for (const base of heritageNames(declaration)) part.subtypes.push([name, base]); }
          else if (ts.isInterfaceDeclaration(declaration)) { part.types.push(jsType(name, "interface")); for (const base of heritageNames(declaration)) part.subtypes.push([name, base]); }
          else if (ts.isTypeAliasDeclaration(declaration)) part.types.push(jsType(name, "type-alias"));
          else if (ts.isVariableDeclaration(declaration)) {
            const callable = declaration.type && ts.isFunctionTypeNode(declaration.type) ? declaration.type : declaration.initializer;
            if (callable && (ts.isFunctionTypeNode(callable) || ts.isArrowFunction(callable) || ts.isFunctionExpression(callable))) part.functions.push(fnFrom(name, callable, source));
          }
        }
      }
    }
    out.push({ file: path.resolve(file), catalog: typeCatalog(part), locations, reexports, exports });
  }
  return out;
}

export function introspectDeclarations(entryFiles: readonly string[]): TypeCatalog {
  const parts = introspectDeclarationsByFile(entryFiles).map((entry) => entry.catalog);
  return typeCatalog({ types: parts.flatMap((part) => [...part.types]), functions: parts.flatMap((part) => [...part.functions]), subtypes: parts.flatMap((part) => [...part.subtypes]) });
}

/** Read authored source and declarations, stopping at nested package boundaries. */
export function introspectDirectory(dir: string): TypeCatalog {
  return introspectDeclarations(discoverJavaScriptSourceFiles(dir, { includeDeclarations: true, stopAtPackageBoundary: true }));
}
