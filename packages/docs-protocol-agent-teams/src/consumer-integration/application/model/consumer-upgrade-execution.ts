import type {
  KnownFileTransactionReceiptV1
} from "@agent-teams/repository-mutation/known-file";

import type {
  ConsumerIntegrationDigest,
  ConsumerIntegrationIssue,
  ConsumerUpgradeAuthorityV1
} from "../../domain/model.js";

export interface ConsumerUpgradeExecutionV1 {
  readonly schemaVersion: 1;
  readonly command: "consumer.upgrade";
  readonly outcome: "blocked" | "current" | "upgraded";
  readonly issues: readonly ConsumerIntegrationIssue[];
  readonly authority?: {
    readonly repository: ConsumerUpgradeAuthorityV1["repository"];
    readonly path: ConsumerUpgradeAuthorityV1["path"];
    readonly revision: string;
    readonly cohortId: string;
    readonly recordDigest: ConsumerIntegrationDigest;
    readonly qualificationEventDigest: ConsumerIntegrationDigest;
  };
  readonly receipt?: KnownFileTransactionReceiptV1;
}
