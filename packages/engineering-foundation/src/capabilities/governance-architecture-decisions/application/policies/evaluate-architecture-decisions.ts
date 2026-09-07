import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import type {
  MarkdownDocumentObservation,
  MarkdownRepositoryObservation
} from "@agent-teams/document-authoring/observation";
import {
  immutableArchitectureDecisionPayload,
  type ArchitectureDecision,
  type ArchitectureDecisionPolicy
} from "../model/architecture-decision.js";
import type { ArchitectureDecisionBaselineReadResult } from "../ports/architecture-decision-baseline-repository.js";
import type { ArchitectureDecisionFingerprint } from "../ports/architecture-decision-fingerprint.js";
import { ARCHITECTURE_DECISION_GOVERNANCE_RULES } from "../rules.js";
import { parseAcceptedArchitectureDecisionBaseline } from "./accepted-architecture-decision-baseline.js";
import {
  architectureDecisionDiagnostic,
  architectureDecisionIssueDiagnostic
} from "./architecture-decision-diagnostic.js";
import {
  evaluateArchitectureDecisionIndex,
  type ArchitectureDecisionIndexMembership
} from "./evaluate-architecture-decision-index.js";
import {
  architectureDecisionCycleDiagnostics,
  architectureDecisionLifecycleDiagnostics
} from "./evaluate-architecture-decision-lifecycle.js";
import { parseArchitectureDecisionDocument } from "./parse-architecture-decision-document.js";

interface ParsedArchitectureDecisionCatalog {
  readonly decisions: readonly ArchitectureDecision[];
  readonly diagnostics: readonly FoundationDiagnostic[];
  readonly index: MarkdownDocumentObservation | undefined;
}

interface CatalogEvaluationInput {
  readonly catalog: ParsedArchitectureDecisionCatalog;
  readonly memberships: readonly ArchitectureDecisionIndexMembership[];
  readonly policy: ArchitectureDecisionPolicy;
}

export interface ArchitectureDecisionCatalogEvaluation {
  readonly decisions: readonly ArchitectureDecision[];
  readonly diagnostics: readonly FoundationDiagnostic[];
}

function uniqueArchitectureDecisions(input: {
  readonly candidates: readonly ArchitectureDecision[];
  readonly diagnostics: FoundationDiagnostic[];
}): readonly ArchitectureDecision[] {
  const decisionsById = new Map<string, ArchitectureDecision[]>();
  for (const decision of input.candidates) {
    const group = decisionsById.get(decision.id) ?? [];
    group.push(decision);
    decisionsById.set(decision.id, group);
  }

  const decisions: ArchitectureDecision[] = [];
  for (const [id, group] of [...decisionsById.entries()].toSorted(([left], [right]) =>
    compareBinaryStrings(left, right)
  )) {
    if (group.length === 1) {
      const decision = group[0];
      if (decision !== undefined) {
        decisions.push(decision);
      }
      continue;
    }
    for (const decision of group) {
      input.diagnostics.push(
        architectureDecisionDiagnostic({
          evidence: [{ kind: "duplicate-id", value: id }],
          message: `ADR identifier ${id} is duplicated.`,
          path: decision.document.repositoryPath,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.duplicateId,
          subject: id
        })
      );
    }
  }
  return decisions;
}

function baselineAvailabilityDiagnostic(input: {
  readonly baseline: Exclude<
    ArchitectureDecisionBaselineReadResult,
    { readonly kind: "valid" }
  >;
  readonly path: string;
}): FoundationDiagnostic {
  if (input.baseline.kind === "missing") {
    return architectureDecisionDiagnostic({
      message: "Configured accepted-decision baseline is missing.",
      path: input.path,
      rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.acceptedBaselineUnavailable,
      subject: input.path
    });
  }
  return architectureDecisionDiagnostic({
    evidence: [{ kind: "baseline-error", value: input.baseline.message }],
    message: "Configured accepted-decision baseline is unavailable or invalid.",
    path: input.path,
    rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.acceptedBaselineInvalid,
    subject: input.path
  });
}

