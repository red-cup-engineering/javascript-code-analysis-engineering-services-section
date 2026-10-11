// Theorem-shaped tests: each name is a claim about reading and rewriting the
// documentary layer of source.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  locateDocSymbols,
  readSymbolSource,
  setJsDoc,
  formatJsDoc,
} from "./index.mjs";

const SRC = [
  "/** Adds two numbers. */",
  "export function add(a, b) {",
  "  return a + b;",
  "}",
  "",
  "export const TAU = 6.283;",
  "",
  "  export function indented(x) {",
  "    return x * 2;",
  "  }",
].join("\n");

describe("locateDocSymbols: finds exported declarations with their text", () => {
  it("add carries its full body text", () => {
    const syms = locateDocSymbols("m.mjs", SRC);
    const add = syms.find((s) => s.name === "add");
    assert.ok(add);
    assert.ok(add.text.includes("return a + b;"));
    assert.strictEqual(add.kind, "function");
  });
});

describe("locateDocSymbols: reports documented vs undocumented", () => {
  it("add is documented, TAU is not", () => {
    const syms = locateDocSymbols("m.mjs", SRC);
    assert.strictEqual(syms.find((s) => s.name === "add")?.documented, true);
    assert.strictEqual(syms.find((s) => s.name === "TAU")?.documented, false);
  });
});

describe("locateDocSymbols: captures the declaration's indent", () => {
  it("the two-space-indented function reports a two-space indent", () => {
    const syms = locateDocSymbols("m.mjs", SRC);
    assert.strictEqual(syms.find((s) => s.name === "indented")?.indent, "  ");
  });
});

describe("readSymbolSource: returns the whole declaration text", () => {
  it("reading add yields its signature and body", () => {
    const text = readSymbolSource("m.mjs", "add", {}, SRC);
    assert.ok(text);
    assert.ok(text.startsWith("export function add"));
    assert.ok(text.includes("return a + b;"));
  });
});

describe("readSymbolSource: includeDoc prepends the existing JSDoc", () => {
  it("the returned text begins with the JSDoc block", () => {
    const text = readSymbolSource("m.mjs", "add", { includeDoc: true }, SRC);
    assert.ok(text?.startsWith("/** Adds two numbers. */"));
  });
});

describe("readSymbolSource: unknown symbol yields undefined", () => {
  it("a missing name returns undefined", () => {
    assert.strictEqual(readSymbolSource("m.mjs", "nope", {}, SRC), undefined);
  });
});

describe("setJsDoc: inserts a docstring above an undocumented export", () => {
  it("TAU gains a JSDoc block and keeps its declaration", () => {
    const out = setJsDoc(SRC, "TAU", "The circle constant.");
    assert.ok(out.includes("/** The circle constant. */\nexport const TAU = 6.283;"));
  });
});

describe("setJsDoc: replaces an existing docstring, not the code", () => {
  it("add's doc is rewritten and its body is preserved", () => {
    const out = setJsDoc(SRC, "add", "Sum of a and b.");
    assert.ok(out.includes("/** Sum of a and b. */"));
    assert.ok(!out.includes("Adds two numbers."));
    assert.ok(out.includes("return a + b;"));
    // exactly one add declaration remains
    assert.strictEqual(out.match(/export function add/g)?.length, 1);
  });
});

describe("setJsDoc: matches the declaration's indentation", () => {
  it("re-documenting the indented function indents the block to match", () => {
    const out = setJsDoc(SRC, "indented", "Doubles x.");
    assert.ok(out.includes("  /** Doubles x. */\n  export function indented"));
  });
});

describe("setJsDoc: unknown symbol throws", () => {
  it("throws naming the missing symbol", () => {
    assert.throws(() => setJsDoc(SRC, "ghost", "x"), /ghost/);
  });
});

describe("setJsDoc: long prose wraps into a multi-line block", () => {
  it("a long description becomes a framed multi-line comment", () => {
    const long =
      "This is a deliberately long description that should exceed the wrap width and therefore be rendered as a multi-line JSDoc block with star-prefixed continuation lines.";
    const out = setJsDoc(SRC, "TAU", long);
    assert.ok(out.includes("/**\n"));
    assert.ok(out.includes(" * "));
    assert.ok(out.includes(" */"));
  });
});

describe("formatJsDoc: a short description is a single-line block", () => {
  it("renders /** text */ on one line", () => {
    assert.strictEqual(formatJsDoc("Hi.", ""), "/** Hi. */");
  });
});

describe("formatJsDoc: round-trips through locateDocSymbols", () => {
  it("a set doc reads back as the same collapsed text", () => {
    const out = setJsDoc(SRC, "TAU", "The circle constant.");
    const doc = locateDocSymbols("m.mjs", out).find((s) => s.name === "TAU")?.doc;
    assert.strictEqual(doc, "The circle constant.");
  });
});
