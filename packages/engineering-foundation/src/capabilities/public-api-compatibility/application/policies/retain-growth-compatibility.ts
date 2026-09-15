import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import { GrowthObservationInvariantError } from "../model/growth-observation.js";
import type { GrowthCancellation, GrowthCompatibilityPackage, GrowthEvidence } from "../model/growth-observation.js";
import type { PublicApiArtifactSnapshot, PublicApiPackagePolicy, PublicApiSnapshot } from "../model/public-api.js";
import type { PublicApiExtractor } from "../ports/public-api-extractor.js";
import type { PackageArtifactInventory } from "../ports/package-artifact-inventory.js";
import { artifactApiProjection } from "./artifact-api-projection.js";

export interface GrowthCompatibilitySubject {
  readonly policy: PublicApiPackagePolicy;
  readonly packageVersion: string;
}

export interface RetainedGrowthCompatibility {
  readonly compatibility: GrowthCompatibilityPackage;
  readonly artifactObservation: GrowthEvidence<PublicApiArtifactSnapshot>;
}

function unavailable(reason: string): GrowthEvidence<PublicApiSnapshot> {
  return { status: "unavailable", reasons: [reason] };
}

/** Retain the original v1 payloads, never reconstruct them from growth hashes.
 * Observer failures are stable unavailable evidence; invalid provenance is an
 * invariant failure. Cancellation is always propagated, including after I/O.
 */
export async function retainGrowthCompatibility(input: {
  readonly consumerRoot: string;
  readonly subjects: readonly GrowthCompatibilitySubject[];
  readonly extractorVersion: string;
  readonly cancellation: GrowthCancellation;
}, dependencies: {
  readonly typed: PublicApiExtractor;
  readonly artifact: PackageArtifactInventory;
}): Promise<readonly RetainedGrowthCompatibility[]> {
  if (input.extractorVersion === "package-artifact-inventory/1") {
    throw new GrowthObservationInvariantError("typed-observer-provenance-mismatch");
  }
  const subjects = input.subjects.toSorted((a, b) => compareBinaryStrings(a.policy.packageName, b.policy.packageName));
  for (let index = 1; index < subjects.length; index += 1) {
    if (subjects[index]?.policy.packageName === subjects[index - 1]?.policy.packageName) {
      throw new GrowthObservationInvariantError("duplicate-compatibility-package");
    }
  }
  const rows: RetainedGrowthCompatibility[] = [];
  for (const subject of subjects) {
    input.cancellation.throwIfCancelled();
    const { policy, packageVersion } = subject;
    let typed: GrowthEvidence<PublicApiSnapshot>;
    try {
      typed = { status: "available", value: structuredClone(await dependencies.typed.extract(input.consumerRoot, policy, packageVersion)) };
    } catch {
      input.cancellation.throwIfCancelled();
      typed = unavailable("typed-observation-unavailable");
    }
    input.cancellation.throwIfCancelled();
    if (typed.status === "available" && (typed.value.packageName !== policy.packageName || typed.value.packageVersion !== packageVersion || typed.value.extractorVersion !== input.extractorVersion || typed.value.schemaVersion !== 1)) {
      throw new GrowthObservationInvariantError("typed-observer-provenance-mismatch");
    }
    let artifact: GrowthEvidence<PublicApiSnapshot>;
    let snapshots: readonly PublicApiArtifactSnapshot[] | undefined;
    let artifactObservation: GrowthEvidence<PublicApiArtifactSnapshot>;
    try {
      snapshots = structuredClone(await dependencies.artifact.inspect(input.consumerRoot, [policy]));
    } catch {
      input.cancellation.throwIfCancelled();
    }
    input.cancellation.throwIfCancelled();
    if (snapshots === undefined) {
      artifact = unavailable("artifact-observation-unavailable");
      artifactObservation = { status: "unavailable", reasons: ["artifact-observation-unavailable"] };
    } else {
      const snapshot = snapshots[0];
      if (snapshots.length !== 1 || snapshot === undefined || snapshot.packageName !== policy.packageName || snapshot.packageVersion !== packageVersion || snapshot.schemaVersion !== 1) {
        throw new GrowthObservationInvariantError("artifact-observer-provenance-mismatch");
      }
      artifact = { status: "available", value: artifactApiProjection(snapshot) };
      artifactObservation = { status: "available", value: snapshot };
    }
    rows.push({ compatibility: { packageName: policy.packageName, typed: { kind: "typed", snapshot: typed }, artifact: { kind: "artifact", snapshot: artifact } }, artifactObservation });
  }
  return rows;
}
