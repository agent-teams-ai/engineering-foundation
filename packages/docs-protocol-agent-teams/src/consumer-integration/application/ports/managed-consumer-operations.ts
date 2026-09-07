import type { createConsumerIntegrationUseCases } from "../use-cases/run-consumer-integration.js";
import type { createConsumerUpgradeUseCase } from "../use-cases/upgrade-consumer-integration.js";
import type {
  ConsumerFinalizationOptions, ConsumerRestorationExecution, ConsumerRestorationOptions,
  RestorableConsumerUpgradeExecution
} from "../model/consumer-restoration.js";

export type ManagedConsumerOperations = ReturnType<typeof createConsumerIntegrationUseCases> & {
  readonly upgrade: (options: Parameters<ReturnType<typeof createConsumerUpgradeUseCase>>[0] & {
    readonly targetGeneration: 1 | 2;
  }) => Promise<RestorableConsumerUpgradeExecution>;
  readonly restore: (options: ConsumerRestorationOptions) => Promise<ConsumerRestorationExecution>;
  readonly finalize: (options: ConsumerFinalizationOptions) => Promise<RestorableConsumerUpgradeExecution>;
};
