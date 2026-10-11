/** Source syntax, declarations, imports, documentation, and executable behavior.
 *
 * The workspace walk (eachWorkspacePackageDir, was packages.mjs) and the workspace type index
 * built over it (workspaceTypeIndex, was workspace.mjs) live here directly now, rather than in
 * their own files. Both do real disk reads (readdirSync/readFileSync, and — through
 * discoverJavaScriptPackageSources/introspectDeclarationsByFile — a full source read per
 * package) with no effect syntax of their own textually; from a separate file that made every
 * relative import of them from this otherwise-pure re-export barrel a hull-importing-kernel
 * violation (data/records/house-architecture-norms.json, "hull-never-imports-kernel"), despite
 * this module doing nothing but forwarding. Folding them in — this file's own no-barrels
 * condensation, since it was otherwise pure `export ... from` forwarding — makes this, the
 * package's one public entry, honestly kernel: it exists to read a workspace off disk and
 * analyze it. eachWorkspacePackageDir/workspaceTypeIndex keep their exact names and call
 * signatures; every existing caller, held or not, is unaffected.
 */
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { discoverJavaScriptPackageSources } from "./source-files.mjs";
import { introspectDeclarationsByFile } from "./introspect.mjs";

export {
  introspectDeclarations,
  introspectDeclarationsByFile,
  introspectDirectory,
} from "./introspect.mjs";

export { readImports, introspectImports } from "./imports.mjs";

export { extractDocSurface } from "./documentation.mjs";

export {
  locateDocSymbols,
  readSymbolSource,
  setJsDoc,
  formatJsDoc,
} from "./documentation-edit.mjs";

export { discoverJavaScriptSourceFiles, discoverJavaScriptPackageSources } from "./source-files.mjs";

export { extractExecutableBehaviors } from "./executable-behaviors.mjs";

export { callableSubstitutionForm } from "./callable-substitution.mjs";

export { indexModuleCorpus } from "./module-corpus.mjs";

// --- packages.mjs, folded in: the single workspace-package walk ---

// Compile a name pattern (exact, or with `*` wildcards) into an anchored regexp.
function compilePattern(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function excluderFor(patterns) {
  if (patterns.length === 0) return () => false;
  const res = patterns.map(compilePattern);
  return (name) => res.some((re) => re.test(name));
}

const EXCLUDED_DIRECTORY_NAMES = new Set([".git", ".tmp", ".venv", "dist", "legacy", "node_modules", "triage"]);

function isExcludedDirectory(parent, name) {
  return EXCLUDED_DIRECTORY_NAMES.has(name)
    || (name === "worktrees" && path.basename(parent) === ".claude")
    || (name === "storage" && path.basename(parent) === "data");
}

/** The single walk of the current repository. Yields every directory holding a
 *  readable package.json, minus archival/build regions and excluded package
 *  names. The repository no longer has a flat apps/lib/services workspace, so
 *  discovery follows its actual nested service tree rather than assuming a
 *  historical root layout. */
export function* eachWorkspacePackageDir(
  root,
  filter = {},
) {
  const isExcluded = excluderFor(filter.exclude ?? []);
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const manifestEntry = entries.find((entry) => entry.isFile() && entry.name === "package.json");
    if (manifestEntry !== undefined) {
      let manifest;
      try { manifest = JSON.parse(readFileSync(path.join(dir, manifestEntry.name), "utf8")); } catch { /* not a package */ }
      if (manifest !== undefined) {
        const name = typeof manifest["name"] === "string" ? (manifest["name"]) : path.basename(dir);
        if (!isExcluded(name)) yield { name, dir, manifest };
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || isExcludedDirectory(dir, entry.name)) continue;
      pending.push(path.join(dir, entry.name));
    }
  }
}

// --- workspace.mjs, folded in: the workspace type index over that walk ---

/** Reads exactly each package's own files. A supplied manifest snapshot lets
 * context and MCP callers reuse the manifest walk they have already performed. */
export function workspaceTypeIndex(root, filter = {}, discovered) {
  const types = [];
  const functions = [];
  const subtypes = [];
  for (const pkg of discovered ?? eachWorkspacePackageDir(root, filter)) {
    const sources = discoverJavaScriptPackageSources(pkg.dir, pkg.manifest);
    const catalogs = introspectDeclarationsByFile(sources.files);
    const byFile = new Map(catalogs.map((catalog) => [catalog.file, catalog]));
    const resolveFile = (from, specifier) => {
      if (!specifier.startsWith(".")) return undefined;
      const target = path.resolve(path.dirname(from), specifier);
      const base = target.replace(/\.[cm]?js$/, "");
      for (const candidate of [target, ...[".mjs", ".js", ".cjs"].map((ext) => base + ext)]) {
        const file = byFile.get(candidate); if (file) return file;
      }
      return byFile.get(path.join(target, "index.mjs")) ?? byFile.get(path.join(target, "index.js"));
    };

    const surface = (catalog, visiting) => {
      if (visiting.has(catalog.file)) return new Map();
      const next = new Set(visiting).add(catalog.file);
      const values = new Map(catalog.exports.map((entry) => [entry.name, { file: catalog.file, name: entry.local }]));
      const explicit = new Set([...values.keys(), ...catalog.reexports.flatMap((entry) => entry.exported === undefined ? [] : [entry.exported])]);
      const ambiguous = new Set();
      for (const reexport of catalog.reexports) {
        const target = resolveFile(catalog.file, reexport.specifier); if (!target) continue;
        const exports = surface(target, next);
        if (reexport.imported !== undefined) {
          const definition = exports.get(reexport.imported);
          if (definition) values.set(reexport.exported, definition);
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
    const imports = new Map();
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
      const usedLocations = new Map();
      const evidence = (name) => {
        const occurrence = usedLocations.get(name) ?? 0;
        usedLocations.set(name, occurrence + 1);
        const location = entry.locations.filter((location) => location.name === name)[occurrence];
        return {
          ...(location ? { source: { path: entry.file, line: location.line, column: location.column, endLine: location.endLine, kind: "source" } } : {}),
          imports: imports.get(`${entry.file}\0${name}`) ?? [],
        };
      };
      for (const value of entry.catalog.types) types.push({ pkg: pkg.name, name: value.name, kind: value.kind, ...evidence(value.name) });
      for (const value of entry.catalog.functions) functions.push({ pkg: pkg.name, name: value.name, domain: value.domain, ...(value.codomain === undefined ? {} : { codomain: value.codomain }), ...evidence(value.name) });
      for (const [sub, base] of entry.catalog.subtypes) subtypes.push({ pkg: pkg.name, sub, base });
    }
  }
  return { types, functions, subtypes };
}
