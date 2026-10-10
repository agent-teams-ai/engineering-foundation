type Provenance = {
  ref: string;
  repository: string;
  sourceCommit: string;
  workflowPath: string;
};

export type ReleasePredecessor = {
  archiveIntegrity: string;
  name: string;
  provenance: Provenance;
  version: string;
};

function fail(message: string): never {
  throw new Error(`npm package bootstrap refused: ${message}`);
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).toSorted().join("\0") !== [...expected].toSorted().join("\0")
  ) {
    fail(`${label} has an unexpected inventory shape.`);
  }
}

export function assertPredecessorInventory(
  expected: unknown,
  observed: unknown,
): ReleasePredecessor {
  const inventoryKeys = ["archiveIntegrity", "name", "provenance", "version"];
  const provenanceKeys = ["ref", "repository", "sourceCommit", "workflowPath"];
  assertExactKeys(expected, inventoryKeys, "expected predecessor");
  assertExactKeys(observed, inventoryKeys, "observed predecessor");
  assertExactKeys(expected.provenance, provenanceKeys, "expected predecessor provenance");
  assertExactKeys(observed.provenance, provenanceKeys, "observed predecessor provenance");
  for (const key of inventoryKeys.filter((entry) => entry !== "provenance")) {
    if (expected[key] !== observed[key]) {
      fail(`predecessor ${key} differs from the exact reviewed inventory.`);
    }
  }
  for (const key of provenanceKeys) {
    if (expected.provenance[key] !== observed.provenance[key]) {
      fail(`predecessor provenance ${key} differs from the exact reviewed inventory.`);
    }
  }
  return Object.freeze({
    archiveIntegrity: observed.archiveIntegrity as string,
    name: observed.name as string,
    provenance: Object.freeze({ ...(observed.provenance as Provenance) }),
    version: observed.version as string,
  });
}
