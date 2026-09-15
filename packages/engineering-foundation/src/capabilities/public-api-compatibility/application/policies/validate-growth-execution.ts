// Runtime evidence may violate TypeScript literal types; retain fail-closed checks.
import type { GrowthEvidence, GrowthInvocation, GrowthObservationExecution } from "../model/growth-observation.js";
import { GrowthObservationInvariantError } from "../model/growth-observation.js";
import { growthCanonicalJson, growthUniqueSorted, normalizeGrowthInvocation, normalizeGrowthObservation } from "./normalize-growth-observation.js";

function invariant(reason: string): never { throw new GrowthObservationInvariantError(reason); }
export function assertGrowthEvidence<T>(evidence: GrowthEvidence<T>): void {
  if (evidence.status === "available") { return; }
  if ((evidence.status as unknown) !== "unavailable" || evidence.reasons.length === 0
    || evidence.reasons.some((reason) => typeof reason !== "string" || reason.trim().length === 0)) {
    invariant("growth-evidence-reasons-missing");
  }
  growthUniqueSorted(evidence.reasons, (reason) => reason);
}

/** Validate the one S1 handoff before any admission or release comparison. */
export function validateGrowthExecution(execution: GrowthObservationExecution, invocation: GrowthInvocation): void {
  if (growthCanonicalJson(normalizeGrowthInvocation(execution.identity)) !== growthCanonicalJson(normalizeGrowthInvocation(invocation))) {
    invariant("growth-execution-identity-mismatch");
  }
  assertGrowthEvidence(execution.surface);
  const rows = growthUniqueSorted(execution.compatibilitySnapshots, (row) => row.packageName);
  if (execution.surface.status === "available") {
    const surface = normalizeGrowthObservation(execution.surface.value);
    const identity = { repository: surface.repository, sourceCommit: surface.sourceCommit, sourceTree: surface.sourceTree,
      topologyDigest: surface.topologyDigest, lockDigest: surface.lockDigest, toolchainDigest: surface.toolchainDigest,
      artifactDigests: surface.artifactDigests, tool: surface.tool };
    if (growthCanonicalJson(normalizeGrowthInvocation(identity)) !== growthCanonicalJson(normalizeGrowthInvocation(invocation))) {
      invariant("growth-surface-identity-mismatch");
    }
    if (growthCanonicalJson(rows.map((row) => row.packageName)) !== growthCanonicalJson(surface.coverage.map((row) => row.packageName))) {
      invariant("growth-compatibility-topology-mismatch");
    }
  }
  for (const row of rows) {
    if ((row.typed as { readonly kind?: unknown } | undefined)?.kind !== "typed" || (row.artifact as { readonly kind?: unknown } | undefined)?.kind !== "artifact") { invariant("growth-compatibility-branch-mismatch"); }
    for (const branch of ["typed", "artifact"] as const) {
      const snapshot = row[branch].snapshot;
      assertGrowthEvidence(snapshot);
      if (snapshot.status === "available" && (snapshot.value.packageName !== row.packageName || (snapshot.value.schemaVersion as unknown) !== 1
        || snapshot.value.extractorVersion !== (branch === "typed" ? invocation.tool.extractorVersion : "package-artifact-inventory/1"))) {
        invariant("growth-compatibility-provenance-mismatch");
      }
    }
    if (row.typed.snapshot.status === "available" && row.artifact.snapshot.status === "available"
      && row.typed.snapshot.value.packageVersion !== row.artifact.snapshot.value.packageVersion) {
      invariant("growth-compatibility-version-mismatch");
    }
  }
}
