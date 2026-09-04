import type {
  KnownFileTransactionOperationInput
} from "@agent-teams/repository-mutation";

import type {
  ConsumerIntegrationDesiredState,
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationDesiredStateV3,
  ConsumerIntegrationDigest,
  ConsumerIntegrationSnapshot,
  ConsumerUpgradeAuthorityV1,
  ConsumerUpgradeAuthorityV2
} from "../../domain/model.js";

export type ConsumerUpgradeAuthority =
  | ConsumerUpgradeAuthorityV1
  | ConsumerUpgradeAuthorityV2;

export interface ConsumerUpgradeAuthorityReader {
  read(options: {
    readonly cohortId: string;
    readonly repository: ConsumerIntegrationDesiredState["repository"];
    readonly revision?: string;
  }): Promise<ConsumerUpgradeAuthority>;
}

export interface PreparedConsumerUpgradeV1 {
  readonly operations: readonly KnownFileTransactionOperationInput[];
}

export interface ConsumerUpgradeManagedPreimageV2 {
  readonly digest: ConsumerIntegrationDigest;
  readonly mode: number;
  readonly path: string;
}

export interface ConsumerUpgradeManagedPreimagesV2 {
  readonly callerWorkflow: ConsumerUpgradeManagedPreimageV2;
  readonly managedState: ConsumerUpgradeManagedPreimageV2;
  readonly skill: ConsumerUpgradeManagedPreimageV2;
}

export interface ConsumerUpgradeSandboxPort {
  prepareV1(options: {
    readonly authority: ConsumerUpgradeAuthorityV1;
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV1;
    readonly expectedSourceRevision: string;
    readonly expectedSourceSnapshot: ConsumerIntegrationSnapshot;
  }): Promise<PreparedConsumerUpgradeV1>;
  prepareV2(options: {
    readonly authority: ConsumerUpgradeAuthorityV2;
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV3;
    readonly expectedSourceRevision: string;
    readonly expectedSourceSnapshot: ConsumerIntegrationSnapshot;
    readonly managedPreimages: ConsumerUpgradeManagedPreimagesV2;
  }): Promise<PreparedConsumerUpgradeV1>;
  activateAndVerifyV1(options: {
    readonly authority: ConsumerUpgradeAuthorityV1;
    readonly consumerRoot: string;
  }): Promise<void>;
  activateAndVerifyV2(options: {
    readonly authority: ConsumerUpgradeAuthorityV2;
    readonly consumerRoot: string;
  }): Promise<void>;
  restoreAndVerifyV1(options: {
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV1;
  }): Promise<void>;
  restoreAndVerifyV2(options: {
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV3;
  }): Promise<void>;
}
