const IMMUTABLE_SOURCE_ROOT_EXCLUSIONS = new Set([".agent-teams-local", ".cache", ".git", "target"]);
const MUTATION_OBSERVATION_ROOT_EXCLUSIONS = new Set([".cache", ".git", "target"]);

export function hasInfrastructureSegment(repositoryPath: string): boolean {
  return repositoryPath.split("/").some((segment) => segment === ".git" || segment === "node_modules");
}

export interface QualificationEvidencePolicy {
  readonly governedRoots: readonly string[];
}

export type QualificationEvidenceEntryKind = "directory" | "file" | "other" | "symbolic-link";

export function qualificationEvidencePolicy(governedRoots: readonly string[]): QualificationEvidencePolicy {
  if (governedRoots.length > 32 || governedRoots.some((path) =>
    path.startsWith("/") || path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))) {
    throw new TypeError("Qualification governed roots must be a bounded canonical repository-path set.");
  }
  return Object.freeze({
    governedRoots: Object.freeze([...new Set(governedRoots)].toSorted((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right))))
  });
}

export function overlapsGovernedRoot(repositoryPath: string, policy: QualificationEvidencePolicy): boolean {
  return policy.governedRoots.some((root) => repositoryPath === root ||
    repositoryPath.startsWith(`${root}/`) || root.startsWith(`${repositoryPath}/`));
}

/** Excludes only unambiguous source-local state and root build caches. */
export function isQualificationSourceCopyExcludedPath(
  repositoryPath: string,
  entryKind: QualificationEvidenceEntryKind
): boolean {
  if (hasInfrastructureSegment(repositoryPath)) {return true;}
  if (entryKind !== "directory") {return false;}
  const [rootSegment] = repositoryPath.split("/");
  return IMMUTABLE_SOURCE_ROOT_EXCLUSIONS.has(rootSegment ?? "");
}

/** Keeps qualification-owned local state observable so previews cannot hide side effects there. */
export function isQualificationMutationObservationExcludedPath(
  repositoryPath: string,
  entryKind: QualificationEvidenceEntryKind
): boolean {
  if (hasInfrastructureSegment(repositoryPath)) {return true;}
  if (entryKind !== "directory") {return false;}
  const [rootSegment] = repositoryPath.split("/");
  return MUTATION_OBSERVATION_ROOT_EXCLUSIONS.has(rootSegment ?? "");
}

export function changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): readonly string[] {
  return Object.freeze([...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
}
