import path from "node:path";
import { readdirSync, existsSync } from "node:fs";
import ts from "typescript";

const JAVASCRIPT_SOURCE_EXTENSIONS = new Set([
  ".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx",
]);
const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  ".git", ".tmp", ".venv", "coverage", "deps", "dist", "legacy", "node_modules", "pagefind", "triage", "vendor",
]);

export interface JavaScriptSourceFileOptions {
  readonly excludeDirectories?: readonly string[];
  readonly includeDeclarations?: boolean;
  /** Stop before nested packages; their source belongs to their own carrier. */
  readonly stopAtPackageBoundary?: boolean;
}

/** Discover authored JavaScript and TypeScript source below a directory.
 *
 * This is the shared filesystem boundary for syntax-based JavaScript analysis.
 * Callers decide what to do with the files; they do not independently grow
 * subtly different recursive walkers.
 */
export function discoverJavaScriptSourceFiles(
  root: string,
  options: JavaScriptSourceFileOptions = {},
): readonly string[] {
  const excluded = new Set(options.excludeDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES);
  const files: string[] = [];
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    if (dir !== path.resolve(root) && options.stopAtPackageBoundary && entries.some((entry) => entry.isFile() && entry.name === "package.json")) continue;
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) pending.push(file);
      } else if (
        entry.isFile() && JAVASCRIPT_SOURCE_EXTENSIONS.has(path.extname(entry.name))
        && (options.includeDeclarations === true || ! /\.d\.[cm]?ts$/.test(entry.name))
      ) {
        files.push(file);
      }
    }
  }
  return Object.freeze(files.sort());
}

export interface JavaScriptPackageSources {
  readonly files: readonly string[];
  /** Actual source entry files selected by each declared package subpath. */
  readonly entries: ReadonlyMap<string, readonly string[]>;
}

/** Package source and declared public entries, without requiring emitted files.
 * Declaration-only delivery is read only from manifest-selected entries. */
export function discoverJavaScriptPackageSources(dir: string, manifest: Record<string, unknown>): JavaScriptPackageSources {
  const root = path.resolve(dir);
  const files = [...discoverJavaScriptSourceFiles(root, { includeDeclarations: true, stopAtPackageBoundary: true })];
  const known = new Set(files);
  const configPath = ["tsconfig.build.json", "tsconfig.json"].map((file) => path.join(root, file)).find(existsSync);
  const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile).config : undefined;
  const options = config?.compilerOptions ?? {};
  const outputRoot = path.resolve(root, options.outDir ?? "dist");
  const sourceRoot = path.resolve(root, options.rootDir ?? "src");
  const targets = (value: unknown): string[] => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(targets) : [];
  const exports = manifest["exports"];
  const subpaths: [string, unknown][] = exports && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith("."))
    ? Object.entries(exports as Record<string, unknown>)
    : exports !== undefined ? [[".", exports]] : [[".", [manifest["types"], manifest["typings"], manifest["main"] ?? "index.js"]]];
  const entries = new Map<string, readonly string[]>();
  const variants = (file: string): string[] => {
    const base = file.replace(/(?:\.d)?\.[cm]?[jt]sx?$/, "");
    return [file, ...[".mts", ".ts", ".tsx", ".mjs", ".js", ".jsx", ".cts", ".cjs", ".d.mts", ".d.ts", ".d.cts"].map((extension) => base + extension)];
  };
  for (const [subpath, value] of subpaths) {
    if (subpath === "./package.json") continue;
    const selected = new Set<string>();
    for (const target of targets(value)) {
      if (!target.startsWith("./") && !target.startsWith("src/") && !target.startsWith("dist/") && !target.startsWith("index.")) continue;
      const absolute = path.resolve(root, target);
      if (target.includes("*")) {
        const [prefix, suffix] = absolute.split("*");
        for (const file of files) if (file.startsWith(prefix!) && file.endsWith(suffix!)) {
          const part = file.slice(prefix!.length, file.length - suffix!.length);
          entries.set(subpath.replace("*", part), [file]);
        }
        continue;
      }
      const relativeOutput = path.relative(outputRoot, absolute);
      const mapped = !relativeOutput.startsWith("..") && !path.isAbsolute(relativeOutput) ? path.join(sourceRoot, relativeOutput) : absolute;
      const authored = variants(mapped).filter((candidate) => known.has(candidate));
      if (authored.length > 0) for (const file of authored) selected.add(file);
      else if (/\.d\.[cm]?ts$/.test(absolute) && existsSync(absolute)) { selected.add(absolute); known.add(absolute); files.push(absolute); }
    }
    if (selected.size) entries.set(subpath, [...selected]);
  }
  return { files: [...new Set(files)].sort(), entries };
}
