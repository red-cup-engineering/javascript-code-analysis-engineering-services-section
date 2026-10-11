import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  jsType,
  sameType,
  jsFn,
  composableAt,
  composeAt,
  typeCatalog,
  findType,
  hasType,
  directlyAssignable,
} from "./index.mjs";

describe("jsType", () => {
  it("constructs a frozen object with a kind, defaulting to type-alias", () => {
    const t = jsType("Foo");
    assert.equal(t.name, "Foo");
    assert.equal(t.kind, "type-alias");
    assert.ok(Object.isFrozen(t));
  });
  it("identity is by name, ignoring kind", () => {
    assert.ok(sameType(jsType("Foo", "class"), jsType("Foo", "interface")));
    assert.ok(!sameType(jsType("Foo"), jsType("Bar")));
  });
  it("rejects an empty name", () => {
    assert.throws(() => jsType(""), TypeError);
  });
});

describe("jsFn", () => {
  it("omits codomain entirely when not given (exactOptionalPropertyTypes)", () => {
    const f = jsFn({ name: "sink", domain: ["A"] });
    assert.ok(!("codomain" in f));
    assert.deepEqual(f.domain, ["A"]);
  });
  it("is a multicategory morphism: tuple domain, single codomain", () => {
    const f = jsFn({ name: "combine", domain: ["A", "B"], codomain: "C" });
    assert.deepEqual(f.domain, ["A", "B"]);
    assert.equal(f.codomain, "C");
  });
});

describe("operadic composition", () => {
  const outer = jsFn({ name: "f", domain: ["A", "B"], codomain: "Z" });
  const inner = jsFn({ name: "g", domain: ["X", "Y"], codomain: "B" });
  it("composableAt checks the inner codomain fills the named slot", () => {
    assert.ok(composableAt(outer, 1, inner));
    assert.ok(!composableAt(outer, 0, inner)); // slot 0 wants A, g gives B
  });
  it("composeAt splices the inner domain into the slot, keeping outer codomain", () => {
    const h = composeAt(outer, 1, inner);
    assert.deepEqual(h.domain, ["A", "X", "Y"]);
    assert.equal(h.codomain, "Z");
  });
  it("composeAt refuses a non-composable slot", () => {
    assert.throws(() => composeAt(outer, 0, inner), TypeError);
  });
});

describe("typeCatalog", () => {
  const cat = typeCatalog({
    types: [jsType("Animal", "interface"), jsType("Dog", "class")],
    functions: [jsFn({ name: "bark", domain: ["Dog"], codomain: "void" })],
    subtypes: [["Dog", "Animal"]],
  });
  it("finds and tests membership of objects", () => {
    assert.equal(findType(cat, "Dog")?.kind, "class");
    assert.ok(hasType(cat, "Animal"));
    assert.ok(!hasType(cat, "Cat"));
  });
  it("directlyAssignable is reflexive and one declared step, not transitive", () => {
    assert.ok(directlyAssignable(cat, "Dog", "Dog")); // reflexive
    assert.ok(directlyAssignable(cat, "Dog", "Animal")); // declared edge
    assert.ok(!directlyAssignable(cat, "Animal", "Dog")); // wrong direction
  });
});
