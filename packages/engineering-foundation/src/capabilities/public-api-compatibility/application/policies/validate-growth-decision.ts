import type { GrowthDecision } from "../model/growth-admission.js";
import { assertGrowthCoordinateShape } from "./validate-growth-observation.js";

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))) { throw new Error("Malformed growth decision record"); }
  return value as Record<string, unknown>;
}
function text(value: unknown): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 4096) { throw new Error("Missing growth decision text"); }
}
function digest(value: unknown): void {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) { throw new Error("Invalid growth decision digest"); }
}
function commit(value: unknown): void {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) { throw new Error("Invalid growth decision source"); }
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100_000) { throw new Error("Invalid growth decision collection"); }
  return value;
}

/** Closed metadata validation only; exact matching and trusted owner evidence
 * remain separate requirements. No date is inferred for a supported surface. */
export function isGrowthDecision(value: unknown): value is GrowthDecision {
  try {
    const decision = record(value, ["contractRevision", "decisionId", "ownerRef", "stability", "transitions", "coordinates", "changeFingerprint", "consumerEvidenceRefs", "exposureRationale", "compatibilityRationale", "lifecycle"]);
    if (decision["contractRevision"] !== "foundation:sdk-growth:c0:5"
      || typeof decision["stability"] !== "string" || !["development", "experimental", "supported"].includes(decision["stability"])) { return false; }
    for (const key of ["decisionId", "ownerRef", "exposureRationale", "compatibilityRationale"]) { text(decision[key]); }
    digest(decision["changeFingerprint"]);
    const transitions = array(decision["transitions"]);
    transitions.forEach(digest);
    if (new Set(transitions).size !== transitions.length) { return false; }
    array(decision["coordinates"]).forEach(assertGrowthCoordinateShape);
    for (const raw of array(decision["consumerEvidenceRefs"])) {
      const evidence = record(raw, ["useCase", "repository", "source", "artifactDigest"]);
      text(evidence["useCase"]); text(evidence["repository"]);
      const source = record(evidence["source"], ["tree", "contentDigest", "commit"]);
      commit(source["tree"]); digest(source["contentDigest"]);
      if (source["commit"] !== null) { commit(source["commit"]); }
      if (evidence["artifactDigest"] !== null) { digest(evidence["artifactDigest"]); }
    }
    const lifecycle = decision["lifecycle"];
    if (lifecycle === null || typeof lifecycle !== "object" || !("kind" in lifecycle)) { return false; }
    if (lifecycle.kind === "ordinary") { record(lifecycle, ["kind"]); }
    else {
      if (typeof lifecycle.kind !== "string" || !["shim", "deprecation", "removal"].includes(lifecycle.kind)) { return false; }
      const conditions = record(lifecycle, ["kind", "replacement", "migration", "removalConditions"]);
      for (const key of ["replacement", "migration", "removalConditions"]) { text(conditions[key]); }
    }
    return true;
  } catch { return false; }
}
