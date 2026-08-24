import { lstat, rmdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

import type { KnownFileTransactionPlanV1 } from "../../application/model/known-file-transaction.js";
import type { KnownFileTransactionJournalV1 } from "../../application/model/known-file-transaction-journal.js";
import { deserializeKnownFileIdentity } from "../../application/model/known-file-transaction-journal.js";
import { syncDirectoryStrictly } from "./node-directory-durability.js";
import {
  knownFileErrorCode,
  KnownFileTransactionError,
  matchesKnownFileImage,
  sameKnownFileIdentity
} from "./node-known-file-transaction-filesystem.js";
import { observeRecoveryFile } from "./node-known-file-recovery-filesystem.js";
import type { KnownFileRecoveryFaultInjector } from "./node-known-file-recovery-state.js";

function matchesRollbackCopy(
  observed: Awaited<ReturnType<typeof observeRecoveryFile>>,
  expected: ReturnType<typeof deserializeKnownFileIdentity>,
  preimage: KnownFileTransactionPlanV1["operations"][number]["postimage"]
): boolean {
  return observed.state === "file" && observed.identity !== undefined &&
    sameKnownFileIdentity(observed.identity, expected) &&
    matchesKnownFileImage(observed, preimage);
}

export async function cleanupRestoredCapturedPreimage(options: {
  readonly destination: string;
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
  readonly journalOperation: KnownFileTransactionJournalV1["operations"][number] & {
    readonly captureDirectoryIdentity: NonNullable<Extract<
      KnownFileTransactionJournalV1["operations"][number],
      { readonly temporaryIdentity: unknown }
    >["captureDirectoryIdentity"]>;
    readonly capturedPreimageIdentity?: NonNullable<Extract<
      KnownFileTransactionJournalV1["operations"][number],
      { readonly temporaryIdentity: unknown }
    >["capturedPreimageIdentity"]>;
  };
  readonly operation: KnownFileTransactionPlanV1["operations"][number] & {
    readonly precondition: Extract<
      KnownFileTransactionPlanV1["operations"][number]["precondition"],
      { readonly state: "known-file" }
    >;
  };
  readonly operationIndex: number;
  readonly parent: string;
  readonly paths: { readonly captured: string; readonly directory: string; readonly retired: string };
  readonly recoveryMaximumBytes: number;
}): Promise<void> {
  const matched = options.journalOperation.matchedPreimage;
  if (matched === undefined) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_JOURNAL_INVALID",
      `Restored replacement lacks exact preimage authority: ${options.operation.path}.`
    );
  }
  const preimage = options.operation.precondition.acceptedPreimages[matched]!;
  const destinationObserved = await observeRecoveryFile(
    options.destination,
    options.recoveryMaximumBytes
  );
  if (!matchesKnownFileImage(destinationObserved, preimage)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Restored destination changed during cleanup: ${options.operation.path}.`
    );
  }
  const rollbackPath = join(
    options.parent,
    `.${basename(options.operation.path)}.agent-teams.rollback.${options.operationIndex}.tmp`
  );
  if (options.journalOperation.rollbackTemporaryIdentity !== undefined) {
    const rollbackObserved = await observeRecoveryFile(rollbackPath, preimage.size);
    if (rollbackObserved.state === "file") {
      const expectedRollback = deserializeKnownFileIdentity(
        options.journalOperation.rollbackTemporaryIdentity
      );
      if (!matchesRollbackCopy(rollbackObserved, expectedRollback, preimage)) {
        throw new KnownFileTransactionError(
          "KNOWN_FILE_RECOVERY_CONFLICT",
          `Rollback copy changed during cleanup: ${options.operation.path}.`
        );
      }
      await unlink(rollbackPath);
      await syncDirectoryStrictly(options.parent);
    }
  }
  const directory = await lstat(options.paths.directory, { bigint: true }).catch(
    (error: unknown) => {
      if (knownFileErrorCode(error) === "ENOENT") {return null;}
      throw error;
    }
  );
  if (directory === null) {return;}
  const expectedDirectory = deserializeKnownFileIdentity(
    options.journalOperation.captureDirectoryIdentity
  );
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
    directory.birthtimeNs !== expectedDirectory.birthtimeNs ||
    directory.dev !== expectedDirectory.dev || directory.ino !== expectedDirectory.ino) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Rollback capture directory changed during cleanup: ${options.operation.path}.`
    );
  }
  const capturedObserved = await observeRecoveryFile(
    options.paths.captured,
    options.recoveryMaximumBytes
  );
  if (capturedObserved.state === "file") {
    const expectedCaptured = options.journalOperation.capturedPreimageIdentity;
    if (expectedCaptured === undefined || capturedObserved.identity === undefined ||
      !sameKnownFileIdentity(capturedObserved.identity, deserializeKnownFileIdentity(expectedCaptured)) ||
      !matchesKnownFileImage(capturedObserved, preimage)) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Rollback capture changed during cleanup: ${options.operation.path}.`
      );
    }
    await unlink(options.paths.captured);
    await syncDirectoryStrictly(options.paths.directory);
    await options.faultInjector?.({
      phase: "after-rollback-capture-unlinked",
      operationIndex: options.operationIndex,
      path: options.operation.path
    });
  }
  const retiredObserved = await observeRecoveryFile(
    options.paths.retired,
    options.recoveryMaximumBytes
  );
  if (retiredObserved.state !== "absent") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Rollback capture retains foreign retired evidence: ${options.operation.path}.`
    );
  }
  await rmdir(options.paths.directory);
  await syncDirectoryStrictly(options.parent);
}
