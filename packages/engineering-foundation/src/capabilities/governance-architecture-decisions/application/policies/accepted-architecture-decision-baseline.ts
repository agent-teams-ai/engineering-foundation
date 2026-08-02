import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import {
  immutableArchitectureDecisionPayload,
  type AcceptedArchitectureDecisionBaseline,
  type AcceptedArchitectureDecisionBaselineEntry,
  type ArchitectureDecision
} from "../model/architecture-decision.js";
import type { ArchitectureDecisionFingerprint } from "../ports/architecture-decision-fingerprint.js";
import { parseAcceptedArchitectureDecisionBaselineValue } from "./parse-accepted-architecture-decision-baseline.js";

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

function entryComparison(
  left: AcceptedArchitectureDecisionBaselineEntry,
  right: AcceptedArchitectureDecisionBaselineEntry
): number {
  return (
    compareBinaryStrings(left.id, right.id) ||
    compareBinaryStrings(left.path, right.path)
  );
}

/**
 * Parses the persisted baseline strictly enough for immutable-history checks.
 * The JSON Schema remains the external contract; this parser keeps policy code
 * synchronous and defensive when a consumer has malformed historical input.
 */
export function parseAcceptedArchitectureDecisionBaseline(
  value: unknown
): AcceptedArchitectureDecisionBaseline | undefined {
  return parseAcceptedArchitectureDecisionBaselineValue(value);
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
