import type { KnownFileTransactionPlanV1 } from "@agent-teams/repository-mutation";
import type {
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationDesiredStateV3,
  ConsumerUpgradeAuthorityV3,
  ConsumerUpgradeAuthorityV1,
  ConsumerUpgradeAuthorityV2,
  QualifiedDocsCohortBindingV1,
  QualifiedDocsCohortBindingV2,
} from "../../domain/model.js";
import type { RetainedConsumerRestoration } from "../model/consumer-restoration.js";

export interface ManagedRestorationAuthorityReader {
  readManagedRestoration(options: {
    readonly source: ConsumerUpgradeAuthorityV3["cohort"];
    readonly origin: QualifiedDocsCohortBindingV2;
    readonly repository: ConsumerIntegrationDesiredStateV1["repository"];
  }): Promise<{ readonly revision: string; readonly target: ConsumerUpgradeAuthorityV2 }>;
}

export interface ConsumerRestorationAuthorityReader {
  readRestoration(options: {
    readonly source: QualifiedDocsCohortBindingV2;
    readonly origin: QualifiedDocsCohortBindingV1;
    readonly repository: ConsumerIntegrationDesiredStateV1["repository"];
  }): Promise<{
    readonly source: ConsumerUpgradeAuthorityV1 | ConsumerUpgradeAuthorityV2;
    readonly target: ConsumerUpgradeAuthorityV1 | ConsumerUpgradeAuthorityV2;
  }>;
}

export interface ConsumerRestorationRecorder {
  prepareManaged?(options: {
    readonly consumerRoot: string;
    readonly sourceRevision: string;
    readonly current: ConsumerIntegrationDesiredStateV3;
    readonly target: ConsumerUpgradeAuthorityV3["cohort"];
    readonly plan: KnownFileTransactionPlanV1;
    readonly proofPath: string;
  }): Promise<RetainedConsumerRestoration>;
  prepare(options: {
    readonly consumerRoot: string;
    readonly sourceRevision: string;
    readonly current: ConsumerIntegrationDesiredStateV1;
    readonly target: QualifiedDocsCohortBindingV2;
    readonly plan: KnownFileTransactionPlanV1;
    readonly proofPath: string;
  }): Promise<RetainedConsumerRestoration>;
}
