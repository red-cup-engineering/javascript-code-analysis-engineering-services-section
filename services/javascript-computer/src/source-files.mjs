import path from "node:path";
import { readdirSync } from "node:fs";

const JAVASCRIPT_SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  ".git", ".tmp", ".venv", "coverage", "deps", "dist", "legacy", "node_modules", "pagefind", "triage", "vendor",
]);

/** Discover authored JavaScript source below a directory.
 *
 * This is the shared filesystem boundary for syntax-based JavaScript analysis.
 * Callers decide what to do with the files; they do not independently grow
 * subtly different recursive walkers.
 */
export function discoverJavaScriptSourceFiles(
  root,
  options = {},
) {
  const excluded = new Set(options.excludeDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES);
  const files = [];
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    if (dir !== path.resolve(root) && options.stopAtPackageBoundary && entries.some((entry) => entry.isFile() && entry.name === "package.json")) continue;
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) pending.push(file);
      } else if (
        entry.isFile() && JAVASCRIPT_SOURCE_EXTENSIONS.has(path.extname(entry.name))
      ) {
        files.push(file);
      }
    }
  }
  return Object.freeze(files.sort());
}

/** Package source and the authored files its manifest exports, keyed by subpath. */
export function discoverJavaScriptPackageSources(dir, manifest) {
  const root = path.resolve(dir);
  const files = [...discoverJavaScriptSourceFiles(root, { stopAtPackageBoundary: true })];
  const known = new Set(files);
  const targets = (value) => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(targets) : [];
  const exports = manifest["exports"];
  const subpaths = exports && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith("."))
    ? Object.entries(exports)
    : exports !== undefined ? [[".", exports]] : [[".", [manifest["main"] ?? "index.js"]]];
  const entries = new Map();
  for (const [subpath, value] of subpaths) {
    if (subpath === "./package.json") continue;
    const selected = new Set();
    for (const target of targets(value)) {
      if (!target.startsWith("./") && !target.startsWith("src/") && !target.startsWith("index.")) continue;
      const absolute = path.resolve(root, target);
      if (target.includes("*")) {
        const [prefix, suffix] = absolute.split("*");
        for (const file of files) if (file.startsWith(prefix) && file.endsWith(suffix)) entries.set(subpath.replace("*", file.slice(prefix.length, file.length - suffix.length)), [file]);
        continue;
      }
      if (known.has(absolute)) selected.add(absolute);
    }
    if (selected.size) entries.set(subpath, [...selected]);
  }
  return { files: [...new Set(files)].sort(), entries };
}
