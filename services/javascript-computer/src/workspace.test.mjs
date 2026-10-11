import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// workspace.mjs was folded into index.mjs (this package's no-barrels condensation: see
// index.mjs's own header comment) -- workspaceTypeIndex keeps its name and signature, just its
// module.
import { workspaceTypeIndex } from "./index.mjs";

let root;

function pkg(dir, name, declarations) {
  const packageDir = path.join(root, "packages", dir);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name, version: "0.0.0" }),
    "utf8",
  );
  for (const [relative, source] of Object.entries(declarations)) {
    const file = path.join(packageDir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source, "utf8");
  }
}

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "workspace-type-index-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  pkg("module", "@x/module", {
    "src/types/module.mjs": `
      /** @typedef {{ value: string }} ModuleInput */
      /** @typedef {{ value: string }} ModuleOutput */
      /** @param {ModuleInput} input @returns {ModuleOutput} */
      export function moduleTransform(input) { return input; }
    `,
  });
  pkg("commonjs", "@x/commonjs", {
    "src/types/commonjs.cjs": `
      /** @typedef {{ value: number }} CommonInput */
      /** @typedef {{ value: number }} CommonOutput */
      /** @param {CommonInput} input @returns {CommonOutput} */
      export function commonTransform(input) { return input; }
    `,
  });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("workspaceTypeIndex authored source discovery", () => {
  it("includes unbuilt .mjs and .cjs module contracts in the workspace type graph", () => {
    const index = workspaceTypeIndex(root);
    assert.deepEqual(
      index.types.map((type) => type.name).sort(),
      ["CommonInput", "CommonOutput", "ModuleInput", "ModuleOutput"],
    );
    assert.deepEqual(
      index.functions.map((fn) => fn.name).sort(),
      ["commonTransform", "moduleTransform"],
    );

  });
});

 it("attributes nested sources once and traces public reexports to actual definitions", () => {
  pkg("parent", "@x/parent", { "src/index.mjs": "export const parent = () => 1;", "services/child/package.json": JSON.stringify({ name: "@x/child", exports: { ".": "./src/index.mjs", "./detail": "./src/detail.mjs" } }), "services/child/src/index.mjs": "export { transform as convert } from './detail.mjs';", "services/child/src/detail.mjs": "export function transform(value) { return value; }\nexport function internalOnly() {}", "services/child/dist/detail.mjs": "export function stale() {}" });
  const index = workspaceTypeIndex(root);
  const found = index.functions.filter((value) => value.name === "transform");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.pkg, "@x/child");
  assert.equal(found[0]?.source?.line, 1);
  assert.equal(found[0]?.source?.kind, "source");
  assert.deepEqual(found[0]?.domain, ["unknown"]);
  assert.deepEqual(found[0]?.imports, [{ specifier: "@x/child", name: "convert" }, { specifier: "@x/child/detail", name: "transform" }]);
  assert.ok(!index.functions.some((value) => value.name === "stale"));
  assert.deepEqual(index.functions.find((value) => value.name === "internalOnly")?.imports, [{ specifier: "@x/child/detail", name: "internalOnly" }]);
 });
 it("distinguishes modules a package does not export", () => {
  pkg("private", "@x/private", { "package.json": JSON.stringify({ name: "@x/private", exports: "./src/index.mjs" }), "src/index.mjs": "export function publicFunction() {}", "src/private.mjs": "export function privateModuleFunction() {}" });
  const index = workspaceTypeIndex(root);
  assert.deepEqual(index.functions.find((value) => value.name === "privateModuleFunction")?.imports, []);
 });

it("does not invent public import routes for ambiguous star exports", () => {
  pkg("ambiguous", "@x/ambiguous", {
    "package.json": JSON.stringify({ name: "@x/ambiguous", exports: "./src/index.mjs" }),
    "src/index.mjs": "export * from './one.mjs'; export * from './two.mjs'; export { chosen } from './one.mjs';",
    "src/one.mjs": "export function collision() {} export function chosen() {}",
    "src/two.mjs": "export function collision() {} export function chosen() {}",
  });
  const functions = workspaceTypeIndex(root).functions.filter((value) => value.pkg === "@x/ambiguous");
  assert.ok(functions.filter((value) => value.name === "collision").every((value) => value.imports?.length === 0));
  assert.equal(functions.filter((value) => value.name === "chosen").flatMap((value) => value.imports ?? []).length, 1);
});
