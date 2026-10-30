import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { workspaceTypeIndex } from "./workspace.mjs";

let root: string;

function pkg(dir: string, name: string, declarations: Record<string, string>): void {
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
    "src/types/module.mts": `
      export interface ModuleInput { value: string; }
      export interface ModuleOutput { value: string; }
      export declare function moduleTransform(input: ModuleInput): ModuleOutput;
    `,
  });
  pkg("commonjs", "@x/commonjs", {
    "src/types/commonjs.cts": `
      export interface CommonInput { value: number; }
      export interface CommonOutput { value: number; }
      export declare function commonTransform(input: CommonInput): CommonOutput;
    `,
  });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("workspaceTypeIndex authored source discovery", () => {
  it("includes unbuilt .mts and .cts module declarations in the workspace type graph", () => {
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
  pkg("parent", "@x/parent", { "src/index.mjs": "export const parent = () => 1;", "services/child/package.json": JSON.stringify({ name: "@x/child", exports: { ".": "./dist/index.mjs", "./detail": "./src/detail.mjs" } }), "services/child/src/index.mts": "export { transform as convert } from './detail.mjs';", "services/child/src/detail.mjs": "export function transform(value) { return value; }\nexport function internalOnly() {}", "services/child/dist/detail.d.mts": "export declare function stale(): void;" });
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
 it("retains explicitly declared declaration-only delivery and distinguishes inaccessible modules", () => {
  pkg("declarations", "@x/declarations", { "package.json": JSON.stringify({ name: "@x/declarations", types: "./dist/index.d.mts" }), "dist/index.d.mts": "export declare function declared(value: string): number;" });
  pkg("private", "@x/private", { "package.json": JSON.stringify({ name: "@x/private", exports: "./src/index.mjs" }), "src/index.mjs": "export function publicFunction() {}", "src/private.mjs": "export function privateModuleFunction() {}" });
  const index = workspaceTypeIndex(root);
  const declared = index.functions.find((value) => value.name === "declared");
  assert.equal(declared?.source?.kind, "declaration");
  assert.deepEqual(declared?.imports, [{ specifier: "@x/declarations", name: "declared" }]);
  assert.deepEqual(index.functions.find((value) => value.name === "privateModuleFunction")?.imports, []);
 });

it("joins hand-authored JavaScript declarations to their implementation without losing overloads", () => {
  pkg("paired", "@x/paired", { "package.json": JSON.stringify({ name: "@x/paired", exports: { ".": { import: "./index.mjs", types: "./index.d.mts" } } }), "index.mjs": "export function paired(value) { return value; }", "index.d.mts": "export declare function paired(value: string): string;\nexport declare function paired(value: number): number;" });
  const values = workspaceTypeIndex(root).functions.filter((value) => value.name === "paired");
  assert.equal(values.length, 2);
  assert.deepEqual(values.map((value) => value.domain), [["string"], ["number"]]);
  assert.deepEqual(values.map((value) => value.declaration?.line), [1, 2]);
  assert.ok(values.every((value) => value.source?.path.endsWith("/index.mjs") && value.declaration?.path.endsWith("/index.d.mts")));
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
