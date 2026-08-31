import type {
  KnownFileTransactionBarrierInspection,
  KnownFileTransactionPlanV1,
  KnownFileTransactionReceiptV1
} from "@agent-teams/repository-mutation";

import type { ConsumerAssetCatalogV1 } from "../policies/consumer-integration-assets.js";
import type {
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationSnapshot
} from "../../domain/model.js";

interface ConsumerIntegrationInput {
  readonly desired: ConsumerIntegrationDesiredStateV1;
  readonly root: string;
  readonly snapshot: ConsumerIntegrationSnapshot;
}

export interface ConsumerIntegrationInputReader {
  read(options: {
    readonly consumerRoot: string;
    readonly integrationProfilePath?: string;
  }): Promise<ConsumerIntegrationInput>;
}

export interface ConsumerAssetCatalogReader {
  read(): Promise<ConsumerAssetCatalogV1>;
}

export interface ConsumerIntegrationTransactionPort {
  inspect(options: {
    readonly consumerRoot: string;
  }): Promise<KnownFileTransactionBarrierInspection>;
  apply(options: {
    readonly consumerRoot: string;
    readonly plan: KnownFileTransactionPlanV1;
  }): Promise<KnownFileTransactionReceiptV1>;
  recover(options: {
    readonly consumerRoot: string;
  }): Promise<KnownFileTransactionReceiptV1>;
}
