import type { FoundationDiagnostic } from "../../../../check-contract.js";
import { assertNotCancelled } from "../../../../strict-yaml.js";
import type { MarkdownRepository } from "../../../../documentation-observation/application/ports/markdown-repository.js";
import type { ArchitectureDecisionPolicy } from "../model/architecture-decision.js";
import type { ArchitectureDecisionFingerprint } from "../ports/architecture-decision-fingerprint.js";
import type { ArchitectureDecisionBaselineRepository } from "../ports/architecture-decision-baseline-repository.js";
import { evaluateArchitectureDecisions } from "../policies/evaluate-architecture-decisions.js";

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

export async function analyzeArchitectureDecisions(
  input: AnalyzeArchitectureDecisionsInput,
  dependencies: AnalyzeArchitectureDecisionsDependencies
): Promise<readonly FoundationDiagnostic[]> {
  assertNotCancelled(input.signal);
  const [baseline, observation] = await Promise.all([
    dependencies.baselineRepository.read({
      consumerRoot: input.consumerRoot,
      path: input.policy.acceptedBaselinePath,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    }),
    dependencies.markdownRepository.observe({
      consumerRoot: input.consumerRoot,
      roots: input.policy.adrRoots,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    })
  ]);
  return evaluateArchitectureDecisions({
    baseline,
    consumerRoot: input.consumerRoot,
    fingerprint: dependencies.fingerprint,
    observation,
    policy: input.policy,
    repository: dependencies.markdownRepository,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
}
