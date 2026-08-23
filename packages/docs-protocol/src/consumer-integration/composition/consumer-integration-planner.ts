import { agentsRoutePlannerV1 } from "../adapters/agents-route-adapter-v1.js";
import { pnpmManifestPlannerV1 } from "../adapters/pnpm-manifest-adapter-v1.js";
import type {
  ConsumerAssetCatalogV1,
  KnownPriorCohortCatalogEntryV1
} from "../application/policies/consumer-integration-assets.js";
import type {
  ConsumerIntegrationPlanningPorts
} from "../application/ports/consumer-integration-planners.js";
import {
  compileConsumerIntegration as compileWithPorts
} from "../application/use-cases/plan-consumer-integration.js";
import type {
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationPlanV1,
  ConsumerIntegrationSnapshot
} from "../domain/model.js";

export const consumerIntegrationPlanningPorts: ConsumerIntegrationPlanningPorts =
  Object.freeze({
    agentsRoute: agentsRoutePlannerV1,
    packageManifest: pnpmManifestPlannerV1
  });

export function compileConsumerIntegration(input: {
  readonly desired: ConsumerIntegrationDesiredStateV1;
  readonly snapshot: ConsumerIntegrationSnapshot;
  readonly assetCatalog?: ConsumerAssetCatalogV1;
  /** Unit-level compatibility input; production composition loads package assets. */
  readonly knownPriorCohorts?: readonly KnownPriorCohortCatalogEntryV1[];
}) {
  return compileWithPorts(input, consumerIntegrationPlanningPorts);
}

export function planConsumerIntegration(input: {
  readonly desired: ConsumerIntegrationDesiredStateV1;
  readonly snapshot: ConsumerIntegrationSnapshot;
}): ConsumerIntegrationPlanV1 {
  return compileConsumerIntegration(input).plan;
}
