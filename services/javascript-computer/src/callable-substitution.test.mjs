import assert from "node:assert/strict";
import test from "node:test";
import { callableSubstitutionForm as form } from "./callable-substitution.mjs";

test("callable comparison retains constants, defaults and binding relationships", () => {
  const key = (body) => form(body, "/fixture.mts", "f");
  assert.notEqual(key("function f(x) { return x * 60; }"), key("function f(x) { return x * 3600; }"));
  assert.notEqual(key("function f(x = 1) { return x; }"), key("function f(x = 2) { return x; }"));
  assert.notEqual(key("function f(x,y) { return x-y; }"), key("function f(x,y) { return x-x; }"));
  assert.notEqual(key("function f() { return `input-tokens`; }"), key("function f() { return `output-tokens`; }"));
  assert.notEqual(key("function f(x) { return {x}; }"), key("function f(y) { return {y}; }"));
});

test("callable comparison admits local alpha renaming and ignores comments and exports", () => {
  assert.equal(form("export function left(input) { const value = input?.count; return Number.isInteger(value) ? value : 0; }", "/a.mts", "left"),
    form("function right(raw) { /* same */ const n=raw?.count; return Number.isInteger(n)?n:0; }", "/b.mts", "right"));
  assert.equal(form("function f() { return undefined; }", "/a.mjs", "f"), form("function g() { return undefined; }", "/b.mjs", "g"));
});

test("callable comparison keeps different captures and shadowed globals distinct", () => {
  const text = "const limit = 1; function f(x) { return x + limit; }";
  assert.notEqual(form(text, "/a.mts", "f"), form(text, "/b.mts", "f"));
  assert.notEqual(form("const Number={}; function f(x){return Number.isInteger(x);}", "/a.mts", "f"), form("function f(x){return Number.isInteger(x);}", "/b.mts", "f"));
  assert.notEqual(form("function f(x) { let y=x; {let y=2;} return y; }", "/a.mts", "f"), form("function f(x) { let y=x; {y=2;} return y; }", "/a.mts", "f"));
});

test("callable comparison refuses dynamic environments and reflection", () => {
  for (const body of ["this.value", "arguments[0]", "eval('x')", "new.target"]) assert.equal(form(`function f(x) { return ${body}; }`, "/a.mts", "f"), null);
});
