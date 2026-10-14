import { bindJavaScript } from '@red-cup-engineering/javascript-node-services-section/javascript-parser';

/** Read module declaration occurrences inside one authored binding pattern.
 * Each occurrence retains its canonical binding and its own source identifier;
 * keys, nested scopes and initializer references are not declaration occurrences. */
export function declarationBindings(program, pattern, binding = bindJavaScript(program)) {
  return binding.declarationOccurrences.filter(item => item.binding.scope.node === program
    && item.identifier.start >= pattern.start && item.identifier.end <= pattern.end);
}
