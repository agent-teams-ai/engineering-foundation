import { foundationKnownFileTransaction } from "./known-file-transaction.js";
import { githubCohortAuthorityReader } from "../adapters/github-cohort-authority-reader.js";
import {
  nodeConsumerIntegrationInputReader
} from "../adapters/node-consumer-integration-repository.js";
import {
  packageConsumerAssetCatalogReader
} from "../adapters/package-consumer-asset-catalog.js";
import { nodeConsumerUpgradeSandbox } from "../adapters/node-consumer-upgrade-sandbox.js";
import {
  createConsumerIntegrationUseCases,
  createConsumerUpgradeUseCase,
  type ConsumerIntegrationExecutionV1,
  type ConsumerUpgradeExecutionV1
} from "../application-api.js";
import { consumerIntegrationPlanningPorts } from "./consumer-integration-planner.js";

export type {
  ConsumerIntegrationExecutionV1
} from "../application-api.js";

const useCases = createConsumerIntegrationUseCases({
  assets: packageConsumerAssetCatalogReader,
  input: nodeConsumerIntegrationInputReader,
  planning: consumerIntegrationPlanningPorts,
  transaction: foundationKnownFileTransaction
});

const upgrade = createConsumerUpgradeUseCase({
  assets: packageConsumerAssetCatalogReader,
  authority: githubCohortAuthorityReader,
  input: nodeConsumerIntegrationInputReader,
  planning: consumerIntegrationPlanningPorts,
  sandbox: nodeConsumerUpgradeSandbox,
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

export function upgradeConsumerIntegration(options: {
  readonly consumerRoot: string;
  readonly authorityRevision?: string;
  readonly to: string;
}): Promise<ConsumerUpgradeExecutionV1> {
  return upgrade(options);
}

export function upgradeConsumerIntegrationToGeneration(options: {
  readonly consumerRoot: string;
  readonly authorityRevision?: string;
  readonly targetGeneration: 1 | 2;
  readonly to: string;
}): Promise<ConsumerUpgradeExecutionV1> {
  return upgrade(options);
}
