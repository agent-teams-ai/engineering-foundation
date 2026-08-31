import {
  applyKnownFileTransaction,
  inspectKnownFileTransactionBarrier,
  recoverKnownFileTransaction
} from "@agent-teams/repository-mutation";

import type {
  ConsumerIntegrationTransactionPort
} from "../application/ports/consumer-integration-lifecycle.js";

export const foundationKnownFileTransaction: ConsumerIntegrationTransactionPort =
  Object.freeze({
    inspect: inspectKnownFileTransactionBarrier,
    apply: applyKnownFileTransaction,
    recover: recoverKnownFileTransaction
  });
