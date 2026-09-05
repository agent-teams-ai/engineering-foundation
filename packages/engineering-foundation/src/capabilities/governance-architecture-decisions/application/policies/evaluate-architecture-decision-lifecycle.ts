import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import type { ArchitectureDecision } from "../model/architecture-decision.js";
import { ARCHITECTURE_DECISION_GOVERNANCE_RULES } from "../rules.js";
import { architectureDecisionDiagnostic } from "./architecture-decision-diagnostic.js";

function statusDiagnostic(
  decision: ArchitectureDecision
): FoundationDiagnostic | undefined {
  const hasSuccessor = decision.supersededBy.length > 0;
  const hasPredecessor = decision.supersedes.length > 0;
  const invalid =
    (decision.status === "proposed" && (hasSuccessor || hasPredecessor)) ||
    (decision.status === "accepted" && hasSuccessor) ||
    (decision.status === "superseded" && !hasSuccessor);
  return invalid
    ? architectureDecisionDiagnostic({
        message: `ADR ${decision.id} has lifecycle references incompatible with status ${decision.status}.`,
        path: decision.document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.lifecycleInvalid,
        subject: decision.id
      })
    : undefined;
}

function supersedesDiagnostics(input: {
  readonly decision: ArchitectureDecision;
  readonly targetId: string;
  readonly target: ArchitectureDecision | undefined;
}): readonly FoundationDiagnostic[] {
  const { decision, target, targetId } = input;
  if (target === undefined) {
    return [
      architectureDecisionDiagnostic({
        evidence: [{ kind: "target-adr", value: targetId }],
        message: `ADR ${decision.id} supersedes unknown ADR ${targetId}.`,
        path: decision.document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.supersedesMismatch,
        subject: decision.id
      })
    ];
  }
  const diagnostics: FoundationDiagnostic[] = [];
  if (targetId === decision.id || !target.supersededBy.includes(decision.id)) {
    diagnostics.push(
      architectureDecisionDiagnostic({
        evidence: [{ kind: "target-adr", value: targetId }],
        message: `ADR ${decision.id} supersedes ${targetId}, but the predecessor does not declare superseded_by ${decision.id}.`,
        path: decision.document.repositoryPath,
        relatedPath: target.document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.supersedesMismatch,
        subject: decision.id
      })
    );
  }
  if (
    !["accepted", "superseded"].includes(decision.status) ||
    target.status !== "superseded"
  ) {
    diagnostics.push(
      architectureDecisionDiagnostic({
        evidence: [{ kind: "target-adr", value: targetId }],
        message: `Supersession ${decision.id} -> ${targetId} requires an accepted successor and superseded predecessor.`,
        path: decision.document.repositoryPath,
        relatedPath: target.document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.lifecycleInvalid,
        subject: decision.id
      })
    );
  }
  return diagnostics;
}

function supersededByDiagnostics(input: {
  readonly decision: ArchitectureDecision;
  readonly targetId: string;
  readonly target: ArchitectureDecision | undefined;
}): readonly FoundationDiagnostic[] {
  const { decision, target, targetId } = input;
  if (target === undefined) {
    return [
      architectureDecisionDiagnostic({
        evidence: [{ kind: "target-adr", value: targetId }],
        message: `ADR ${decision.id} is superseded by unknown ADR ${targetId}.`,
        path: decision.document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.supersedesMismatch,
        subject: decision.id
      })
    ];
  }
  const diagnostics: FoundationDiagnostic[] = [];
  if (targetId === decision.id || !target.supersedes.includes(decision.id)) {
    diagnostics.push(
      architectureDecisionDiagnostic({
        evidence: [{ kind: "target-adr", value: targetId }],
        message: `ADR ${decision.id} declares superseded_by ${targetId}, but the successor does not declare supersedes ${decision.id}.`,
        path: decision.document.repositoryPath,
        relatedPath: target.document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.supersedesMismatch,
        subject: decision.id
      })
    );
  }
  if (
    decision.status !== "superseded" ||
    !["accepted", "superseded"].includes(target.status)
  ) {
    diagnostics.push(
      architectureDecisionDiagnostic({
        evidence: [{ kind: "target-adr", value: targetId }],
        message: `Superseded_by ${targetId} requires a superseded predecessor and accepted successor.`,
        path: decision.document.repositoryPath,
        relatedPath: target.document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.lifecycleInvalid,
        subject: decision.id
      })
    );
  }
  return diagnostics;
}

export function architectureDecisionLifecycleDiagnostics(
  decisions: readonly ArchitectureDecision[]
): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const decisionsById = new Map(decisions.map((decision) => [decision.id, decision]));
  for (const decision of decisions) {
    const invalidStatus = statusDiagnostic(decision);
    if (invalidStatus !== undefined) {
      diagnostics.push(invalidStatus);
    }
    for (const targetId of decision.supersedes) {
      diagnostics.push(
        ...supersedesDiagnostics({
          decision,
          target: decisionsById.get(targetId),
          targetId
        })
      );
    }
    for (const targetId of decision.supersededBy) {
      diagnostics.push(
        ...supersededByDiagnostics({
          decision,
          target: decisionsById.get(targetId),
          targetId
        })
      );
    }
  }
  return diagnostics;
}

export function architectureDecisionCycleDiagnostics(
  decisions: readonly ArchitectureDecision[]
): readonly FoundationDiagnostic[] {
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const diagnostics: FoundationDiagnostic[] = [];

  function visitDecision(id: string): void {
    if (active.has(id)) {
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      const decision = byId.get(id);
      if (decision !== undefined) {
        diagnostics.push(
          architectureDecisionDiagnostic({
            evidence: [{ kind: "cycle", value: cycle.join(" -> ") }],
            message: `ADR supersession cycle detected: ${cycle.join(" -> ")}.`,
            path: decision.document.repositoryPath,
            rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.supersedesCycle,
            subject: id
          })
        );
      }
      return;
    }
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    active.add(id);
    stack.push(id);
    const decision = byId.get(id);
    for (const predecessor of decision?.supersedes ?? []) {
      if (byId.has(predecessor)) {
        visitDecision(predecessor);
      }
    }
    stack.pop();
    active.delete(id);
  }

  for (const id of [...byId.keys()].toSorted()) {
    visitDecision(id);
  }
  return diagnostics;
}
