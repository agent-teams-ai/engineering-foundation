import type { KnownFileTransactionReceiptV1 } from "@agent-teams/engineering-foundation/mutation";

import type {
  ConsumerIntegrationIssue,
  ConsumerIntegrationPlanV1
} from "../../domain/model.js";

export interface ConsumerIntegrationExecutionV1 {
  readonly schemaVersion: 1;
  readonly command: "consumer.apply" | "consumer.check" | "consumer.plan" | "consumer.recover";
  readonly outcome: "applied" | "blocked" | "change-required" | "current" | "recovered";
  readonly issues: readonly ConsumerIntegrationIssue[];
  readonly plan?: ConsumerIntegrationPlanV1;
  readonly receipt?: KnownFileTransactionReceiptV1;
}
