import type { KnownFileTransactionPlanV1 } from "../../application/model/known-file-transaction.js";
import type { KnownFileTransactionJournalV1 } from "../../application/model/known-file-transaction-journal.js";
import {
  classifyKnownFileOperation,
  KnownFileTransactionError,
  matchesKnownFileImage,
  maximumKnownFileEvidenceBytes,
  observeKnownFile
} from "./node-known-file-transaction-filesystem.js";

export async function observeInitialKnownFileJournal(
  root: string,
  plan: KnownFileTransactionPlanV1
): Promise<KnownFileTransactionJournalV1> {
  const operations = [];
  for (const operation of plan.operations) {
    const observation = await observeKnownFile(
      root,
      operation.path,
      maximumKnownFileEvidenceBytes(operation)
    );
    operations.push(classifyKnownFileOperation(operation, observation));
  }
  return Object.freeze({
    schemaVersion: 1,
    plan,
    operations: Object.freeze(operations),
    authorizedDirectories: Object.freeze([]),
    createdDirectories: Object.freeze([])
  });
}

async function verifyKnownFilePostimages(
  root: string,
  journal: KnownFileTransactionJournalV1,
  code: "KNOWN_FILE_COMMITTED_DRIFT" | "KNOWN_FILE_PRECOMMIT_DRIFT",
  message: (path: string) => string
): Promise<void> {
  for (const operation of journal.plan.operations) {
    const observation = await observeKnownFile(root, operation.path, operation.postimage.size);
    if (!matchesKnownFileImage(observation, operation.postimage)) {
      throw new KnownFileTransactionError(code, message(operation.path));
    }
  }
}

export async function verifyApplyingKnownFilePostimages(
  root: string,
  journal: KnownFileTransactionJournalV1
): Promise<void> {
  await verifyKnownFilePostimages(
    root,
    journal,
    "KNOWN_FILE_PRECOMMIT_DRIFT",
    (path) => `Transaction postimage changed before commit: ${path}.`
  );
}

export async function verifyCommittedKnownFilePostimages(
  root: string,
  journal: KnownFileTransactionJournalV1
): Promise<void> {
  await verifyKnownFilePostimages(
    root,
    journal,
    "KNOWN_FILE_COMMITTED_DRIFT",
    (path) => `Committed postimage changed before journal retirement: ${path}.`
  );
}
