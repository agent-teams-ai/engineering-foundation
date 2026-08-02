import {
  immutableArchitectureDecisionPayload,
  type AcceptedArchitectureDecisionBaseline,
  type AcceptedArchitectureDecisionBaselineEntry,
  type ArchitectureDecision
} from "../model/architecture-decision.js";
import type { ArchitectureDecisionFingerprint } from "../ports/architecture-decision-fingerprint.js";

const ADR_ID = /^ADR-\d{4}$/u;
const IMMUTABLE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const UNSAFE_PATH_CHARACTER = /[\\*?{}[\]]/u;

export type HistoricalArchitectureDecisionBaselineViolation =
  | {
      readonly id: string;
      readonly kind: "missing";
      readonly path: string;
    }
  | {
      readonly actualPath: string;
      readonly expectedPath: string;
      readonly id: string;
      readonly kind: "path-mismatch";
    }
  | {
      readonly actualDigest: string;
      readonly expectedDigest: string;
      readonly id: string;
      readonly kind: "digest-mismatch";
    };

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

function entryComparison(
  left: AcceptedArchitectureDecisionBaselineEntry,
  right: AcceptedArchitectureDecisionBaselineEntry
): number {
  return left.id.localeCompare(right.id) || left.path.localeCompare(right.path);
}

/**
 * Parses the persisted baseline strictly enough for immutable-history checks.
 * The JSON Schema remains the external contract; this parser keeps policy code
 * synchronous and defensive when a consumer has malformed historical input.
 */
export function parseAcceptedArchitectureDecisionBaseline(
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
    const entry = record(candidate);
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
      ids.has(id) ||
      paths.has(path)
    ) {
      return undefined;
    }
    ids.add(id);
    paths.add(path);
    decisions.push(Object.freeze({ id, immutableDigest, path }));
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

export function buildAcceptedArchitectureDecisionBaseline(input: {
  readonly decisions: readonly ArchitectureDecision[];
  readonly fingerprint: ArchitectureDecisionFingerprint;
}): AcceptedArchitectureDecisionBaseline {
  const decisions = input.decisions
    .filter((decision) => decision.status !== "proposed")
    .map((decision) =>
      Object.freeze({
        id: decision.id,
        immutableDigest: input.fingerprint.digest(
          immutableArchitectureDecisionPayload(decision)
        ),
        path: decision.document.repositoryPath
      })
    )
    .toSorted(entryComparison);
  return Object.freeze({
    algorithm: "sha256",
    decisions: Object.freeze(decisions),
    schemaVersion: 1
  });
}

export function findHistoricalArchitectureDecisionBaselineViolation(input: {
  readonly existing: AcceptedArchitectureDecisionBaseline;
  readonly next: AcceptedArchitectureDecisionBaseline;
}): HistoricalArchitectureDecisionBaselineViolation | undefined {
  const nextById = new Map(input.next.decisions.map((entry) => [entry.id, entry]));
  // Missing historical documents take precedence: no subsequent rewrite may hide
  // their disappearance behind another current-document difference.
  for (const existing of input.existing.decisions) {
    const current = nextById.get(existing.id);
    if (current === undefined) {
      return { id: existing.id, kind: "missing", path: existing.path };
    }
  }
  for (const existing of input.existing.decisions) {
    const current = nextById.get(existing.id);
    if (current === undefined) {
      continue;
    }
    if (current.path !== existing.path) {
      return {
        actualPath: current.path,
        expectedPath: existing.path,
        id: existing.id,
        kind: "path-mismatch"
      };
    }
    if (current.immutableDigest !== existing.immutableDigest) {
      return {
        actualDigest: current.immutableDigest,
        expectedDigest: existing.immutableDigest,
        id: existing.id,
        kind: "digest-mismatch"
      };
    }
  }
  return undefined;
}
