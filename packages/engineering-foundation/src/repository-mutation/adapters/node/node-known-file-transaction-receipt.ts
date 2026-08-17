import { sha256Json } from "../../../canonical-json.js";
import type { KnownFileTransactionReceiptV1 } from "../../application/model/known-file-transaction.js";
import type { KnownFileTransactionJournalV1 } from "../../application/model/known-file-transaction-journal.js";
import { KnownFileTransactionError } from "./node-known-file-transaction-filesystem.js";

export function compileRolledBackReceipt(
  journal: KnownFileTransactionJournalV1
): KnownFileTransactionReceiptV1 {
  const operations = journal.operations.map((entry, index) => {
    const planOperation = journal.plan.operations[index]!;
    if (entry.state === "already-satisfied") {
      return Object.freeze({
        path: entry.path,
        outcome: "already-satisfied" as const,
        resultDigest: planOperation.postimage.digest
      });
    }
    if (planOperation.precondition.state === "absent") {
      return Object.freeze({
        path: entry.path,
        outcome: "rolled-back-to-absent" as const
      });
    }
    if (entry.matchedPreimage === undefined) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_JOURNAL_INVALID",
        `Replacement preimage binding is absent: ${entry.path}.`
      );
    }
    return Object.freeze({
      path: entry.path,
      outcome: "rolled-back-to-preimage" as const,
      resultDigest: planOperation.precondition.acceptedPreimages[entry.matchedPreimage]!.digest
    });
  });
  const body = {
    schemaVersion: 1 as const,
    protocol: "foundation.replace-known-file/v1" as const,
    planDigest: journal.plan.planDigest,
    outcome: "rolled-back" as const,
    operations: Object.freeze(operations)
  };
  return Object.freeze({
    ...body,
    receiptDigest: sha256Json({
      domain: "agent-teams.foundation.known-file-transaction-receipt/v1",
      body
    })
  });
}
