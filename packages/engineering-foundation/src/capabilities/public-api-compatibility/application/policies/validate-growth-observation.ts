import { GrowthObservationInvariantError, GrowthObservationUnavailableError, growthDimensions } from "../model/growth-observation.js";

function invalid(): never { throw new GrowthObservationInvariantError("invalid-growth-observation-shape"); }
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) { invalid(); }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) { invalid(); }
  return value as Record<string, unknown>;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) { invalid(); }
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) { invalid(); }
  return value;
}
function oneOf(value: unknown, values: readonly string[]): void {
  if (typeof value !== "string" || !values.includes(value)) { invalid(); }
}
const growthIdentityFields = ["repository", "sourceCommit", "sourceTree", "topologyDigest", "lockDigest", "toolchainDigest", "artifactDigests", "tool"] as const;

function identity(value: Record<string, unknown>): void {
  for (const field of growthIdentityFields) {
    if (field !== "tool" && field !== "artifactDigests") { text(value[field]); }
  }
  for (const digest of array(value["artifactDigests"])) { text(digest); }
  const tool = record(value["tool"], ["version", "artifactDigest", "extractorVersion"]);
  for (const field of Object.values(tool)) { text(field); }
}
export function assertGrowthInvocationShape(value: unknown): void {
  identity(record(value, growthIdentityFields));
}
function coordinate(value: unknown): void {
  const entry = record(value, ["packageName", "exportPath", "resolutionBranch", "subject"]);
  text(entry["packageName"]); text(entry["exportPath"]);
  for (const step of array(entry["resolutionBranch"])) {
    if (step !== null && typeof step === "object" && "condition" in step) {
      text(record(step, ["condition"])["condition"]);
    } else {
      const index = record(step, ["index"])["index"];
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) { invalid(); }
    }
  }
  const subject = entry["subject"];
  if (subject === null || typeof subject !== "object" || !("kind" in subject)) { invalid(); }
  switch (subject.kind) {
    case "typed": text(record(subject, ["kind", "canonicalReference"])["canonicalReference"]); break;
    case "bin": text(record(subject, ["kind", "name"])["name"]); break;
    case "data": case "wildcard-member": text(record(subject, ["kind", "member"])["member"]); break;
    case "export-branch": case "package": record(subject, ["kind"]); break;
    default: invalid();
  }
}
function coverage(value: unknown): void {
  const row = record(value, ["packageName", "classification", "dimensions"]);
  text(row["packageName"]);
  oneOf(row["classification"], ["governed", "private-only"]);
  for (const raw of array(row["dimensions"])) {
    const entry = record(raw, ["dimension", "status", "reasons"]);
    oneOf(entry["dimension"], growthDimensions);
    oneOf(entry["status"], ["complete", "limited", "unsupported", "unavailable"]);
    for (const reason of array(entry["reasons"])) { text(reason); }
  }
}
export function assertGrowthObservationShape(value: unknown): void {
  const observation = record(value, [...growthIdentityFields, "contractRevision", "observationVersion", "coverage", "entries"]);
  identity(observation);
  for (const row of array(observation["coverage"])) { coverage(row); }
  const entries = array(observation["entries"]);
  if (entries.length > 100_000) { throw new GrowthObservationUnavailableError("growth-entry-budget-exhausted"); }
  for (const raw of entries) {
    const entry = record(raw, ["coordinate", "value"]);
    coordinate(entry["coordinate"]);
    const valueRef = entry["value"];
    if (valueRef === null || typeof valueRef !== "object" || !("state" in valueRef)) { invalid(); }
    switch (valueRef.state) {
      case "absent": record(valueRef, ["state"]); break;
      case "present": text(record(valueRef, ["state", "digest"])["digest"]); break;
      default: invalid();
    }
  }
}
