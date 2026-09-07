import type { KnownFileCoordination } from "./known-file-coordination.js";
import {
  constants,
  lstat,
  open,
  opendir,
  rmdir,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { KnownFileImageV1 } from "../../application/model/known-file-transaction.js";
import { type KnownFileTransactionJournalV1, deserializeKnownFileIdentity } from "../../application/model/known-file-transaction-journal.js";


import { syncDirectoryStrictly } from "./node-directory-durability.js";
import { knownFileErrorCode, knownFileCaptureDirectoryName, knownFileImageBytes, matchesKnownFileImage, sameKnownFileIdentity, type ObservedKnownFile } from "./node-known-file-transaction-filesystem.js";
import { KnownFileTransactionError } from "../../application/model/known-file-transaction-error.js";

export function knownFileCapturePaths(options: {
  readonly operationPath: string;
  readonly operationIndex: number;
  readonly parent: string;
  readonly planDigest: string;
}): { readonly captured: string; readonly directory: string; readonly retired: string } {
  const directory = join(options.parent, knownFileCaptureDirectoryName(
    options.operationPath,
    options.planDigest,
    options.operationIndex
  ));
  return {
    captured: join(directory, "preimage"),
    directory,
    retired: join(directory, "retired")
  };
}

async function boundedCaptureEntries(path: string): Promise<readonly string[]> {
  const directory = await opendir(path);
  const entries: string[] = [];
  try {
    for (;;) {
      const entry = await directory.read();
      if (entry === null) {return entries.toSorted();}
      entries.push(entry.name);
      if (entries.length > 2) {
        throw new KnownFileTransactionError(
          "KNOWN_FILE_RECOVERY_CONFLICT",
          "Transaction capture directory contains excess foreign evidence."
        );
      }
    }
  } finally {
    await directory.close();
  }
}

async function assertCaptureDirectoryIdentity(
  path: string,
  expected: ReturnType<typeof deserializeKnownFileIdentity>,
  displayPath: string
): Promise<boolean> {
  const metadata = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (knownFileErrorCode(error) === "ENOENT") {return null;}
    throw error;
  });
  if (metadata === null) {return false;}
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
    metadata.birthtimeNs !== expected.birthtimeNs || metadata.dev !== expected.dev ||
    metadata.ino !== expected.ino) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Transaction capture directory changed: ${displayPath}.`
    );
  }
  return true;
}

export async function cleanupCommittedKnownFileCaptures(coordination: Pick<KnownFileCoordination, "readBoundedRegularFile">,
  root: string,
  journal: KnownFileTransactionJournalV1,
  faultInjector?: (point: {
    readonly operationIndex: number;
    readonly path: string;
    readonly phase: "after-committed-capture-unlinked";
  }) => Promise<void> | void
): Promise<void> {
  for (const [index, journalOperation] of journal.operations.entries()) {
    if (!("temporaryIdentity" in journalOperation) ||
      journalOperation.captureDirectoryIdentity === undefined) {continue;}
    const operation = journal.plan.operations[index]!;
    const parent = dirname(join(root, ...operation.path.split("/")));
    const paths = knownFileCapturePaths({
      operationIndex: index,
      operationPath: operation.path,
      parent,
      planDigest: journal.plan.planDigest
    });
    if (operation.precondition.state !== "known-file" ||
      journalOperation.matchedPreimage === undefined) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Committed replacement lacks exact preimage authority: ${operation.path}.`
      );
    }
    const preimage = operation.precondition.acceptedPreimages[journalOperation.matchedPreimage]!;
    if (journalOperation.rollbackTemporaryIdentity !== undefined) {
      const rollbackPath = join(
        parent,
        `.${basename(operation.path)}.agent-teams.rollback.${index}.tmp`
      );
      const rollback = await observeRecoveryFile(coordination, rollbackPath, preimage.size);
      if (rollback.state === "file") {
        const expectedRollback = deserializeKnownFileIdentity(
          journalOperation.rollbackTemporaryIdentity
        );
        if (rollback.identity === undefined ||
          !sameKnownFileIdentity(rollback.identity, expectedRollback) ||
          !matchesKnownFileImage(rollback, preimage)) {
          throw new KnownFileTransactionError(
            "KNOWN_FILE_RECOVERY_CONFLICT",
            `Committed rollback copy changed: ${operation.path}.`
          );
        }
        await unlink(rollbackPath);
        await syncDirectoryStrictly(parent);
      }
    }
    const expectedDirectory = deserializeKnownFileIdentity(journalOperation.captureDirectoryIdentity);
    const directoryExists = await assertCaptureDirectoryIdentity(
      paths.directory,
      expectedDirectory,
      operation.path
    );
    if (!directoryExists) {continue;}
    const entries = await boundedCaptureEntries(paths.directory);
    if (entries.length === 0) {
      await rmdir(paths.directory);
      await syncDirectoryStrictly(parent);
      continue;
    }
    if (journalOperation.capturedPreimageIdentity === undefined) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Committed replacement lacks captured preimage authority: ${operation.path}.`
      );
    }
    const captured = await coordination.readBoundedRegularFile(
      paths.captured,
      operation.precondition.acceptedPreimages[journalOperation.matchedPreimage]!.size
    );
    const expectedCaptured = deserializeKnownFileIdentity(journalOperation.capturedPreimageIdentity);
    if (captured.outcome !== "read" ||
      !sameKnownFileIdentity(captured.identity, expectedCaptured) ||
      !matchesKnownFileImage({
        state: "file", bytes: captured.bytes, identity: captured.identity,
        mode: captured.mode & 0o777
      }, preimage)) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Committed captured preimage changed: ${operation.path}.`
      );
    }
    if (entries.join(",") !== "preimage") {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Committed capture directory contains foreign evidence: ${operation.path}.`
      );
    }
    await unlink(paths.captured);
    await syncDirectoryStrictly(paths.directory);
    await faultInjector?.({
      operationIndex: index,
      path: operation.path,
      phase: "after-committed-capture-unlinked"
    });
    await rmdir(paths.directory);
    await syncDirectoryStrictly(parent);
  }
}

export async function observeRecoveryFile(coordination: Pick<KnownFileCoordination, "readBoundedRegularFile">,
  path: string,
  maximumBytes: number
): Promise<ObservedKnownFile> {
  let observed;
  try {
    observed = await coordination.readBoundedRegularFile(path, maximumBytes);
  } catch (error) {
    if (knownFileErrorCode(error) === "ENOENT") {return { state: "absent" };}
    throw error;
  }
  if (observed.outcome !== "read") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      "Recovery path is not one stable bounded regular file."
    );
  }
  return {
    state: "file",
    bytes: observed.bytes,
    identity: observed.identity,
    mode: observed.mode & 0o777
  };
}

export async function prepareRollbackTemporary(coordination: Pick<KnownFileCoordination, "captureFileHandleIdentity" | "readBoundedRegularFile" | "readBoundedRegularFileHandle">, options: {
  readonly expectedIdentity?: ReturnType<typeof deserializeKnownFileIdentity>;
  readonly operationPath: string;
  readonly path: string;
  readonly preimage: KnownFileImageV1;
}): Promise<Awaited<ReturnType<KnownFileCoordination["captureFileHandleIdentity"]>>> {
  let handle: FileHandle;
  let rollbackIdentity;
  let created = false;
  try {
    handle = await open(options.path, "wx", 0o600);
    created = true;
    rollbackIdentity = await coordination.captureFileHandleIdentity(handle);
  } catch (error) {
    if (knownFileErrorCode(error) !== "EEXIST") {throw error;}
    if (options.expectedIdentity === undefined) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Rollback temporary exists without durable identity authority: ${options.operationPath}.`
      );
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    handle = await open(options.path, constants.O_RDWR | noFollow);
    try {
      const stale = await coordination.readBoundedRegularFileHandle(
        handle,
        options.path,
        options.preimage.size
      );
      if (stale.outcome !== "read" || !matchesKnownFileImage({
        state: "file", bytes: stale.bytes, identity: stale.identity,
        mode: stale.mode & 0o777
      }, options.preimage)) {
        throw new KnownFileTransactionError(
          "KNOWN_FILE_RECOVERY_CONFLICT",
          `Rollback temporary is foreign or modified: ${options.operationPath}.`
        );
      }
      rollbackIdentity = await coordination.captureFileHandleIdentity(handle);
      if (!sameKnownFileIdentity(rollbackIdentity, stale.identity) ||
        !sameKnownFileIdentity(rollbackIdentity, options.expectedIdentity)) {
        throw new KnownFileTransactionError(
          "KNOWN_FILE_RECOVERY_CONFLICT",
          `Rollback temporary changed while it was opened: ${options.operationPath}.`
        );
      }
    } catch (inspectionError) {
      await handle.close();
      throw inspectionError;
    }
  }
  if (created) {
    try {
      const bytes = knownFileImageBytes(options.preimage);
      await handle.truncate(0);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset
        );
        if (bytesWritten === 0) {
          throw new KnownFileTransactionError(
            "KNOWN_FILE_RECOVERY_FAILED",
            `Rollback temporary write made no progress: ${options.operationPath}.`
          );
        }
        offset += bytesWritten;
      }
      await handle.chmod(options.preimage.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    await handle.close();
  }
  const prepared = await coordination.readBoundedRegularFile(options.path, options.preimage.size);
  if (prepared.outcome !== "read" ||
    !sameKnownFileIdentity(prepared.identity, rollbackIdentity) ||
    !matchesKnownFileImage({
      state: "file", bytes: prepared.bytes, identity: prepared.identity,
      mode: prepared.mode & 0o777
    }, options.preimage)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Rollback temporary changed before publication: ${options.operationPath}.`
    );
  }
  return rollbackIdentity;
}
