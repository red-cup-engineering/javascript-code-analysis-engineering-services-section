import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverJavaScriptSourceFiles } from "./source-files.mjs";

test("excludes .venv (Python virtualenv trees carry no JavaScript source)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "source-files-test-"));
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "index.mjs"), "export const x = 1;");
    mkdirSync(path.join(root, ".venv", "lib", "python3.13", "site-packages"), { recursive: true });
    writeFileSync(path.join(root, ".venv", "lib", "python3.13", "site-packages", "shim.js"), "module.exports = 1;");
    const files = discoverJavaScriptSourceFiles(root);
    assert.deepEqual(files, [path.join(root, "src", "index.mjs")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
