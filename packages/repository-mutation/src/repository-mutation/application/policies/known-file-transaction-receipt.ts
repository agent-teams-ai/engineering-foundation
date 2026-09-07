import { canonicalJson, sha256Json, type CanonicalJsonValue } from "../../../canonical-json.js";
import type { KnownFileTransactionOperationOutcome, KnownFileTransactionReceiptV1 } from "../model/known-file-transaction.js";
import type { KnownFileTransactionJournalV1 } from "../model/known-file-transaction-journal.js";

export function compileKnownFileTransactionReceipt(
  journal: KnownFileTransactionJournalV1,
  outcome: "already-satisfied" | "applied"
): KnownFileTransactionReceiptV1 {
  const operations = journal.operations.map((entry, index) => {
    const planOperation = journal.plan.operations[index]!;
    const operationOutcome: KnownFileTransactionOperationOutcome =
      entry.state === "already-satisfied"
        ? "already-satisfied"
        : planOperation.precondition.state === "absent" ? "created" : "replaced";
    return Object.freeze({
      path: entry.path,
      outcome: operationOutcome,
      resultDigest: planOperation.postimage.digest
    });
  });
  const body = {
    schemaVersion: 1 as const,
    protocol: "agent-teams.repository-mutation.known-file/v1" as const,
    planDigest: journal.plan.planDigest,
    outcome,
    operations: Object.freeze(operations)
  };
  return Object.freeze({
    ...body,
    receiptDigest: sha256Json({
      domain: "agent-teams.repository-mutation.known-file-receipt/v1",
      body
    })
  });
}


export function canonicalKnownFileTransactionReceipt(
  value: KnownFileTransactionReceiptV1
): string {
  return `${canonicalJson(value as unknown as CanonicalJsonValue)}\n`;
}
