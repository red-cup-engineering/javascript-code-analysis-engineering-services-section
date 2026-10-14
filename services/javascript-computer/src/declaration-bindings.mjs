import { bindJavaScript } from '@red-cup-engineering/javascript-node-services-section/javascript-parser';

/** Read real module bindings inside one authored declaration pattern. Keys,
 * nested scopes and initializer expressions are not exported binding names. */
export function declarationBindings(program, pattern, binding = bindJavaScript(program)) {
  return binding.bindings.filter(item => item.scope.node === program
    && item.identifier.start >= pattern.start && item.identifier.end <= pattern.end);
}
