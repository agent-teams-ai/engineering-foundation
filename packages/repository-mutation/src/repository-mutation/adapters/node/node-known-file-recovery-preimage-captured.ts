import { link, lstat, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { KnownFileImageV1, KnownFileTransactionPlanV1 } from "../../application/model/known-file-transaction.js";
import type { KnownFileTransactionJournalV1 } from "../../application/model/known-file-transaction-journal.js";
import { deserializeKnownFileIdentity } from "../../application/model/known-file-transaction-journal.js";
import { readBoundedRegularFile } from "./node-bounded-regular-file.js";
import { syncDirectoryStrictly } from "./node-directory-durability.js";
import {
  knownFileErrorCode,
  KnownFileTransactionError,
  matchesKnownFileImage,
  maximumKnownFileEvidenceBytes,
  sameKnownFileIdentity
} from "./node-known-file-transaction-filesystem.js";
import { knownFileCapturePaths, observeRecoveryFile } from "./node-known-file-recovery-filesystem.js";
import { cleanupRestoredCapturedPreimage } from "./node-known-file-recovery-preimage-captured-cleanup.js";
import { retireJournalBoundPath } from "./node-known-file-recovery-retirement.js";
import {
  type KnownFileRecoveryFaultInjector,
  persistRecoveryJournal,
  replaceRecoveryOperation,
  type StoredRecoveryJournal
} from "./node-known-file-recovery-state.js";
import type { NodeKnownFileTransactionJournalStore } from "./node-known-file-transaction-journal-store.js";

type RecoveryObservation = Awaited<ReturnType<typeof observeRecoveryFile>>;
type RecoveryPaths = ReturnType<typeof knownFileCapturePaths>;
type RecoveryIdentity = ReturnType<typeof deserializeKnownFileIdentity>;

interface CapturedPreimageOptions {
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
  readonly journalOperation: KnownFileTransactionJournalV1["operations"][number] & {
    readonly captureDirectoryIdentity: NonNullable<Extract<
      KnownFileTransactionJournalV1["operations"][number],
      { readonly temporaryIdentity: unknown }
    >["captureDirectoryIdentity"]>;
    readonly temporaryIdentity: NonNullable<Extract<
      KnownFileTransactionJournalV1["operations"][number],
      { readonly temporaryIdentity: unknown }
    >["temporaryIdentity"]>;
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
  readonly planDigest: string;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}

interface CapturedRecoveryContext {
  readonly destination: string;
  readonly parent: string;
  readonly paths: RecoveryPaths;
  readonly preimage: KnownFileImageV1;
  readonly recoveryMaximumBytes: number;
}

async function assertCaptureDirectory(
  options: CapturedPreimageOptions,
  paths: RecoveryPaths
): Promise<void> {
  const expectedDirectory = deserializeKnownFileIdentity(
    options.journalOperation.captureDirectoryIdentity
  );
  const directory = await lstat(paths.directory, { bigint: true }).catch((error: unknown) => {
    if (knownFileErrorCode(error) === "ENOENT") {return null;}
    throw error;
  });
  if (directory === null || !directory.isDirectory() || directory.isSymbolicLink() ||
    directory.birthtimeNs !== expectedDirectory.birthtimeNs ||
    directory.dev !== expectedDirectory.dev || directory.ino !== expectedDirectory.ino) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Replacement capture directory changed: ${options.operation.path}.`
    );
  }
}

async function restoreUnboundCapturedPreimage(
  options: CapturedPreimageOptions,
  context: CapturedRecoveryContext,
  captured: RecoveryObservation,
  retired: RecoveryObservation
): Promise<void> {
  if (retired.state !== "absent" || captured.state !== "absent") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Replacement capture contains bytes without durable identity authority: ${options.operation.path}.`
    );
  }
  const stableDestination = await readBoundedRegularFile(
    context.destination,
    context.preimage.size
  );
  if (stableDestination.outcome !== "read" || stableDestination.linkCount !== 1n ||
    !matchesKnownFileImage({
      state: "file",
      bytes: stableDestination.bytes,
      identity: stableDestination.identity,
      mode: stableDestination.mode & 0o777
    }, context.preimage)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Uncaptured replacement preimage is not an exclusive exact file: ${options.operation.path}.`
    );
  }
  const restoredOperation = Object.freeze({
    ...options.journalOperation,
    state: "rollback-restored" as const
  });
  await persistRecoveryJournal(
    options.store,
    options.stored,
    replaceRecoveryOperation(
      options.stored.envelope.payload,
      options.operationIndex,
      restoredOperation
    )
  );
  await rmdir(context.paths.directory);
  await syncDirectoryStrictly(context.parent);
}

function capturedRollbackAuthority(
  options: CapturedPreimageOptions,
  context: CapturedRecoveryContext,
  captured: RecoveryObservation,
  rollbackObserved: RecoveryObservation,
  rollbackIdentity: RecoveryIdentity | undefined
): {
  readonly captureBytesStable: boolean;
  readonly capturedIdentity: RecoveryIdentity;
  readonly rollbackSource: string;
  readonly rollbackSourceIdentity: RecoveryIdentity;
} {
  const capturedIdentity = deserializeKnownFileIdentity(
    options.journalOperation.capturedPreimageIdentity!
  );
  if (captured.state !== "file" || captured.identity === undefined ||
    !sameKnownFileIdentity(captured.identity, capturedIdentity)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Captured replacement identity changed: ${options.operation.path}.`
    );
  }
  const captureBytesStable = matchesKnownFileImage(captured, context.preimage);
  if (rollbackIdentity !== undefined &&
    (rollbackObserved.state !== "file" || rollbackObserved.identity === undefined ||
      !sameKnownFileIdentity(rollbackObserved.identity, rollbackIdentity) ||
      !matchesKnownFileImage(rollbackObserved, context.preimage))) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Rollback preimage copy changed: ${options.operation.path}.`
    );
  }
  if (rollbackIdentity === undefined && !captureBytesStable) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Captured preimage changed before a stable rollback copy existed: ${options.operation.path}.`
    );
  }
  return {
    captureBytesStable,
    capturedIdentity,
    rollbackSource: rollbackIdentity === undefined ? context.paths.captured : join(
      context.parent,
      `.${basename(options.operation.path)}.agent-teams.rollback.${options.operationIndex}.tmp`
    ),
    rollbackSourceIdentity: rollbackIdentity ?? capturedIdentity
  };
}

