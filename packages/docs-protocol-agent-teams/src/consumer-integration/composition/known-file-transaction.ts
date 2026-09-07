import {
  applyKnownFileTransaction,
  inspectKnownFileTransactionBarrier,
  recoverKnownFileTransaction
} from "@agent-teams/repository-mutation";

import { createFoundationKnownFileTransaction } from "../adapters/foundation-known-file-transaction.js";

export const foundationKnownFileTransaction = createFoundationKnownFileTransaction({
  inspect: inspectKnownFileTransactionBarrier,
  apply: applyKnownFileTransaction,
  recover: recoverKnownFileTransaction
});
