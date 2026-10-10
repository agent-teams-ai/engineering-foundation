import type { ObservationBinding, TestDispatchObservation } from "../model/check-changed.js";

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}
function suites(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 1024 && value.every((suite: unknown) => typeof suite === "string" && suite.length > 0 && suite.length <= 240) && new Set(value).size === value.length;
}
function identity(entry: Record<string, unknown>, binding: ObservationBinding, runnerIdentity: string): boolean {
  if (entry["schemaVersion"] !== 1 || entry["runnerIdentity"] !== runnerIdentity || runnerIdentity.length === 0 || runnerIdentity.length > 240) { return false; }
  return (["invocationId", "sourceIdentity", "configIdentity", "checkId"] as const).every((key) => entry[key] === binding[key]);
}
function validOutcome(value: unknown): value is TestDispatchObservation["outcome"] {
  return value === "passed" || value === "empty-selection" || value === "failed" || value === "cancelled";
}
export function parseTestDispatchObservation(value: unknown, binding: ObservationBinding, runnerIdentity: string): TestDispatchObservation | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) { return null; }
  const entry = value as Record<string, unknown>;
  const keys = ["schemaVersion", "runnerIdentity", "invocationId", "sourceIdentity", "configIdentity", "checkId", "selectedSuites", "executed", "skipped", "outcome"];
  if (Object.keys(entry).length !== keys.length || keys.some((key) => !Object.hasOwn(entry, key)) || !identity(entry, binding, runnerIdentity)) { return null; }
  const selectedSuites = entry["selectedSuites"], executed = entry["executed"], skipped = entry["skipped"], outcome = entry["outcome"];
  if (!suites(selectedSuites) || !count(executed) || !count(skipped)) { return null; }
  if (!validOutcome(outcome)) { return null; }
  if (outcome === "empty-selection" && (selectedSuites.length !== 0 || executed !== 0 || skipped !== 0)) { return null; }
  if (outcome === "passed" && (selectedSuites.length === 0 || executed === 0)) { return null; }
  return Object.freeze({ ...binding, schemaVersion: 1, runnerIdentity, selectedSuites: Object.freeze([...selectedSuites]), executed, skipped, outcome });
}
