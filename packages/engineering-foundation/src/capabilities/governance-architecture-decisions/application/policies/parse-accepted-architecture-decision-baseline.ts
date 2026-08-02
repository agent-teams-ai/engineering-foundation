import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import type {
  AcceptedArchitectureDecisionBaseline,
  AcceptedArchitectureDecisionBaselineEntry
} from "../model/architecture-decision.js";

const ADR_ID = /^ADR-\d{4}$/u;
const IMMUTABLE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const UNSAFE_PATH_CHARACTER = /[\\*?{}[\]]/u;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  return Object.keys(value).every((key) => expected.includes(key));
}

function isRepositoryMarkdownPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.endsWith(".md") &&
    !value.startsWith("/") &&
    !UNSAFE_PATH_CHARACTER.test(value) &&
    value.split("/").every(
      (segment) => segment.length > 0 && segment !== "." && segment !== ".."
    )
  );
}

function parseEntry(input: {
  readonly candidate: unknown;
  readonly ids: ReadonlySet<string>;
  readonly paths: ReadonlySet<string>;
}): AcceptedArchitectureDecisionBaselineEntry | undefined {
  const entry = record(input.candidate);
  const id = entry?.["id"];
  const path = entry?.["path"];
  const immutableDigest = entry?.["immutableDigest"];
  if (
    entry === undefined ||
    typeof id !== "string" ||
    !ADR_ID.test(id) ||
    typeof path !== "string" ||
    !isRepositoryMarkdownPath(path) ||
    typeof immutableDigest !== "string" ||
    !IMMUTABLE_DIGEST.test(immutableDigest) ||
    !hasOnlyKeys(entry, ["id", "path", "immutableDigest"]) ||
    input.ids.has(id) ||
    input.paths.has(path)
  ) {
    return undefined;
  }
  return Object.freeze({ id, immutableDigest, path });
}

function entryComparison(
  left: AcceptedArchitectureDecisionBaselineEntry,
  right: AcceptedArchitectureDecisionBaselineEntry
): number {
  return (
    compareBinaryStrings(left.id, right.id) ||
    compareBinaryStrings(left.path, right.path)
  );
}

export function parseAcceptedArchitectureDecisionBaselineValue(
  value: unknown
): AcceptedArchitectureDecisionBaseline | undefined {
  const baseline = record(value);
  if (
    baseline?.["schemaVersion"] !== 1 ||
    baseline["algorithm"] !== "sha256" ||
    !Array.isArray(baseline["decisions"]) ||
    !hasOnlyKeys(baseline, ["schemaVersion", "algorithm", "decisions"])
  ) {
    return undefined;
  }

  const ids = new Set<string>();
  const paths = new Set<string>();
  const decisions: AcceptedArchitectureDecisionBaselineEntry[] = [];
  for (const candidate of baseline["decisions"]) {
    const entry = parseEntry({ candidate, ids, paths });
    if (entry === undefined) {
      return undefined;
    }
    ids.add(entry.id);
    paths.add(entry.path);
    decisions.push(entry);
  }

  const sorted = decisions.toSorted(entryComparison);
  if (decisions.some((entry, index) => entry !== sorted[index])) {
    return undefined;
  }
  return Object.freeze({
    algorithm: "sha256",
    decisions: Object.freeze(decisions),
    schemaVersion: 1
  });
}
