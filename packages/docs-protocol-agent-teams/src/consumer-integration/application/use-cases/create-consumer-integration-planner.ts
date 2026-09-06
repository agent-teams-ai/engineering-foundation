import type {
  ConsumerAssetCatalogV1,
  KnownPriorCohortCatalogEntryV1
} from "../policies/consumer-integration-assets.js";
import type { ConsumerIntegrationPlanningPorts } from "../ports/consumer-integration-planners.js";
import type {
  ConsumerIntegrationDesiredState,
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationDesiredStateV3,
  ConsumerIntegrationPlanV1,
  ConsumerIntegrationSnapshot
} from "../../domain/model.js";
import { compileConsumerIntegration as compileWithPorts } from "./plan-consumer-integration.js";

export function createConsumerIntegrationPlanner(ports: ConsumerIntegrationPlanningPorts) {
  function compileConsumerIntegration(input: {
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
      }, ports);
    }
    return compileWithPorts({
      desired,
      snapshot: input.snapshot,
      ...(input.assetCatalog === undefined ? {} : { assetCatalog: input.assetCatalog }),
      ...(input.knownPriorCohorts === undefined
        ? {}
        : { knownPriorCohorts: input.knownPriorCohorts })
    }, ports);
  }

  function planConsumerIntegration(input: {
    readonly desired: ConsumerIntegrationDesiredStateV1;
    readonly snapshot: ConsumerIntegrationSnapshot;
  }): ConsumerIntegrationPlanV1;
  function planConsumerIntegration(input: {
    readonly desired: ConsumerIntegrationDesiredStateV3;
    readonly snapshot: ConsumerIntegrationSnapshot;
  }): ConsumerIntegrationPlanV1;
  function planConsumerIntegration(input: {
    readonly desired: ConsumerIntegrationDesiredState;
    readonly snapshot: ConsumerIntegrationSnapshot;
  }): ConsumerIntegrationPlanV1;
  function planConsumerIntegration(input: {
    readonly desired: ConsumerIntegrationDesiredState;
    readonly snapshot: ConsumerIntegrationSnapshot;
  }): ConsumerIntegrationPlanV1 {
    return compileConsumerIntegration(input).plan;
  }

  return Object.freeze({ compileConsumerIntegration, planConsumerIntegration });
}
