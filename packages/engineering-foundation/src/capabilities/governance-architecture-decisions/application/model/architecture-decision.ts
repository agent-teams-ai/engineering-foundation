import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import {
  markdownSourceWithoutFrontmatter,
  type MarkdownDocumentObservation
} from "../../../../documentation-observation/application/model/markdown-document.js";

export const ARCHITECTURE_DECISION_STATUSES = [
  "proposed",
  "accepted",
  "superseded"
] as const;

export type ArchitectureDecisionStatus =
  (typeof ARCHITECTURE_DECISION_STATUSES)[number];

export interface ArchitectureDecisionIndexPolicy {
  readonly path: string;
  readonly sections: Readonly<Record<ArchitectureDecisionStatus, string>>;
}

export interface ArchitectureDecisionPolicy {
  readonly acceptedBaselinePath: string;
  readonly adrRoots: readonly string[];
  readonly index: ArchitectureDecisionIndexPolicy;
}

export interface ArchitectureDecision {
  readonly document: MarkdownDocumentObservation;
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly status: ArchitectureDecisionStatus;
  readonly supersededBy: readonly string[];
  readonly supersedes: readonly string[];
}

export interface AcceptedArchitectureDecisionBaselineEntry {
  readonly id: string;
  readonly immutableDigest: string;
  readonly path: string;
}

export interface AcceptedArchitectureDecisionBaseline {
  readonly algorithm: "sha256";
  readonly decisions: readonly AcceptedArchitectureDecisionBaselineEntry[];
  readonly schemaVersion: 1;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => compareBinaryStrings(left, right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

export function immutableArchitectureDecisionPayload(
  decision: ArchitectureDecision
): string {
  const immutableMetadata = Object.fromEntries(
    Object.entries(decision.metadata).filter(
      ([key]) => key !== "status" && key !== "superseded_by"
    )
  );
  return JSON.stringify({
    body: markdownSourceWithoutFrontmatter(decision.document).replace(/\r\n/g, "\n"),
    metadata: canonicalize(immutableMetadata)
  });
}
