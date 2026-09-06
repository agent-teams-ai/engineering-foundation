export function createUniqueRegistry<Value>(
  registryKind: string,
  entries: Iterable<readonly [string, Value]>
): ReadonlyMap<string, Value> {
  const registry = new Map<string, Value>();
  for (const [id, value] of entries) {
    if (registry.has(id)) {
      throw new Error(`Duplicate ${registryKind} ID: ${id}.`);
    }
    registry.set(id, value);
  }
  return registry;
}
