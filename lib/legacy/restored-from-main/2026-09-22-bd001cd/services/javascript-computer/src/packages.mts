import path from "node:path";
import { readFileSync, readdirSync, type Dirent } from "node:fs";

/** Which packages to omit from discovery. Each pattern matches a package `name`
 *  exactly, or as a `*` wildcard (`@scope/*-experimental`). Omitted or empty
 *  means exclude nothing — the caller passes what it wants gone (the CLI from
 *  `--exclude`, a programmatic caller from its own argument). */
export interface WorkspaceFilter {
  readonly exclude?: readonly string[];
}

/** A package as found on disk: declared name, absolute directory, parsed
 *  manifest. The strata walk hands these to every consumer so a manifest read
 *  once is never read again. */
export interface DiscoveredPackage {
  readonly name: string;
  readonly dir: string;
  readonly manifest: Record<string, unknown>;
}

// Compile a name pattern (exact, or with `*` wildcards) into an anchored regexp.
function compilePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function excluderFor(patterns: readonly string[]): (name: string) => boolean {
  if (patterns.length === 0) return () => false;
  const res = patterns.map(compilePattern);
  return (name) => res.some((re) => re.test(name));
}

const EXCLUDED_DIRECTORY_NAMES = new Set([".git", ".tmp", ".venv", "dist", "legacy", "node_modules", "triage"]);

function isExcludedDirectory(parent: string, name: string): boolean {
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
  root: string,
  filter: WorkspaceFilter = {},
): Generator<DiscoveredPackage> {
  const isExcluded = excluderFor(filter.exclude ?? []);
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const manifestEntry = entries.find((entry) => entry.isFile() && entry.name === "package.json");
    if (manifestEntry !== undefined) {
      let manifest: Record<string, unknown> | undefined;
      try { manifest = JSON.parse(readFileSync(path.join(dir, manifestEntry.name), "utf8")) as Record<string, unknown>; } catch { /* not a package */ }
      if (manifest !== undefined) {
        const name = typeof manifest["name"] === "string" ? (manifest["name"] as string) : path.basename(dir);
        if (!isExcluded(name)) yield { name, dir, manifest };
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || isExcludedDirectory(dir, entry.name)) continue;
      pending.push(path.join(dir, entry.name));
    }
  }
}

