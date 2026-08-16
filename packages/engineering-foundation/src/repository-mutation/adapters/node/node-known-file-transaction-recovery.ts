import {
  constants,
  lstat,
  open,
  rename,
  rmdir,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { LOCAL_STATE_DIRECTORY } from "../../../foundation-state-contract.js";
import { installedFoundationVersion } from "../../../package-version.js";
import { createNodeFoundationTransactionCoordinator } from "../../../transaction-coordination/adapters/node/node-foundation-transaction-coordinator.js";
import { installedFoundationBuildIdentity } from "../../../transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import { pruneFoundationStateDirectory } from "../../../transaction-coordination/adapters/node/node-foundation-state-directory.js";
import type {
  KnownFileImageV1,
  KnownFileTransactionPlanV1,
  KnownFileTransactionReceiptV1
} from "../../application/model/known-file-transaction.js";
import type {
  KnownFileTransactionJournalOperationV1,
  KnownFileTransactionJournalV1
} from "../../application/model/known-file-transaction-journal.js";
import { deserializeKnownFileIdentity } from "../../application/model/known-file-transaction-journal.js";
import {
  captureFileHandleIdentity,
  readBoundedRegularFile,
  readBoundedRegularFileHandle
} from "./node-bounded-regular-file.js";
import { syncDirectoryStrictly } from "./node-directory-durability.js";
import {
  canonicalKnownFileRoot,
  knownFileErrorCode,
  knownFileImageBytes,
  knownFileTemporaryName,
  KnownFileTransactionError,
  matchesKnownFileImage,
  maximumKnownFileEvidenceBytes,
  observeKnownFile,
  sameKnownFileIdentity
} from "./node-known-file-transaction-filesystem.js";
import { NodeKnownFileTransactionJournalStore } from "./node-known-file-transaction-journal-store.js";
import { sha256Json } from "../../../canonical-json.js";
import {
  compileKnownFileTransactionReceipt,
  verifyCommittedKnownFilePostimages
} from "./node-known-file-transaction.js";

async function prepareRollbackTemporary(options: {
  readonly operationPath: string;
  readonly path: string;
  readonly preimage: KnownFileImageV1;
}): Promise<void> {
  let handle: FileHandle;
  let rollbackIdentity;
  try {
    handle = await open(options.path, "wx", 0o600);
    rollbackIdentity = await captureFileHandleIdentity(handle);
  } catch (error) {
    if (knownFileErrorCode(error) !== "EEXIST") {throw error;}
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    handle = await open(options.path, constants.O_RDWR | noFollow);
    try {
      const stale = await readBoundedRegularFileHandle(
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
      rollbackIdentity = await captureFileHandleIdentity(handle);
      if (!sameKnownFileIdentity(rollbackIdentity, stale.identity)) {
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
  const prepared = await readBoundedRegularFile(options.path, options.preimage.size);
  if (prepared.outcome !== "read" ||
    !sameKnownFileIdentity(prepared.identity, rollbackIdentity) ||
    !matchesKnownFileImage({
      state: "file",
      bytes: prepared.bytes,
      identity: prepared.identity,
      mode: prepared.mode & 0o777
    }, options.preimage)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Rollback temporary changed before publication: ${options.operationPath}.`
    );
  }
}

async function restorePreimage(options: {
  readonly operation: KnownFileTransactionPlanV1["operations"][number];
  readonly operationIndex: number;
  readonly root: string;
  readonly journalOperation: KnownFileTransactionJournalOperationV1;
}): Promise<void> {
  const operation = options.operation;
  const destination = join(options.root, ...operation.path.split("/"));
  const parent = dirname(destination);
  const observed = await observeKnownFile(
    options.root,
    operation.path,
    maximumKnownFileEvidenceBytes(operation)
  );
  const postMatches = matchesKnownFileImage(observed, operation.postimage);
  if (operation.precondition.state === "absent") {
    if (observed.state === "absent") {return;}
    if (!postMatches || observed.identity === undefined ||
      !("temporaryIdentity" in options.journalOperation) ||
      !sameKnownFileIdentity(
        observed.identity,
        deserializeKnownFileIdentity(options.journalOperation.temporaryIdentity)
      )) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Created destination changed after publication: ${operation.path}.`
      );
    }
    await unlink(destination);
    await syncDirectoryStrictly(parent);
    return;
  }
  const matched = options.journalOperation.matchedPreimage;
  if (matched === undefined) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_JOURNAL_INVALID",
      `Replacement preimage binding is absent: ${operation.path}.`
    );
  }
  const preimage = operation.precondition.acceptedPreimages[matched]!;
  if (matchesKnownFileImage(observed, preimage)) {return;}
  if (!postMatches) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Published destination changed before rollback: ${operation.path}.`
    );
  }
  if (!("temporaryIdentity" in options.journalOperation) ||
    observed.identity === undefined ||
    !sameKnownFileIdentity(
      observed.identity,
      deserializeKnownFileIdentity(options.journalOperation.temporaryIdentity)
    )) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Published destination identity changed before rollback: ${operation.path}.`
    );
  }
  const rollbackPath = join(
    parent,
    `.${basename(operation.path)}.agent-teams.rollback.${options.operationIndex}.tmp`
  );
  await prepareRollbackTemporary({
    operationPath: operation.path,
    path: rollbackPath,
    preimage
  });
  const beforeRename = await observeKnownFile(
    options.root,
    operation.path,
    operation.postimage.size
  );
  if (!matchesKnownFileImage(beforeRename, operation.postimage)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Destination changed during rollback: ${operation.path}.`
    );
  }
  await rename(rollbackPath, destination);
  await syncDirectoryStrictly(parent);
  if (!matchesKnownFileImage(
    await observeKnownFile(options.root, operation.path, preimage.size),
    preimage
  )) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_FAILED",
      `Preimage restoration failed: ${operation.path}.`
    );
  }
}

async function cleanupOperationTemporaries(options: {
  readonly journal: KnownFileTransactionJournalV1;
  readonly operationIndex: number;
  readonly root: string;
}): Promise<void> {
  const operation = options.journal.plan.operations[options.operationIndex]!;
  const journalOperation = options.journal.operations[options.operationIndex]!;
  const parent = dirname(join(options.root, ...operation.path.split("/")));
  const candidates: readonly { readonly image: KnownFileImageV1; readonly path: string }[] = [
    {
      image: operation.postimage,
      path: join(parent, knownFileTemporaryName(
        operation.path,
        options.journal.plan.planDigest,
        options.operationIndex
      ))
    },
    ...(operation.precondition.state === "known-file" &&
      journalOperation.matchedPreimage !== undefined
      ? [{
          image: operation.precondition.acceptedPreimages[journalOperation.matchedPreimage]!,
          path: join(parent, `.${basename(operation.path)}.agent-teams.rollback.${options.operationIndex}.tmp`)
        }]
      : [])
  ];
  for (const candidate of candidates) {
    let observed;
    try {
      observed = await readBoundedRegularFile(candidate.path, candidate.image.size);
    } catch (error) {
      if (knownFileErrorCode(error) === "ENOENT") {continue;}
      throw error;
    }
    if (observed.outcome !== "read" || !matchesKnownFileImage({
      state: "file", bytes: observed.bytes, identity: observed.identity,
      mode: observed.mode & 0o777
    }, candidate.image)) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Transaction temporary is foreign or modified: ${operation.path}.`
      );
    }
    if (candidate.image === operation.postimage) {
      if (!("temporaryIdentity" in journalOperation) ||
        !sameKnownFileIdentity(
          observed.identity,
          deserializeKnownFileIdentity(journalOperation.temporaryIdentity)
        )) {
        throw new KnownFileTransactionError(
          "KNOWN_FILE_RECOVERY_CONFLICT",
          `Transaction temporary identity is absent or changed: ${operation.path}.`
        );
      }
    }
    await unlink(candidate.path);
    await syncDirectoryStrictly(parent);
  }
}

