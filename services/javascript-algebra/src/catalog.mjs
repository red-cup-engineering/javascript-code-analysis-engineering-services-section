// catalog.mts — the carrier of the type category.
//
// A TypeCatalog bundles the objects (types), the morphisms (functions), and the
// declared assignability relation as directed subtype edges (sub <: sup). It is
// pure data: lookups are direct, one-step reads. The reflexive-transitive
// closure of assignability and the section reads over morphisms live in
// @emsenn/javascript-topology, the way settling and sheaf reads live in
// meme-topology rather than meme-algebra.

export function typeCatalog(input

) {
  return Object.freeze({
    kind: "javascript.type-catalog",
    types: Object.freeze([...(input.types ?? [])]),
    functions: Object.freeze([...(input.functions ?? [])]),
    subtypes: Object.freeze(
      (input.subtypes ?? []).map((e) => Object.freeze([e[0], e[1]])),
    ),
  });
}

export function findType(cat, name) {
  return cat.types.find((t) => t.name === name);
}

export function hasType(cat, name) {
  return cat.types.some((t) => t.name === name);
}

// Direct (reflexive + one declared step) assignability: `a` is assignable to
// `b` when they are the same object or `a <: b` is a declared edge. The
// transitive closure is the topology's job.
export function directlyAssignable(cat, a, b) {
  return a === b || cat.subtypes.some(([sub, sup]) => sub === a && sup === b);
}
