import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { introspectDirectory, introspectDeclarationsByFile } from "./index.mjs";

const FIXTURE = `
/** @typedef {{ legs: number }} Animal */
/** @typedef {string} Sound */
export class Base {}
export class Dog extends Base {
  bark() { return "woof"; }
}
/**
 * @param {Animal} animal
 * @param {number} amount
 * @returns {void}
 */
export function feed(animal, amount) {}
/** @returns {Dog} */
export const adopt = () => new Dog();
class Hidden {}
`;

let dir;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "jscomputer-"));
  writeFileSync(path.join(dir, "surface.mjs"), FIXTURE, "utf8");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("introspectDirectory", () => {
  it("reads exported classes and JSDoc type definitions as typed objects", () => {
    const cat = introspectDirectory(dir);
    const byName = new Map(cat.types.map((t) => [t.name, t.kind]));
    assert.equal(byName.get("Animal"), "type-alias");
    assert.equal(byName.get("Dog"), "class");
    assert.equal(byName.get("Sound"), "type-alias");
    assert.ok(!byName.has("Hidden")); // not exported
  });

  it("reads extends clauses as subtype edges", () => {
    const cat = introspectDirectory(dir);
    assert.ok(cat.subtypes.some(([sub, sup]) => sub === "Dog" && sup === "Base"));
  });

  it("reads exported functions as morphisms with domain and codomain", () => {
    const cat = introspectDirectory(dir);
    const feed = cat.functions.find((f) => f.name === "feed");
    assert.ok(feed);
    assert.deepEqual(feed.domain, ["Animal", "number"]);
    assert.equal(feed.codomain, "void");
  });

  it("reads an exported arrow const as a morphism", () => {
    const cat = introspectDirectory(dir);
    const adopt = cat.functions.find((f) => f.name === "adopt");
    assert.ok(adopt);
    assert.deepEqual(adopt.domain, []);
    assert.equal(adopt.codomain, "Dog");
  });
});

describe("introspectDeclarationsByFile", () => {
  it("returns a catalog per entry file, keyed by source path, for attribution", () => {
    const a = path.join(dir, "a.mjs");
    const b = path.join(dir, "b.mjs");
    writeFileSync(a, "/** @typedef {{ core: number }} Apple */\n", "utf8");
    writeFileSync(b, "/**\n * @param {Apple} a\n * @returns {Apple}\n */\nexport function pick(a) { return a; }\n", "utf8");
    const byFile = introspectDeclarationsByFile([a, b]);
    const fileA = byFile.find((f) => f.file.endsWith("a.mjs"));
    const fileB = byFile.find((f) => f.file.endsWith("b.mjs"));
    assert.ok(fileA && fileB);
    assert.deepEqual(fileA.catalog.types.map((t) => t.name), ["Apple"]);
    assert.deepEqual(fileB.catalog.functions.map((f) => f.name), ["pick"]);
    assert.equal(fileA.catalog.functions.length, 0); // Apple's file declares no functions
  });
});

it("reads local export aliases from unbuilt JavaScript with exact coordinates", () => {
  const source = path.join(dir, "authored.mjs");
  writeFileSync(source, "function hidden(value) { return value; }\nexport { hidden as exposed };\n");
  const result = introspectDeclarationsByFile([source])[0];
  assert.deepEqual(result.catalog.functions.map((value) => value.name), ["hidden"]);
  assert.deepEqual(result.locations, [{ name: "hidden", line: 1, column: 1, endLine: 1 }]);
  assert.deepEqual(result.catalog.functions[0]?.domain, ["unknown"]);
  assert.deepEqual(result.exports, [{ name: "exposed", local: "hidden" }]);
});

it("preserves generic JSDoc types and anonymous default callables", () => {
  const source = path.join(dir, "default.mjs");
  writeFileSync(source, "/**\n * @param {readonly string[]} values\n * @returns {Promise<string[]>}\n */\nexport default (values) => Promise.resolve([...values]);");
  const result = introspectDeclarationsByFile([source])[0];
  assert.equal(result.catalog.functions[0]?.name, "default");
  assert.equal(result.catalog.functions[0]?.codomain, "Promise<string[]>");
  assert.deepEqual(result.exports, [{ name: "default", local: "default" }]);
});