async function reconcileInterruptedRetiredCapture(
  options: CapturedPreimageOptions,
  context: CapturedRecoveryContext,
  retired: RecoveryObservation,
  destinationBefore: RecoveryObservation,
  capturedIdentity: RecoveryIdentity
): Promise<void> {
  if (retired.state !== "file") {return;}
  if (retired.identity !== undefined && sameKnownFileIdentity(retired.identity, capturedIdentity)) {
    await unlink(context.paths.retired);
    await syncDirectoryStrictly(context.paths.directory);
  } else {
    if (destinationBefore.state === "absent") {
      await link(context.paths.retired, context.destination);
      await syncDirectoryStrictly(context.parent);
      await unlink(context.paths.retired);
      await syncDirectoryStrictly(context.paths.directory);
    }
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Foreign destination was preserved from an interrupted capture: ${options.operation.path}.`
    );
  }
}

async function acceptForeignExactPreimage(
  options: CapturedPreimageOptions,
  context: CapturedRecoveryContext,
  observed: RecoveryObservation,
  recovery: {
    readonly captureBytesStable: boolean;
    readonly rollbackIdentity: RecoveryIdentity | undefined;
    readonly rollbackSourceIdentity: RecoveryIdentity;
  }
): Promise<boolean> {
  if (!matchesKnownFileImage(observed, context.preimage) ||
    (observed.identity !== undefined &&
      sameKnownFileIdentity(observed.identity, recovery.rollbackSourceIdentity))) {
    return false;
  }
  const restoredJournalOperation = Object.freeze({
    ...options.journalOperation,
    state: "rollback-restored" as const
  });
  await persistRecoveryJournal(options.store, options.stored, Object.freeze({
    ...options.stored.envelope.payload,
    operations: Object.freeze(options.stored.envelope.payload.operations.with(
      options.operationIndex,
      restoredJournalOperation
    ))
  }));
  if (recovery.rollbackIdentity !== undefined) {
    await unlink(join(
      context.parent,
      `.${basename(options.operation.path)}.agent-teams.rollback.${options.operationIndex}.tmp`
    ));
  }
  if (recovery.captureBytesStable) {await unlink(context.paths.captured);}
  await syncDirectoryStrictly(context.paths.directory);
  if (recovery.captureBytesStable) {
    await options.faultInjector?.({
      phase: "after-rollback-capture-unlinked",
      operationIndex: options.operationIndex,
      path: options.operation.path
    });
  }
  if (recovery.captureBytesStable) {await rmdir(context.paths.directory);}
  await syncDirectoryStrictly(context.parent);
  if (!recovery.captureBytesStable) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Edited retired inode was preserved after exact rollback: ${options.operation.path}.`
    );
  }
  return true;
}