async function removeCreatedDirectories(
  root: string,
  directories: KnownFileTransactionJournalV1["createdDirectories"]
): Promise<void> {
  for (const directory of directories.toReversed()) {
    const path = join(root, ...directory.path.split("/"));
    let metadata;
    try {
      metadata = await lstat(path, { bigint: true });
    } catch (error) {
      if (knownFileErrorCode(error) === "ENOENT") {continue;}
      throw error;
    }
    const expected = deserializeKnownFileIdentity(directory.identity);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      metadata.dev !== expected.dev || metadata.ino !== expected.ino ||
      metadata.birthtimeNs !== expected.birthtimeNs) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Transaction-created directory changed before cleanup: ${directory.path}.`
      );
    }
    try {
      await rmdir(path);
      await syncDirectoryStrictly(dirname(path));
    } catch (error) {
      if (knownFileErrorCode(error) !== "ENOTEMPTY") {throw error;}
    }
  }
}

async function rollback(root: string, journal: KnownFileTransactionJournalV1): Promise<void> {
  for (let index = journal.operations.length - 1; index >= 0; index -= 1) {
    const journalOperation = journal.operations[index]!;
    if (!["publishing", "published"].includes(journalOperation.state)) {continue;}
    await restorePreimage({
      operation: journal.plan.operations[index]!,
      operationIndex: index,
      root,
      journalOperation
    });
    await cleanupOperationTemporaries({ journal, operationIndex: index, root });
  }
  for (let index = journal.operations.length - 1; index >= 0; index -= 1) {
    if (!["publishing", "published"].includes(journal.operations[index]!.state)) {
      await cleanupOperationTemporaries({ journal, operationIndex: index, root });
    }
  }
  await removeCreatedDirectories(root, journal.createdDirectories);
}

function compileRolledBackReceipt(
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

export async function recoverKnownFileTransaction(options: {
  readonly consumerRoot: string;
}): Promise<KnownFileTransactionReceiptV1> {
  if (process.platform === "win32") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_APPLY_UNSUPPORTED",
      "Known-file recovery requires strict directory durability and is not qualified on Windows."
    );
  }
  const root = await canonicalKnownFileRoot(options.consumerRoot);
  const coordinator = await createNodeFoundationTransactionCoordinator(root);
  const lease = await coordinator.acquire({
    requestedMutation: "known-file-transaction",
    allowRecoveryOf: "known-file-transaction"
  });
  let retainBarrier = true;
  try {
    const store = new NodeKnownFileTransactionJournalStore(
      join(root, LOCAL_STATE_DIRECTORY)
    );
    await store.canonicalizeTemporary();
    const stored = await store.read();
    if (stored === undefined) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_JOURNAL_MISSING",
        "Known-file recovery journal disappeared."
      );
    }
    const [version, buildIdentity] = await Promise.all([
      installedFoundationVersion(),
      installedFoundationBuildIdentity()
    ]);
    if (stored.envelope.foundation.version !== version ||
      stored.envelope.foundation.buildIdentity !== buildIdentity) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_EXACT_BUILD_REQUIRED",
        "The exact Foundation build that created this journal must recover it."
      );
    }
    if (stored.envelope.state === "COMMITTED") {
      await verifyCommittedKnownFilePostimages(root, stored.envelope.journal);
      const result = compileKnownFileTransactionReceipt(
        stored.envelope.journal,
        "applied"
      );
      await store.remove(stored.authority);
      retainBarrier = false;
      return result;
    }
    await rollback(root, stored.envelope.journal);
    const result = compileRolledBackReceipt(stored.envelope.journal);
    await store.remove(stored.authority);
    retainBarrier = false;
    return result;
  } finally {
    await lease.release({ retainTransactionBarrier: retainBarrier });
    if (!retainBarrier) {await pruneFoundationStateDirectory(root);}
  }
}
