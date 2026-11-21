// Field names a document can't carry. `$clocks` is where a document keeps its fields' clocks,
// and `key` is the document's own key wherever documents are listed (`{ key, ...fields }`).
// The names every object already has (`__proto__`, `constructor`, `toString`, …) are refused
// too: assigning `__proto__` sets that object's prototype, and `constructor` / `prototype`
// are what a recursive merge walks. `prototype` is not one of Object.prototype's own names,
// so it is listed on its own.
const INHERITED = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);

/** Whether `name` must not be stored or assigned on a document. */
export function refusedField(name) {
  return typeof name !== 'string' || name === 'key' || name === '$clocks' || INHERITED.has(name);
}

/**
 * Assign `value` to `target[name]` when the name is safe. Returns false and leaves `target`
 * alone for a refused name, so `__proto__` cannot replace `target`'s prototype.
 */
export function assignField(target, name, value) {
  if (refusedField(name)) return false;
  target[name] = value;
  return true;
}