async function retireCapturedPostimage(
  options: CapturedPreimageOptions,
  observed: RecoveryObservation
): Promise<RecoveryObservation> {
  if (observed.state !== "file") {return observed;}
  const temporaryIdentity = deserializeKnownFileIdentity(options.journalOperation.temporaryIdentity);
  if (!matchesKnownFileImage(observed, options.operation.postimage) ||
    observed.identity === undefined ||
    !sameKnownFileIdentity(observed.identity, temporaryIdentity)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Destination changed before captured-preimage rollback: ${options.operation.path}.`
    );
  }
  await retireJournalBoundPath({
    expectedIdentity: temporaryIdentity,
    ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
    kind: "destination",
    operationIndex: options.operationIndex,
    root: options.root,
    store: options.store,
    stored: options.stored
  });
  await options.faultInjector?.({
    phase: "after-destination-retired",
    operationIndex: options.operationIndex,
    path: options.operation.path
  });
  return { state: "absent" };
}

async function completeCapturedRollback(
  options: CapturedPreimageOptions,
  context: CapturedRecoveryContext,
  observed: RecoveryObservation,
  recovery: {
    readonly captureBytesStable: boolean;
    readonly rollbackIdentity: RecoveryIdentity | undefined;
    readonly rollbackSource: string;
    readonly rollbackSourceIdentity: RecoveryIdentity;
  }
): Promise<void> {
  if (observed.state === "absent") {
    await link(recovery.rollbackSource, context.destination).catch((error: unknown) => {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Destination appeared during captured-preimage rollback: ${options.operation.path}.`,
        { cause: error }
      );
    });
    await options.faultInjector?.({
      phase: "after-rollback-linked",
      operationIndex: options.operationIndex,
      path: options.operation.path
    });
    await syncDirectoryStrictly(context.parent);
  }
  const restored = await observeRecoveryFile(context.destination, context.preimage.size);
  if (!matchesKnownFileImage(restored, context.preimage) || restored.identity === undefined ||
    !sameKnownFileIdentity(restored.identity, recovery.rollbackSourceIdentity)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_FAILED",
      `Captured preimage restoration failed: ${options.operation.path}.`
    );
  }
  await persistRecoveryJournal(options.store, options.stored, Object.freeze({
    ...options.stored.envelope.payload,
    operations: Object.freeze(options.stored.envelope.payload.operations.with(
      options.operationIndex,
      Object.freeze({ ...options.journalOperation, state: "rollback-restored" as const })
    ))
  }));
  if (recovery.rollbackIdentity !== undefined) {await unlink(recovery.rollbackSource);}
  if (recovery.captureBytesStable) {await unlink(context.paths.captured);}
  await syncDirectoryStrictly(context.paths.directory);
  if (recovery.captureBytesStable) {
    await options.faultInjector?.({
      phase: "after-rollback-capture-unlinked",
      operationIndex: options.operationIndex,
      path: options.operation.path
    });
  }
  if (recovery.captureBytesStable) {await rmdir(context.paths.directory);}
  await syncDirectoryStrictly(context.parent);
  if (!recovery.captureBytesStable) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Edited retired inode was preserved after exact rollback: ${options.operation.path}.`
    );
  }
}

export async function restoreCapturedPreimage(options: CapturedPreimageOptions): Promise<void> {
  const destination = join(options.root, ...options.operation.path.split("/"));
  const parent = dirname(destination);
  const paths = knownFileCapturePaths({
    operationIndex: options.operationIndex,
    operationPath: options.operation.path,
    parent,
    planDigest: options.planDigest
  });
  const recoveryMaximumBytes = Math.max(
    maximumKnownFileEvidenceBytes(options.operation),
    8 * 1024 * 1024
  );
  if (options.journalOperation.state === "rollback-restored") {
    await cleanupRestoredCapturedPreimage({
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
      destination,
      journalOperation: options.journalOperation,
      operation: options.operation,
      operationIndex: options.operationIndex,
      parent,
      paths,
      recoveryMaximumBytes
    });
    return;
  }
  await assertCaptureDirectory(options, paths);
  const captured = await observeRecoveryFile(paths.captured, recoveryMaximumBytes);
  const destinationBefore = await observeRecoveryFile(destination, recoveryMaximumBytes);
  const retired = await observeRecoveryFile(paths.retired, recoveryMaximumBytes);
  const matched = options.journalOperation.matchedPreimage;
  if (matched === undefined) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_JOURNAL_INVALID",
      `Captured replacement lacks its exact preimage binding: ${options.operation.path}.`
    );
  }
  const context = {
    destination,
    parent,
    paths,
    preimage: options.operation.precondition.acceptedPreimages[matched]!,
    recoveryMaximumBytes
  };
  if (options.journalOperation.capturedPreimageIdentity === undefined) {
    await restoreUnboundCapturedPreimage(options, context, captured, retired);
    return;
  }
  const rollbackPath = join(
    parent,
    `.${basename(options.operation.path)}.agent-teams.rollback.${options.operationIndex}.tmp`
  );
  const rollbackIdentity = options.journalOperation.rollbackTemporaryIdentity === undefined
    ? undefined
    : deserializeKnownFileIdentity(options.journalOperation.rollbackTemporaryIdentity);
  const rollbackObserved = rollbackIdentity === undefined
    ? { state: "absent" as const }
    : await observeRecoveryFile(rollbackPath, context.preimage.size);
  const authority = capturedRollbackAuthority(
    options, context, captured, rollbackObserved, rollbackIdentity
  );
  await reconcileInterruptedRetiredCapture(
    options, context, retired, destinationBefore, authority.capturedIdentity
  );
  let observed = await observeRecoveryFile(destination, recoveryMaximumBytes);
  if (await acceptForeignExactPreimage(
    options,
    context,
    observed,
    { ...authority, rollbackIdentity }
  )) {return;}
  if (!matchesKnownFileImage(observed, context.preimage)) {
    observed = await retireCapturedPostimage(options, observed);
  }
  await completeCapturedRollback(
    options,
    context,
    observed,
    { ...authority, rollbackIdentity }
  );
}
