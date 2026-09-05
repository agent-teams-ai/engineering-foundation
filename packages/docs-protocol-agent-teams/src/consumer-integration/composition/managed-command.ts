import { createManagedConsumerCommand } from "../adapters/inbound/consumer-integration-cli.js";
import {
  applyConsumerIntegration,
  checkConsumerIntegration,
  planNodeConsumerIntegration,
  recoverConsumerIntegration,
  upgradeConsumerIntegrationToGeneration
} from "./node-consumer-integration.js";

export { createManagedDocsCli } from "../adapters/inbound/managed-cli.js";

export const managedConsumerCommand = createManagedConsumerCommand({
  apply: applyConsumerIntegration,
  check: checkConsumerIntegration,
  plan: planNodeConsumerIntegration,
  recover: recoverConsumerIntegration,
  upgrade: upgradeConsumerIntegrationToGeneration
});
