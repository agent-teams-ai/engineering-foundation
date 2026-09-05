import { assertNotCancelled } from "../../../../cancellation.js";
import type { MarkdownRepository } from "@agent-teams/document-authoring/observation";
import type { ArchitectureDecisionPolicy } from "../model/architecture-decision.js";
import {
  evaluateArchitectureDecisionCatalog,
  parseArchitectureDecisionCatalog,
  type ArchitectureDecisionCatalogEvaluation
} from "../policies/evaluate-architecture-decisions.js";
import { resolveArchitectureDecisionIndexMemberships } from "./resolve-architecture-decision-index-memberships.js";

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
  const catalog = parseArchitectureDecisionCatalog(observation, input.policy);
  const memberships = await resolveArchitectureDecisionIndexMemberships({
    consumerRoot: input.consumerRoot,
    decisions: catalog.decisions,
    index: catalog.index,
    repository: dependencies.markdownRepository,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  return evaluateArchitectureDecisionCatalog({
    catalog,
    memberships,
    policy: input.policy,
  });
}
