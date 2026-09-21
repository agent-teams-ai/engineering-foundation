import type { GrowthCompatibilityPackage } from "../../../application/model/growth-observation.js";
import type { GrowthObservationPort } from "../../../application/ports/growth-observation.js";
import type { ResolvedGrowthInputContextPort } from "../../../application/ports/growth-input-context.js";
import { GrowthObservationInvariantError } from "../../../application/model/growth-observation.js";
import { growthCanonicalJson, normalizeGrowthObservation } from "../../../application/policies/normalize-growth-observation.js";
import { validateGrowthExecution } from "../../../application/policies/validate-growth-execution.js";
import { metadataRootObservation } from "../../../application/policies/validate-growth-metadata-root.js";
import type { ChangeFingerprint } from "../../../application/ports/change-fingerprint.js";

/** The trusted observation boundary selects independently verified archive
 * observations. Workspace snapshots supply compatibility evidence only; neither
 * they nor a context payload may rewrite the selected S1 observation. */
export function createVerifiedGrowthObservation(local: GrowthObservationPort, context: ResolvedGrowthInputContextPort,
  fingerprint?: ChangeFingerprint): GrowthObservationPort {
  return { async observe(invocation, cancellation) {
    const workspace = await local.observe(invocation, cancellation);
    validateGrowthExecution(workspace, invocation);
    if (workspace.surface.status !== "available") { return workspace; }
    const candidates = context.packedCandidates();
    const roots = context.resolution().grant.metadataRoots;
    if (roots.length > 0 && fingerprint === undefined) { throw new GrowthObservationInvariantError("growth-metadata-root-fingerprint-required"); }
    const metadata = roots.map((root) => metadataRootObservation(root, "candidate", invocation, fingerprint!));
    const packages = [...candidates.map((row) => row.packageName), ...roots.map((root) => root.evidence.packageName)].toSorted();
    if (new Set(packages).size !== packages.length
      || growthCanonicalJson(packages) !== growthCanonicalJson(workspace.surface.value.coverage.map((row) => row.packageName).toSorted())) {
      throw new GrowthObservationInvariantError("growth-authority-candidate-scope-mismatch");
    }
    for (const candidate of candidates) {
      validateGrowthExecution({ identity: invocation, surface: { status: "available", value: candidate.observation }, compatibilitySnapshots: workspace.compatibilitySnapshots.filter((row) => row.packageName === candidate.packageName) }, invocation);
    }
    const value = normalizeGrowthObservation({ ...invocation, contractRevision: "foundation:sdk-growth:c0:5",
      observationVersion: "foundation:sdk-growth:observation:1",
      coverage: [...candidates.flatMap((row) => row.observation.coverage), ...metadata.flatMap((row) => row.coverage)],
      entries: [...candidates.flatMap((row) => row.observation.entries), ...metadata.flatMap((row) => row.entries)] });
    const entries = new Map(value.entries.map((entry) => [growthCanonicalJson(entry.coordinate), entry]));
    const workspaceEntries = new Map(workspace.surface.value.entries.map((entry) => [growthCanonicalJson(entry.coordinate), entry]));
    const coverage = new Map(value.coverage.map((row) => [row.packageName, row]));
    for (const [key, entry] of workspaceEntries) {
      const candidate = entries.get(key);
      if (candidate !== undefined && growthCanonicalJson(candidate.value) !== growthCanonicalJson(entry.value)) {
        throw new GrowthObservationInvariantError("growth-authority-overlapping-observation-mismatch");
      }
      if (candidate === undefined && entry.value.state === "present"
        && coverage.get(entry.coordinate.packageName)?.dimensions.some((row) => row.dimension === "packed" && row.status === "complete") === true) {
        throw new GrowthObservationInvariantError("growth-authority-packed-absence-mismatch");
      }
    }
    const compatibilitySnapshots = workspace.compatibilitySnapshots.map((row): GrowthCompatibilityPackage => {
      const missing = value.entries.filter((entry) => entry.coordinate.packageName === row.packageName && entry.value.state === "present"
        && !workspaceEntries.has(growthCanonicalJson(entry.coordinate)));
      const unavailable: GrowthCompatibilityPackage["typed"]["snapshot"] = { status: "unavailable", reasons: ["growth-packed-compatibility-evidence-unavailable"] };
      return { ...row,
        typed: missing.some((entry) => entry.coordinate.subject.kind === "typed") ? { kind: "typed", snapshot: unavailable } : row.typed,
        artifact: missing.some((entry) => entry.coordinate.subject.kind === "data" || entry.coordinate.subject.kind === "wildcard-member")
          ? { kind: "artifact", snapshot: unavailable } : row.artifact };
    });
    cancellation.throwIfCancelled();
    return { identity: structuredClone(invocation), surface: { status: "available", value }, compatibilitySnapshots };
  } };
}
