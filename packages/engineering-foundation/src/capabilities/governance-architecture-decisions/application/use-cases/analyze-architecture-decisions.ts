import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import { assertNotCancelled } from "../../../../cancellation.js";
import type { MarkdownRepository } from "@agent-teams/document-authoring/observation";
import type {
  ArchitectureDecision,
  ArchitectureDecisionPolicy
} from "../model/architecture-decision.js";
import type {
  ArchitectureDecisionBaselineReadResult,
  ArchitectureDecisionBaselineRepository
} from "../ports/architecture-decision-baseline-repository.js";
import type { ArchitectureDecisionFingerprint } from "../ports/architecture-decision-fingerprint.js";
import { evaluateArchitectureDecisionBaselineDiagnostics } from "../policies/evaluate-architecture-decisions.js";
import { inspectArchitectureDecisionCatalog } from "./inspect-architecture-decision-catalog.js";

export interface AnalyzeArchitectureDecisionsInput {
  readonly consumerRoot: string;
  readonly policy: ArchitectureDecisionPolicy;
  readonly signal?: AbortSignal;
}

export interface AnalyzeArchitectureDecisionsDependencies {
  readonly baselineRepository: ArchitectureDecisionBaselineRepository;
  readonly fingerprint: ArchitectureDecisionFingerprint;
  readonly markdownRepository: MarkdownRepository;
}

/**
 * The exact baseline observation that was evaluated with the current ADR
 * catalog. Consumers that need accepted-decision evidence must use this
 * snapshot rather than reading the mutable file again.
 */
export interface ArchitectureDecisionEvidenceAnalysis {
  readonly baseline: ArchitectureDecisionBaselineReadResult;
  readonly decisions: readonly ArchitectureDecision[];
  readonly diagnostics: readonly FoundationDiagnostic[];
}

export async function analyzeArchitectureDecisionEvidence(
  input: AnalyzeArchitectureDecisionsInput,
  dependencies: AnalyzeArchitectureDecisionsDependencies
): Promise<ArchitectureDecisionEvidenceAnalysis> {
  assertNotCancelled(input.signal);
  const [baseline, catalog] = await Promise.all([
    dependencies.baselineRepository.read({
      consumerRoot: input.consumerRoot,
      path: input.policy.acceptedBaselinePath,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    }),
    inspectArchitectureDecisionCatalog(
      {
        consumerRoot: input.consumerRoot,
        policy: input.policy,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      },
      dependencies
    )
  ]);
  return Object.freeze({
    baseline,
    decisions: catalog.decisions,
    diagnostics: Object.freeze([
      ...catalog.diagnostics,
      ...evaluateArchitectureDecisionBaselineDiagnostics({
        baseline,
        decisions: catalog.decisions,
        fingerprint: dependencies.fingerprint,
        path: input.policy.acceptedBaselinePath
      })
    ])
  });
}

export async function analyzeArchitectureDecisions(
  input: AnalyzeArchitectureDecisionsInput,
  dependencies: AnalyzeArchitectureDecisionsDependencies
): Promise<readonly FoundationDiagnostic[]> {
  return (await analyzeArchitectureDecisionEvidence(input, dependencies)).diagnostics;
}
