// morphism.mts — morphisms of the JavaScript type category.
//
// A JsFn is a morphism (T1, ..., Tn) -> U: a function from a tuple of input
// types (the domain) to an output type (the codomain). Because the domain is a
// tuple rather than a single object, this is a multicategory (an operad of
// types), not a plain category — JS functions take many arguments. Composition
// is therefore operadic: substituting a morphism into one input slot of
// another. Domain and codomain are type *names*; resolution against a catalog
// of objects is the catalog's concern, closures are the topology's.

export function jsFn(input

) {
  if (!input.name) throw new TypeError("jsFn: name is required");
  const domain = Object.freeze([...(input.domain ?? [])]);
  return Object.freeze(
    input.codomain === undefined
      ? { name: input.name, domain }
      : { name: input.name, domain, codomain: input.codomain },
  );
}

// Operadic composability: `inner`'s codomain exactly fills `outer`'s slot-th
// input. (Assignability widening is a topology concern; the algebra composes on
// exact names only.)
export function composableAt(outer, slot, inner) {
  return (
    inner.codomain !== undefined &&
    slot >= 0 &&
    slot < outer.domain.length &&
    outer.domain[slot] === inner.codomain
  );
}

// Operadic substitution: plug `inner` into `outer`'s slot, splicing inner's
// domain into that position; the result's codomain is `outer`'s, unchanged.
export function composeAt(outer, slot, inner) {
  if (!composableAt(outer, slot, inner)) {
    throw new TypeError(
      `composeAt: ${inner.name} (codomain ${inner.codomain ?? "∅"}) does not fill slot ${slot} of ${outer.name}`,
    );
  }
  const domain = [
    ...outer.domain.slice(0, slot),
    ...inner.domain,
    ...outer.domain.slice(slot + 1),
  ];
  const name = `${outer.name}∘${slot}:${inner.name}`;
  return jsFn(
    outer.codomain === undefined
      ? { name, domain }
      : { name, domain, codomain: outer.codomain },
  );
}
