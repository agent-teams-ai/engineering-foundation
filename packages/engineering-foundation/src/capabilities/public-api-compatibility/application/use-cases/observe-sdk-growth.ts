import type { GrowthWorkspaceReader } from "../ports/growth-workspace.js";
import type { GrowthCancellation, GrowthCompatibilityPackage, GrowthInvocation, GrowthObservationExecution } from "../model/growth-observation.js";
import { GrowthObservationInvariantError, GrowthObservationUnavailableError } from "../model/growth-observation.js";
import type { GrowthObservationPort } from "../ports/growth-observation.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import type { PackageArtifactInventory } from "../ports/package-artifact-inventory.js";
import type { PublicApiExtractor } from "../ports/public-api-extractor.js";
import type { GrowthCompatibilitySubject } from "../policies/retain-growth-compatibility.js";
import { retainGrowthCompatibility } from "../policies/retain-growth-compatibility.js";
import { growthCanonicalJson, growthUniqueSorted, normalizeGrowthInvocation, normalizeGrowthObservation } from "../policies/normalize-growth-observation.js";
import { projectGrowthPackage } from "../policies/project-growth-package.js";

function freeze(item: unknown): void {
  if (item !== null && typeof item === "object") {
    for (const nested of Object.values(item)) { freeze(nested); }
    Object.freeze(item);
  }
}
function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  freeze(copy);
  return copy;
}
function missingCompatibility(packageName: string): GrowthCompatibilityPackage {
  const snapshot = { status: "unavailable" as const, reasons: ["package-observer-policy-unavailable"] };
  return { packageName, typed: { kind: "typed", snapshot }, artifact: { kind: "artifact", snapshot } };
}

/** Private Pure DI composition of existing observations. Inputs select files and
 * existing v1 policies, never candidate identity or consumer classifications.
 * All discovered packages are conservatively governed. Private-only admission,
 * packed qualification, decisions and trust are not inferred here.
 */
export function createGrowthObservation(input: {
  readonly consumerRoot: string;
  readonly workspaceManifestPath: string;
  readonly subjects: readonly GrowthCompatibilitySubject[];
}, dependencies: {
  readonly workspace: GrowthWorkspaceReader;
  readonly typed: PublicApiExtractor;
  readonly artifact: PackageArtifactInventory;
  readonly fingerprint: ChangeFingerprint;
}): GrowthObservationPort {
  // Freeze the caller's selector data so it cannot change between low-level calls.
  const selected = immutable(input);
  return {
    async observe(invocation: GrowthInvocation, cancellation: GrowthCancellation): Promise<GrowthObservationExecution> {
      cancellation.throwIfCancelled();
      const identity = immutable(normalizeGrowthInvocation(invocation));
      const subjects = growthUniqueSorted(selected.subjects, (subject) => subject.policy.packageName);
      let inventory;
      try { inventory = immutable(await dependencies.workspace.read(selected.consumerRoot, selected.workspaceManifestPath, cancellation.signal)); }
      catch {
        cancellation.throwIfCancelled();
        return immutable({ identity, surface: { status: "unavailable", reasons: ["workspace-observation-unavailable"] }, compatibilitySnapshots: [] });
      }
      cancellation.throwIfCancelled();
      const packages = growthUniqueSorted(inventory.packages, (pkg) => pkg.name);
      if (packages.length === 0) {
        return immutable({ identity, surface: { status: "unavailable", reasons: ["workspace-topology-empty"] }, compatibilitySnapshots: [] });
      }
      growthUniqueSorted(packages, (pkg) => pkg.manifestPath);
      for (const subject of subjects) {
        const pkg = packages.find((candidate) => candidate.name === subject.policy.packageName);
        if (pkg === undefined || pkg.manifestPath !== subject.policy.manifestPath || pkg.rootPath !== subject.policy.packageRoot) {
          throw new GrowthObservationInvariantError("growth-policy-outside-observed-topology");
        }
        growthUniqueSorted(subject.policy.entrypoints, (entry) => entry.exportPath);
        growthUniqueSorted(subject.policy.nonTypeExports, (entry) => entry.exportPath);
        growthUniqueSorted(subject.policy.approvedBreakingChanges, (entry) => entry.fingerprint);
      }
      const retained = await retainGrowthCompatibility({ consumerRoot: selected.consumerRoot, subjects, extractorVersion: identity.tool.extractorVersion, cancellation }, dependencies);
      const compatibilitySnapshots = packages.map((pkg) => retained.find((row) => row.compatibility.packageName === pkg.name)?.compatibility ?? missingCompatibility(pkg.name));
      try {
        const projections = packages.map((pkg) => {
          cancellation.throwIfCancelled();
          return projectGrowthPackage({ pkg, subject: subjects.find((subject) => subject.policy.packageName === pkg.name), retained: retained.find((row) => row.compatibility.packageName === pkg.name) }, dependencies.fingerprint);
        });
        const entries = projections.flatMap((projection) => projection.entries);
        if (entries.length > 100_000) {
          return immutable({ identity, surface: { status: "unavailable", reasons: ["growth-entry-budget-exhausted"] }, compatibilitySnapshots });
        }
        const value = normalizeGrowthObservation({ ...identity, contractRevision: "foundation:sdk-growth:c0:5", observationVersion: "foundation:sdk-growth:observation:1", coverage: projections.map((projection) => projection.coverage), entries });
        growthCanonicalJson({ domain: "foundation:sdk-growth:observation:1", payload: value });
        cancellation.throwIfCancelled();
        return immutable({ identity, surface: { status: "available", value }, compatibilitySnapshots });
      } catch (error) {
        cancellation.throwIfCancelled();
        if (!(error instanceof GrowthObservationUnavailableError)) { throw error; }
        return immutable({ identity, surface: { status: "unavailable", reasons: [error.reason] }, compatibilitySnapshots });
      }
    }
  };
}
