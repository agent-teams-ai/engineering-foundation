import { finalizeNodeConsumerRestoration } from "../adapters/node-consumer-restoration-finalization.js";
import { consumerRestorationRecorder, restoreNodeConsumerIntegration } from "../adapters/node-consumer-restoration.js";
import type { ConsumerFinalizationOptions, ConsumerRestorationOptions, RestorableConsumerUpgradeExecution } from "../application/model/consumer-restoration.js";
import { foundationKnownFileTransaction } from "../adapters/foundation-known-file-transaction.js";
import { githubCohortAuthorityReader } from "../adapters/github-cohort-authority-reader.js";
import {
  nodeConsumerIntegrationInputReader
} from "../adapters/node-consumer-integration-repository.js";
import {
  packageConsumerAssetCatalogReader
} from "../adapters/package-consumer-asset-catalog.js";
import { nodeConsumerUpgradeSandbox } from "../adapters/node-consumer-upgrade-sandbox.js";
import type {
  ConsumerIntegrationExecutionV1
} from "../application/model/consumer-integration-execution.js";
import {
  createConsumerIntegrationUseCases
} from "../application/use-cases/run-consumer-integration.js";
import {
  createConsumerUpgradeUseCase
} from "../application/use-cases/upgrade-consumer-integration.js";
import type {
  ConsumerUpgradeExecutionV1
} from "../application/model/consumer-upgrade-execution.js";
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

const upgrade = createConsumerUpgradeUseCase({
  assets: packageConsumerAssetCatalogReader,
  authority: githubCohortAuthorityReader,
  restoration: consumerRestorationRecorder(githubCohortAuthorityReader),
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

export async function upgradeConsumerIntegration(options: {
  readonly consumerRoot: string;
  readonly authorityRevision?: string;
  readonly to: string;
}): Promise<ConsumerUpgradeExecutionV1> {
  const result = await upgrade(options);
  if (result.outcome === "prepared" || result.command !== "consumer.upgrade") {throw new TypeError("Explicit preparation is CLI-only.");}
  return { ...result, command: "consumer.upgrade", outcome: result.outcome };
}

export function upgradeConsumerIntegrationToGeneration(options: {
  readonly consumerRoot: string;
  readonly authorityRevision?: string;
  readonly targetGeneration: 1 | 2;
  readonly sourceGeneration?: 1;
  readonly restorationProofPath?: string;
  readonly prepare?: boolean;
  readonly to: string;
}): Promise<RestorableConsumerUpgradeExecution> {
  return upgrade(options);
}

export function restoreConsumerIntegration(options: ConsumerRestorationOptions) {
  return restoreNodeConsumerIntegration(options, { authority: githubCohortAuthorityReader, sandbox: nodeConsumerUpgradeSandbox });
}

export function finalizeConsumerRestoration(options: ConsumerFinalizationOptions) {
  return finalizeNodeConsumerRestoration(options, { authority: githubCohortAuthorityReader, sandbox: nodeConsumerUpgradeSandbox });
}
