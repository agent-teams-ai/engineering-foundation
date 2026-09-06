import { CapabilityInputError } from "../../../../features/validation-reporting/api.js";
import type { AcceptedArchitectureDecisionEvidence } from "../model/accepted-decision-evidence.js";
import { parseAcceptedArchitectureDecisionBaseline } from "../policies/accepted-architecture-decision-baseline.js";
import { analyzeArchitectureDecisionEvidence, type AnalyzeArchitectureDecisionsInput, type AnalyzeArchitectureDecisionsDependencies } from "./analyze-architecture-decisions.js";

export async function resolveAcceptedArchitectureDecisionEvidence(
  input: AnalyzeArchitectureDecisionsInput & { readonly baselinePath: string },
  dependencies: AnalyzeArchitectureDecisionsDependencies
): Promise<AcceptedArchitectureDecisionEvidence> {
  const policy = input.policy;
  if (policy.acceptedBaselinePath !== input.baselinePath) {
    throw new CapabilityInputError({
      code: "ARCHITECTURE_DECISION_EVIDENCE_BASELINE_MISMATCH",
      message:
        "Accepted ADR evidence must use the baseline configured by architecture decision governance.",
      phase: "architecture-decision-evidence",
      retryable: false
    });
  }
  const analysis = await analyzeArchitectureDecisionEvidence(
    {
      consumerRoot: input.consumerRoot,
      policy,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    },
    dependencies
  );
  if (analysis.diagnostics.length > 0) {
    const subjects = analysis.diagnostics
      .map((diagnostic) => diagnostic.subject)
      .toSorted()
      .slice(0, 3)
      .join(", ");
    throw new CapabilityInputError({
      code: "ARCHITECTURE_DECISION_EVIDENCE_INVALID",
      message: `Accepted ADR evidence requires a valid immutable governance catalog${subjects.length === 0 ? "." : `: ${subjects}.`}`,
      phase: "architecture-decision-evidence",
      retryable: false
    });
  }
  const baseline = analysis.baseline;
  const parsed =
    baseline.kind === "valid"
      ? parseAcceptedArchitectureDecisionBaseline(baseline.value)
      : undefined;
  if (parsed === undefined) {
    throw new CapabilityInputError({
      code: "ARCHITECTURE_DECISION_EVIDENCE_INVALID",
      message: "Accepted ADR evidence baseline was invalid while resolving governance evidence.",
      phase: "architecture-decision-evidence",
      retryable: false
    });
  }
  const baselineById = new Map(parsed.decisions.map((entry) => [entry.id, entry]));
  const acceptedDecisions = analysis.decisions
    .filter((decision) => decision.status === "accepted")
    .map((decision) => {
      const baselineEntry = baselineById.get(decision.id);
      if (
        baselineEntry === undefined ||
        baselineEntry.path !== decision.document.repositoryPath
      ) {
        throw new CapabilityInputError({
          code: "ARCHITECTURE_DECISION_EVIDENCE_INVALID",
          message: `Accepted ADR ${decision.id} is not represented by the validated immutable governance baseline.`,
          phase: "architecture-decision-evidence",
          retryable: false
        });
      }
      return Object.freeze({ id: decision.id as `ADR-${string}`, path: baselineEntry.path });
    });
  return Object.freeze({
    acceptedDecisionIds: Object.freeze(acceptedDecisions.map((decision) => decision.id)),
    acceptedDecisionPaths: Object.freeze(acceptedDecisions.map((decision) => decision.path))
  });
}
