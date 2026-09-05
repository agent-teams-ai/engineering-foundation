import type { KnownFileCoordination } from "./known-file-coordination.js";
import type { KnownFileTransactionPlanV1 } from "../../application/model/known-file-transaction.js";
import type { KnownFileTransactionJournalV1 } from "../../application/model/known-file-transaction-journal.js";
import { classifyKnownFileOperation, matchesKnownFileImage, maximumKnownFileEvidenceBytes, observeKnownFile } from "./node-known-file-transaction-filesystem.js";
import { KnownFileTransactionError } from "../../application/model/known-file-transaction-error.js";

export async function observeInitialKnownFileJournal(coordination: Pick<KnownFileCoordination, "readBoundedRegularFile">,
  root: string,
  plan: KnownFileTransactionPlanV1
): Promise<KnownFileTransactionJournalV1> {
  const operations = [];
  for (const operation of plan.operations) {
    const observation = await observeKnownFile(coordination,
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

async function verifyKnownFilePostimages(coordination: Pick<KnownFileCoordination, "readBoundedRegularFile">,
  root: string,
  journal: KnownFileTransactionJournalV1,
  code: "KNOWN_FILE_COMMITTED_DRIFT" | "KNOWN_FILE_PRECOMMIT_DRIFT",
  message: (path: string) => string
): Promise<void> {
  for (const operation of journal.plan.operations) {
    const observation = await observeKnownFile(coordination, root, operation.path, operation.postimage.size);
    if (!matchesKnownFileImage(observation, operation.postimage)) {
      throw new KnownFileTransactionError(code, message(operation.path));
    }
  }
}

export async function verifyApplyingKnownFilePostimages(coordination: Pick<KnownFileCoordination, "readBoundedRegularFile">,
  root: string,
  journal: KnownFileTransactionJournalV1
): Promise<void> {
  await verifyKnownFilePostimages(coordination,
    root,
    journal,
    "KNOWN_FILE_PRECOMMIT_DRIFT",
    (path) => `Transaction postimage changed before commit: ${path}.`
  );
}

export async function verifyCommittedKnownFilePostimages(coordination: Pick<KnownFileCoordination, "readBoundedRegularFile">,
  root: string,
  journal: KnownFileTransactionJournalV1
): Promise<void> {
  await verifyKnownFilePostimages(coordination,
    root,
    journal,
    "KNOWN_FILE_COMMITTED_DRIFT",
    (path) => `Committed postimage changed before journal retirement: ${path}.`
  );
}
