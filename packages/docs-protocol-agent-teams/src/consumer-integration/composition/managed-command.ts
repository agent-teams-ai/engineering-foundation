import { createManagedConsumerCommand } from "../adapters/inbound/consumer-integration-cli.js";
import {
  applyConsumerIntegration,
  restoreConsumerIntegration,
  finalizeConsumerRestoration,
  checkConsumerIntegration,
  planNodeConsumerIntegration,
  recoverConsumerIntegration,
  upgradeConsumerIntegrationToGeneration
} from "./node-consumer-integration.js";

export { createManagedDocsCli } from "../adapters/inbound/managed-cli.js";

export const managedConsumerCommand = createManagedConsumerCommand({
  apply: applyConsumerIntegration,
  restore: restoreConsumerIntegration,
  finalize: finalizeConsumerRestoration,
  check: checkConsumerIntegration,
  plan: planNodeConsumerIntegration,
  recover: recoverConsumerIntegration,
  upgrade: upgradeConsumerIntegrationToGeneration
});
