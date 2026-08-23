import { foundationKnownFileTransaction } from "../adapters/foundation-known-file-transaction.js";
import {
  nodeConsumerIntegrationInputReader
} from "../adapters/node-consumer-integration-repository.js";
import {
  packageConsumerAssetCatalogReader
} from "../adapters/package-consumer-asset-catalog.js";
import type {
  ConsumerIntegrationExecutionV1
} from "../application/model/consumer-integration-execution.js";
import {
  createConsumerIntegrationUseCases
} from "../application/use-cases/run-consumer-integration.js";
import { consumerIntegrationPlanningPorts } from "./consumer-integration-planner.js";

export type {
  ConsumerIntegrationExecutionV1
} from "../application/model/consumer-integration-execution.js";

const useCases = createConsumerIntegrationUseCases({
  assets: packageConsumerAssetCatalogReader,
  input: nodeConsumerIntegrationInputReader,
  planning: consumerIntegrationPlanningPorts,
  transaction: foundationKnownFileTransaction
});

export function checkConsumerIntegration(options: {
  readonly consumerRoot: string;
  readonly integrationProfilePath?: string;
}): Promise<ConsumerIntegrationExecutionV1> {
  return useCases.check(options);
}

export function planNodeConsumerIntegration(options: {
  readonly consumerRoot: string;
  readonly integrationProfilePath?: string;
  readonly to: string;
}): Promise<ConsumerIntegrationExecutionV1> {
  return useCases.plan(options);
}

export function applyConsumerIntegration(options: {
  readonly consumerRoot: string;
  readonly expect: string;
  readonly integrationProfilePath?: string;
}): Promise<ConsumerIntegrationExecutionV1> {
  return useCases.apply(options);
}

export function recoverConsumerIntegration(options: {
  readonly consumerRoot: string;
}): Promise<ConsumerIntegrationExecutionV1> {
  return useCases.recover(options);
}
