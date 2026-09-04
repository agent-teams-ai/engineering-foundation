import { agentsRoutePlannerV1 } from "../adapters/agents-route-adapter-v1.js";
import { planPnpmManifestV1 } from "../adapters/pnpm-manifest-adapter-v1.js";
import { planPnpmManifestV2 } from "../adapters/pnpm-manifest-adapter-v2.js";
import type {
  ConsumerAssetCatalogV1,
  KnownPriorCohortCatalogEntryV1
} from "../application/policies/consumer-integration-assets.js";
import type {
  ConsumerIntegrationPlanningPorts,
  PnpmManifestPlanner
} from "../application/ports/consumer-integration-planners.js";
import {
  compileConsumerIntegration as compileWithPorts
} from "../application/use-cases/plan-consumer-integration.js";
import type {
  ConsumerIntegrationDesiredState,
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationDesiredStateV3,
  ConsumerIntegrationPlanV1,
  ConsumerIntegrationSnapshot
} from "../domain/model.js";

const pnpmManifestPlanner: PnpmManifestPlanner = Object.freeze({
  plan(
    input: Parameters<PnpmManifestPlanner["plan"]>[0]
  ): ReturnType<PnpmManifestPlanner["plan"]> {
    const common = {
      observation: input.observation,
      profilePath: input.profilePath,
      ...(input.knownPriorScriptsDigest === undefined
        ? {}
        : { knownPriorScriptsDigest: input.knownPriorScriptsDigest })
    };
    switch (input.cohort.schemaVersion) {
      case 1:
        return planPnpmManifestV1({ ...common, cohort: input.cohort });
      case 2:
        return planPnpmManifestV2({ ...common, cohort: input.cohort });
      default:
        throw new TypeError("Unsupported Qualified Docs Cohort schema version.");
    }
  }
});

export const consumerIntegrationPlanningPorts: ConsumerIntegrationPlanningPorts =
  Object.freeze({
    agentsRoute: agentsRoutePlannerV1,
    packageManifest: pnpmManifestPlanner
  });

export function compileConsumerIntegration(input: {
  readonly desired: ConsumerIntegrationDesiredState;
  readonly snapshot: ConsumerIntegrationSnapshot;
  readonly assetCatalog?: ConsumerAssetCatalogV1;
  /** Unit-level compatibility input; production composition loads package assets. */
  readonly knownPriorCohorts?: readonly KnownPriorCohortCatalogEntryV1[];
}) {
  const desired = input.desired;
  if (desired.schemaVersion === 3) {
    if (input.assetCatalog !== undefined || input.knownPriorCohorts !== undefined) {
      throw new TypeError("Consumer integration profile v3 does not accept V1 asset catalogs.");
    }
    return compileWithPorts({
      desired,
      snapshot: input.snapshot
    }, consumerIntegrationPlanningPorts);
  }
  return compileWithPorts({
    desired,
    snapshot: input.snapshot,
    ...(input.assetCatalog === undefined ? {} : { assetCatalog: input.assetCatalog }),
    ...(input.knownPriorCohorts === undefined
      ? {}
      : { knownPriorCohorts: input.knownPriorCohorts })
  }, consumerIntegrationPlanningPorts);
}

export function planConsumerIntegration(input: {
  readonly desired: ConsumerIntegrationDesiredStateV1;
  readonly snapshot: ConsumerIntegrationSnapshot;
}): ConsumerIntegrationPlanV1;
export function planConsumerIntegration(input: {
  readonly desired: ConsumerIntegrationDesiredStateV3;
  readonly snapshot: ConsumerIntegrationSnapshot;
}): ConsumerIntegrationPlanV1;
export function planConsumerIntegration(input: {
  readonly desired: ConsumerIntegrationDesiredState;
  readonly snapshot: ConsumerIntegrationSnapshot;
}): ConsumerIntegrationPlanV1 {
  return compileConsumerIntegration(input).plan;
}