function currentDecisionBaselineDiagnostics(input: {
  readonly baselineById: ReadonlyMap<
    string,
    NonNullable<ReturnType<typeof parseAcceptedArchitectureDecisionBaseline>>["decisions"][number]
  >;
  readonly decisions: readonly ArchitectureDecision[];
  readonly fingerprint: ArchitectureDecisionFingerprint;
}): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  for (const decision of input.decisions) {
    if (decision.status === "proposed") {
      continue;
    }
    const entry = input.baselineById.get(decision.id);
    if (entry === undefined) {
      diagnostics.push(
        architectureDecisionDiagnostic({
          message: `Accepted ADR ${decision.id} is absent from the immutable baseline.`,
          path: decision.document.repositoryPath,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.acceptedBaselineMissing,
          subject: decision.id
        })
      );
      continue;
    }
    if (entry.path !== decision.document.repositoryPath) {
      diagnostics.push(
        architectureDecisionDiagnostic({
          evidence: [{ kind: "baseline-path", value: entry.path }],
          message: `Accepted ADR ${decision.id} moved from ${entry.path}.`,
          path: decision.document.repositoryPath,
          relatedPath: entry.path,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.baselinePathMismatch,
          subject: decision.id
        })
      );
    }
    const actualDigest = input.fingerprint.digest(
      immutableArchitectureDecisionPayload(decision)
    );
    if (entry.immutableDigest !== actualDigest) {
      diagnostics.push(
        architectureDecisionDiagnostic({
          evidence: [
            { kind: "baseline-digest", value: entry.immutableDigest },
            { kind: "actual-digest", value: actualDigest }
          ],
          message: `Accepted ADR ${decision.id} differs from its immutable baseline.`,
          path: decision.document.repositoryPath,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.acceptedDecisionMutated,
          subject: decision.id
        })
      );
    }
  }
  return diagnostics;
}

export function evaluateArchitectureDecisionBaselineDiagnostics(input: {
  readonly baseline: ArchitectureDecisionBaselineReadResult;
  readonly decisions: readonly ArchitectureDecision[];
  readonly fingerprint: ArchitectureDecisionFingerprint;
  readonly path: string;
}): readonly FoundationDiagnostic[] {
  if (input.baseline.kind !== "valid") {
    return [baselineAvailabilityDiagnostic({ baseline: input.baseline, path: input.path })];
  }
  const baseline = parseAcceptedArchitectureDecisionBaseline(input.baseline.value);
  if (baseline === undefined) {
    return [
      architectureDecisionDiagnostic({
        message: "Accepted-decision baseline does not match the required immutable baseline shape.",
        path: input.path,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.acceptedBaselineInvalid,
        subject: input.path
      })
    ];
  }

  const currentById = new Map(input.decisions.map((decision) => [decision.id, decision]));
  const diagnostics = [
    ...currentDecisionBaselineDiagnostics({
      baselineById: new Map(baseline.decisions.map((entry) => [entry.id, entry])),
      decisions: input.decisions,
      fingerprint: input.fingerprint
    })
  ];
  for (const entry of baseline.decisions) {
    const current = currentById.get(entry.id);
    if (current === undefined || current.status === "proposed") {
      diagnostics.push(
        architectureDecisionDiagnostic({
          evidence: [{ kind: "baseline-id", value: entry.id }],
          message: `Accepted-decision baseline entry ${entry.id} has no accepted or superseded ADR document.`,
          path: input.path,
          relatedPath: entry.path,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.acceptedDecisionMissing,
          subject: entry.id
        })
      );
    }
  }
  return diagnostics;
}

export function parseArchitectureDecisionCatalog(
  observation: MarkdownRepositoryObservation,
  policy: ArchitectureDecisionPolicy
): ParsedArchitectureDecisionCatalog {
  const diagnostics: FoundationDiagnostic[] = observation.issues.map(
    architectureDecisionIssueDiagnostic
  );
  const documents = observation.documents.filter(
    (document) => document.repositoryPath !== policy.index.path
  );
  const parsed = documents.map(parseArchitectureDecisionDocument);
  diagnostics.push(...parsed.flatMap((entry) => entry.diagnostics));
  const candidates = parsed.flatMap((entry) =>
    entry.decision === undefined ? [] : [entry.decision]
  );
  const decisions = uniqueArchitectureDecisions({ candidates, diagnostics });
  const index = observation.documents.find(
    (document) => document.repositoryPath === policy.index.path
  );
  return Object.freeze({
    decisions: Object.freeze(decisions),
    diagnostics: Object.freeze(diagnostics),
    index
  });
}

export function evaluateArchitectureDecisionCatalog(
  input: CatalogEvaluationInput
): ArchitectureDecisionCatalogEvaluation {
  const diagnostics = [...input.catalog.diagnostics];
  diagnostics.push(
    ...evaluateArchitectureDecisionIndex({
      decisions: input.catalog.decisions,
      index: input.catalog.index,
      memberships: input.memberships,
      policy: input.policy,
    })
  );
  diagnostics.push(
    ...architectureDecisionLifecycleDiagnostics(input.catalog.decisions)
  );
  diagnostics.push(...architectureDecisionCycleDiagnostics(input.catalog.decisions));
  return Object.freeze({
    decisions: input.catalog.decisions,
    diagnostics: Object.freeze(diagnostics)
  });
}
