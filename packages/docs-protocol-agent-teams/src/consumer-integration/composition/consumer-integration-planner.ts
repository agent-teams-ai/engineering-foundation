import { agentsRoutePlannerV1 } from "../adapters/agents-route-adapter-v1.js";
import { pnpmManifestPlanner } from "../adapters/pnpm-manifest-planner.js";
import {
  createConsumerIntegrationPlanner,
  type ConsumerIntegrationPlanningPorts,
  type ConsumerIntegrationDesiredState,
  type ConsumerIntegrationDesiredStateV1,
  type ConsumerIntegrationDesiredStateV3,
  type ConsumerIntegrationPlanV1,
  type ConsumerIntegrationSnapshot
} from "../application-api.js";

export const consumerIntegrationPlanningPorts: ConsumerIntegrationPlanningPorts =
  Object.freeze({
    agentsRoute: agentsRoutePlannerV1,
    packageManifest: pnpmManifestPlanner
  });

const planner = createConsumerIntegrationPlanner(consumerIntegrationPlanningPorts);
export const compileConsumerIntegration = planner.compileConsumerIntegration;
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
  return planner.planConsumerIntegration(input);
}
