import type {
  KnownFileTransactionOperationInput
} from "@agent-teams/repository-mutation";

import type {
  ConsumerIntegrationDesiredStateV1,
  ConsumerUpgradeAuthorityV1
} from "../../domain/model.js";

export interface ConsumerUpgradeAuthorityReader {
  read(options: {
    readonly cohortId: string;
    readonly repository: ConsumerIntegrationDesiredStateV1["repository"];
    readonly revision?: string;
  }): Promise<ConsumerUpgradeAuthorityV1>;
}

export interface PreparedConsumerUpgradeV1 {
  readonly operations: readonly KnownFileTransactionOperationInput[];
}

export interface ConsumerUpgradeSandboxPort {
  prepare(options: {
    readonly authority: ConsumerUpgradeAuthorityV1;
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV1;
  }): Promise<PreparedConsumerUpgradeV1>;
  activateAndVerify(options: {
    readonly authority: ConsumerUpgradeAuthorityV1;
    readonly consumerRoot: string;
  }): Promise<void>;
  restoreAndVerify(options: {
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV1;
  }): Promise<void>;
}
