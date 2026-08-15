const changesetIdPattern = /^[A-Za-z0-9_-]+$/u;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStrings(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

export function exactChangesetPreState(preState) {
  return (
    isRecord(preState) &&
    Object.keys(preState).toSorted().join(",") === "changesets,initialVersions,mode,tag" &&
    Array.isArray(preState.changesets) &&
    preState.changesets.every((id) => typeof id === "string" && changesetIdPattern.test(id)) &&
    new Set(preState.changesets).size === preState.changesets.length &&
    isRecord(preState.initialVersions)
  );
}

export function assertExactChangesetInventory(inventory, preState) {
  const expectedMetadata = preState === undefined
    ? ["README.md", "config.json"]
    : ["README.md", "config.json", "pre.json"];
  const expectedPending = exactChangesetPreState(preState)
    ? preState.changesets.map((id) => `${id}.md`).toSorted()
    : [];
  if (
    inventory.unexpected.length > 0 ||
    !sameStrings(inventory.metadata, expectedMetadata) ||
    !sameStrings(inventory.pending, expectedPending)
  ) {
    throw new Error(
      "Release publication requires exact Changesets metadata and consumed prerelease files.",
    );
  }
}
