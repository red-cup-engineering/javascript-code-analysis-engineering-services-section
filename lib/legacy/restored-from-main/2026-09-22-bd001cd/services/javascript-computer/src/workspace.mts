/** Attributed declarations read from current source, independently of builds. */
import path from "node:path";
import { discoverJavaScriptPackageSources } from "./source-files.mjs";
import { introspectDeclarationsByFile, type FileCatalog } from "./introspect.mjs";
import { eachWorkspacePackageDir, type WorkspaceFilter, type DiscoveredPackage } from "./packages.mjs";

export interface SourceLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly kind: "source" | "declaration";
}
export interface PublicImport { readonly specifier: string; readonly name: string }
interface AttributedDeclaration {
  readonly pkg: string;
  readonly name: string;
  readonly source?: SourceLocation;
  readonly declaration?: SourceLocation;
  /** Empty means a module export, without an observed public package route. */
  readonly imports?: readonly PublicImport[];
}
export interface AttributedType extends AttributedDeclaration { readonly kind: string }
export interface AttributedFunction extends AttributedDeclaration { readonly domain: readonly string[]; readonly codomain?: string }
export interface AttributedSubtype { readonly pkg: string; readonly sub: string; readonly base: string }
export interface WorkspaceTypeIndex {
  readonly types: readonly AttributedType[];
  readonly functions: readonly AttributedFunction[];
  readonly subtypes: readonly AttributedSubtype[];
}

/** Reads exactly each package's own files. A supplied manifest snapshot lets
 * context and MCP callers reuse the manifest walk they have already performed. */
export function workspaceTypeIndex(root: string, filter: WorkspaceFilter = {}, discovered?: readonly DiscoveredPackage[]): WorkspaceTypeIndex {
  const types: AttributedType[] = [];
  const functions: AttributedFunction[] = [];
  const subtypes: AttributedSubtype[] = [];
  for (const pkg of discovered ?? eachWorkspacePackageDir(root, filter)) {
    const sources = discoverJavaScriptPackageSources(pkg.dir, pkg.manifest);
    const catalogs = introspectDeclarationsByFile(sources.files);
    const byFile = new Map(catalogs.map((catalog) => [catalog.file, catalog]));
    const resolveFile = (from: string, specifier: string): FileCatalog | undefined => {
      if (!specifier.startsWith(".")) return undefined;
      const target = path.resolve(path.dirname(from), specifier);
      const base = target.replace(/(?:\.d)?\.[cm]?[jt]sx?$/, "");
      for (const candidate of [target, ...[".mts", ".ts", ".tsx", ".mjs", ".js", ".cts", ".cjs", ".d.mts", ".d.ts", ".d.cts"].map((ext) => base + ext)]) {
        const file = byFile.get(candidate); if (file) return file;
      }
      return byFile.get(path.join(target, "index.ts")) ?? byFile.get(path.join(target, "index.mjs"));
    };
    type Definition = { file: string; name: string };
    const surface = (catalog: FileCatalog, visiting: Set<string>): Map<string, Definition> => {
      if (visiting.has(catalog.file)) return new Map();
      const next = new Set(visiting).add(catalog.file);
      const values = new Map(catalog.exports.map((entry) => [entry.name, { file: catalog.file, name: entry.local }]));
      const explicit = new Set([...values.keys(), ...catalog.reexports.flatMap((entry) => entry.exported === undefined ? [] : [entry.exported])]);
      const ambiguous = new Set<string>();
      for (const reexport of catalog.reexports) {
        const target = resolveFile(catalog.file, reexport.specifier); if (!target) continue;
        const exports = surface(target, next);
        if (reexport.imported !== undefined) {
          const definition = exports.get(reexport.imported);
          if (definition) values.set(reexport.exported!, definition);
        } else for (const [name, definition] of exports) {
          if (name === "default" || explicit.has(name) || ambiguous.has(name)) continue;
          const previous = values.get(name);
          if (previous && (previous.file !== definition.file || previous.name !== definition.name)) {
            values.delete(name); ambiguous.add(name);
          } else values.set(name, definition);
        }
      }
      return values;
    };
    const imports = new Map<string, PublicImport[]>();
    for (const [subpath, files] of sources.entries) for (const file of files) {
      const catalog = byFile.get(file); if (!catalog) continue;
      for (const [name, definition] of surface(catalog, new Set())) {
        const key = `${definition.file}\0${definition.name}`;
        const entries = imports.get(key) ?? [];
        const specifier = subpath === "." ? pkg.name : pkg.name + subpath.slice(1);
        if (!entries.some((entry) => entry.specifier === specifier && entry.name === name)) entries.push({ specifier, name });
        imports.set(key, entries);
      }
    }
    for (const entry of catalogs) {
      const usedLocations = new Map<string, number>();
      const evidence = (name: string) => {
        const occurrence = usedLocations.get(name) ?? 0;
        usedLocations.set(name, occurrence + 1);
        const location = entry.locations.filter((location) => location.name === name)[occurrence];
        return {
          ...(location ? { source: { path: entry.file, line: location.line, column: location.column, endLine: location.endLine, kind: /\.d\.[cm]?ts$/.test(entry.file) ? "declaration" as const : "source" as const } } : {}),
          imports: imports.get(`${entry.file}\0${name}`) ?? [],
        };
      };
      for (const value of entry.catalog.types) types.push({ pkg: pkg.name, name: value.name, kind: value.kind, ...evidence(value.name) });
      for (const value of entry.catalog.functions) functions.push({ pkg: pkg.name, name: value.name, domain: value.domain, ...(value.codomain === undefined ? {} : { codomain: value.codomain }), ...evidence(value.name) });
      for (const [sub, base] of entry.catalog.subtypes) subtypes.push({ pkg: pkg.name, sub, base });
    }
  }
  // A hand-authored declaration beside JavaScript describes that implementation;
  // preserve its signature and both coordinates instead of returning two APIs.
  const join = <T extends AttributedDeclaration>(values: readonly T[]): T[] => {
    const groups = new Map<string, T[]>();
    for (const value of values) {
      const stem = value.source?.path.replace(/(?:\.d)?\.[cm]?[jt]sx?$/, "");
      const key = `${value.pkg}\0${stem}\0${value.name}`;
      const group = groups.get(key) ?? []; group.push(value); groups.set(key, group);
    }
    return [...groups.values()].flatMap((group) => {
      const implementation = group.find((value) => value.source?.kind === "source");
      const declarations = group.filter((value) => value.source?.kind === "declaration");
      if (!implementation || !declarations.length) return group;
      return declarations.map((declaration) => {
        const routes = [...(implementation.imports ?? []), ...(declaration.imports ?? [])];
        const imports = routes.filter((route, index) => routes.findIndex((candidate) => candidate.specifier === route.specifier && candidate.name === route.name) === index);
        return { ...declaration, source: implementation.source!, declaration: declaration.source!, imports };
      });
    });
  };
  return { types: join(types), functions: join(functions), subtypes };
}
