// type.mts — objects of the JavaScript type category.
//
// A JsType is an object of the category: a named type carrying a kind. Types
// are the carrier set over which functions (morphisms) act. Identity is by
// name; within a catalog a name denotes one object, and `kind` is a fact about
// that object (how it was declared), not part of its identity.

export const TYPE_KINDS = Object.freeze([
  "class",
  "interface",
  "type-alias",
  "primitive",
]);

export function jsType(name, kind = "type-alias") {
  if (!name) throw new TypeError("jsType: name is required");
  return Object.freeze({ name, kind });
}

// Objects are equal when they denote the same name. Two declarations of the
// same name with different kinds are a collision, not two objects.
export function sameType(a, b) {
  return a.name === b.name;
}
