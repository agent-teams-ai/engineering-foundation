import { lstat, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { KnownFileImageV1 } from "../../application/model/known-file-transaction.js";
import type { KnownFileTransactionJournalV1 } from "../../application/model/known-file-transaction-journal.js";
import { deserializeKnownFileIdentity } from "../../application/model/known-file-transaction-journal.js";
import { readBoundedRegularFile } from "./node-bounded-regular-file.js";
import { syncDirectoryStrictly } from "./node-directory-durability.js";
import {
  knownFileErrorCode,
  knownFileTemporaryName,
  KnownFileTransactionError,
  matchesKnownFileImage,
  sameKnownFileIdentity
} from "./node-known-file-transaction-filesystem.js";
import { knownFileCapturePaths } from "./node-known-file-recovery-filesystem.js";
import { restorePreimage } from "./node-known-file-recovery-preimage.js";
import { retireJournalBoundPath } from "./node-known-file-recovery-retirement.js";
import type {
  KnownFileRecoveryFaultInjector,
  StoredRecoveryJournal
} from "./node-known-file-recovery-state.js";
import type { NodeKnownFileTransactionJournalStore } from "./node-known-file-transaction-journal-store.js";

async function cleanupOperationTemporaries(options: {
  readonly operationIndex: number;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}): Promise<void> {
  const operation = options.stored.envelope.payload.plan.operations[options.operationIndex]!;
  const journalOperation = options.stored.envelope.payload.operations[options.operationIndex]!;
  const parent = dirname(join(options.root, ...operation.path.split("/")));
  const candidates: readonly {
    readonly identity: ReturnType<typeof deserializeKnownFileIdentity> | undefined;
    readonly image: KnownFileImageV1;
    readonly kind: "rollback-temporary" | "temporary";
    readonly path: string;
    readonly authorizedWithoutIdentity?: boolean;
  }[] = [
    {
      identity: "temporaryIdentity" in journalOperation
        ? deserializeKnownFileIdentity(journalOperation.temporaryIdentity)
        : undefined,
      image: operation.postimage,
      kind: "temporary",
      authorizedWithoutIdentity: journalOperation.state === "temporary-authorized",
      path: join(parent, knownFileTemporaryName(
        operation.path,
        options.stored.envelope.payload.plan.planDigest,
        options.operationIndex
      ))
    },
    ...(operation.precondition.state === "known-file" &&
      journalOperation.matchedPreimage !== undefined
      ? [{
          identity: journalOperation.rollbackTemporaryIdentity === undefined
            ? undefined
            : deserializeKnownFileIdentity(journalOperation.rollbackTemporaryIdentity),
          image: operation.precondition.acceptedPreimages[journalOperation.matchedPreimage]!,
          kind: "rollback-temporary" as const,
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
    if (candidate.identity === undefined && candidate.authorizedWithoutIdentity === true) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Authorized temporary exists without durable ownership identity: ${operation.path}.`
      );
    }
    if (candidate.identity === undefined ||
      !sameKnownFileIdentity(observed.identity, candidate.identity)) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Transaction temporary identity is absent or changed: ${operation.path}.`
      );
    }
    await retireJournalBoundPath({
      expectedIdentity: candidate.identity,
      kind: candidate.kind,
      operationIndex: options.operationIndex,
      root: options.root,
      store: options.store,
      stored: options.stored
    });
  }
}

async function cleanupAuthorizedCapture(options: {
  readonly journal: KnownFileTransactionJournalV1;
  readonly operationIndex: number;
  readonly root: string;
}): Promise<void> {
  const operation = options.journal.plan.operations[options.operationIndex]!;
  const parent = dirname(join(options.root, ...operation.path.split("/")));
  const paths = knownFileCapturePaths({
    operationIndex: options.operationIndex,
    operationPath: operation.path,
    parent,
    planDigest: options.journal.plan.planDigest
  });
  const metadata = await lstat(paths.directory).catch((error: unknown) => {
    if (knownFileErrorCode(error) === "ENOENT") {return null;}
    throw error;
  });
  if (metadata === null) {return;}
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Authorized capture path is foreign: ${operation.path}.`
    );
  }
  throw new KnownFileTransactionError(
    "KNOWN_FILE_RECOVERY_CONFLICT",
    `Authorized capture exists without durable ownership identity: ${operation.path}.`
  );
}

async function removeAuthorizedDirectories(
  root: string,
  directories: KnownFileTransactionJournalV1["authorizedDirectories"]
): Promise<void> {
  for (const repositoryPath of directories.toReversed()) {
    const path = join(root, ...repositoryPath.split("/"));
    const metadata = await lstat(path).catch((error: unknown) => {
      if (knownFileErrorCode(error) === "ENOENT") {return null;}
      throw error;
    });
    if (metadata === null) {continue;}
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Authorized directory path is foreign: ${repositoryPath}.`
      );
    }
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Authorized directory exists without durable ownership identity: ${repositoryPath}.`
    );
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

export async function rollbackKnownFileRecovery(options: {
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}): Promise<void> {
  for (let index = options.stored.envelope.payload.operations.length - 1; index >= 0; index -= 1) {
    let journalOperation = options.stored.envelope.payload.operations[index]!;
    if (journalOperation.retirement !== undefined) {
      await retireJournalBoundPath({
        expectedIdentity: deserializeKnownFileIdentity(journalOperation.retirement.pathIdentity),
        ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
        kind: journalOperation.retirement.kind,
        operationIndex: index,
        root: options.root,
        store: options.store,
        stored: options.stored
      });
      journalOperation = options.stored.envelope.payload.operations[index]!;
    }
    if (journalOperation.state === "capture-authorized") {
      await cleanupAuthorizedCapture({
        journal: options.stored.envelope.payload,
        operationIndex: index,
        root: options.root
      });
      continue;
    }
    if (![
      "capture-ready", "preimage-captured", "destination-retired",
      "publishing", "published", "rollback-restored"
    ].includes(journalOperation.state)) {continue;}
    await restorePreimage({
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
      operation: options.stored.envelope.payload.plan.operations[index]!,
      operationIndex: index,
      root: options.root,
      store: options.store,
      stored: options.stored
    });
    await cleanupOperationTemporaries({
      operationIndex: index,
      root: options.root,
      store: options.store,
      stored: options.stored
    });
  }
  for (let index = options.stored.envelope.payload.operations.length - 1; index >= 0; index -= 1) {
    const journal = options.stored.envelope.payload;
    if (![
      "capture-ready", "preimage-captured", "destination-retired",
      "publishing", "published", "rollback-restored"
    ].includes(journal.operations[index]!.state)) {
      await cleanupOperationTemporaries({
        operationIndex: index,
        root: options.root,
        store: options.store,
        stored: options.stored
      });
    }
  }
  const journal = options.stored.envelope.payload;
  await removeCreatedDirectories(options.root, journal.createdDirectories);
  await removeAuthorizedDirectories(options.root, journal.authorizedDirectories);
}
