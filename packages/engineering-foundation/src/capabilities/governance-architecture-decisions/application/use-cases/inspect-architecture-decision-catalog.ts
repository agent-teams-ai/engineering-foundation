import { assertNotCancelled } from "../../../../strict-yaml.js";
import type { MarkdownRepository } from "../../../../documentation-observation/application/ports/markdown-repository.js";
import type { ArchitectureDecisionPolicy } from "../model/architecture-decision.js";
import {
  evaluateArchitectureDecisionCatalog,
  type ArchitectureDecisionCatalogEvaluation
} from "../policies/evaluate-architecture-decisions.js";

export interface InspectArchitectureDecisionCatalogInput {
  readonly consumerRoot: string;
  readonly policy: ArchitectureDecisionPolicy;
  readonly signal?: AbortSignal;
}

export interface InspectArchitectureDecisionCatalogDependencies {
  readonly markdownRepository: MarkdownRepository;
}

/**
 * Builds the current ADR inventory without reading or evaluating the baseline.
 * Promotion uses this exact path so no write can bypass catalog validation.
 */
export async function inspectArchitectureDecisionCatalog(
  input: InspectArchitectureDecisionCatalogInput,
  dependencies: InspectArchitectureDecisionCatalogDependencies
): Promise<ArchitectureDecisionCatalogEvaluation> {
  assertNotCancelled(input.signal);
  const observation = await dependencies.markdownRepository.observe({
    consumerRoot: input.consumerRoot,
    roots: input.policy.adrRoots,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  return evaluateArchitectureDecisionCatalog({
    consumerRoot: input.consumerRoot,
    observation,
    policy: input.policy,
    repository: dependencies.markdownRepository,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
}
