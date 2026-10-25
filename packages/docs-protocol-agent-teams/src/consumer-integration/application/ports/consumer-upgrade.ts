import type { KnownFileTransactionOperationInput } from "@agent-teams/repository-mutation/known-file";

import type {
  ConsumerIntegrationDesiredState,
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationDesiredStateV3,
  ConsumerIntegrationDigest,
  ConsumerIntegrationSnapshot,
  ConsumerUpgradeAuthorityV1,
  ConsumerUpgradeAuthorityV2,
  ConsumerUpgradeAuthorityV3,
  ManagedSuccessorProfile,
} from "../../domain/model.js";

export type ConsumerUpgradeAuthority =
  | ConsumerUpgradeAuthorityV1
  | ConsumerUpgradeAuthorityV2
  | ConsumerUpgradeAuthorityV3;

export interface ConsumerUpgradeAuthorityReader {
  read(options: {
    readonly cohortId: string;
    readonly generation: 1 | 2 | 3;
    readonly rollbackFrom?: string;
    readonly repository: ConsumerIntegrationDesiredState["repository"];
    readonly revision?: string;
  }): Promise<ConsumerUpgradeAuthority>;
}

export interface ConsumerTargetLockfileInput {
  readonly path: string;
  readonly sha256: string;
}

export interface ConsumerTargetLockfileReader {
  read(input: ConsumerTargetLockfileInput, consumerRoot: string): Promise<Uint8Array>;
}

export interface PreparedConsumerUpgradeV1 {
  readonly operations: readonly KnownFileTransactionOperationInput[];
}

interface ConsumerUpgradeManagedPreimageV2 {
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
  verifyManagedRuntime(options: {
    readonly cohort: ConsumerUpgradeAuthorityV2["cohort"] | ConsumerUpgradeAuthorityV3["cohort"];
    readonly packageManager: string;
  }): Promise<void>;
  restoreCommittedAndVerifyManaged(options: {
    readonly current: ConsumerIntegrationDesiredStateV3;
    readonly consumerRoot: string;
  }): Promise<void>;
  prepareManaged(options: {
    readonly authority: ConsumerUpgradeAuthorityV2 | ConsumerUpgradeAuthorityV3;
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV3 | ManagedSuccessorProfile;
    readonly expectedSourceRevision: string;
    readonly expectedSourceSnapshot: ConsumerIntegrationSnapshot;
    readonly managedPreimages: ConsumerUpgradeManagedPreimagesV2;
  }): Promise<PreparedConsumerUpgradeV1>;
  activateAndVerifyManaged(options: {
    readonly authority: ConsumerUpgradeAuthorityV2 | ConsumerUpgradeAuthorityV3;
    readonly consumerRoot: string;
  }): Promise<void>;
  restoreAndVerifyManaged(options: {
    readonly current: ConsumerIntegrationDesiredStateV3 | ManagedSuccessorProfile;
    readonly consumerRoot: string;
  }): Promise<void>;
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
  prepareV1ToV2(options: {
    readonly targetLockfile?: Uint8Array;
    readonly authority: ConsumerUpgradeAuthorityV2;
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV1;
    readonly expectedSourceRevision: string;
    readonly expectedSourceSnapshot: ConsumerIntegrationSnapshot;
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
