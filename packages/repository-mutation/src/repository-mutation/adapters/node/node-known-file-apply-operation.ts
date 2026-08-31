import { join } from "node:path";

import { serializeKnownFileIdentity } from "../../application/model/known-file-transaction-journal.js";
import { syncDirectoryStrictly } from "./node-directory-durability.js";
import {
  captureKnownFilePreimage,
  ensureKnownFileParentDirectories,
  prepareKnownFileCapture,
  prepareKnownFileRollback,
  prepareKnownFileTemporary,
  publishKnownFileLink,
  retireKnownFileDestination,
  unlinkKnownFileTemporary,
  verifyKnownFileTemporary,
  type KnownFileCapture,
  type PreparedKnownFileTemporary
} from "./node-known-file-apply-effects.js";
import type { KnownFileTransactionFaultInjector } from "./node-known-file-apply-faults.js";
import {
  persistKnownFileApplyState,
  transitionKnownFileOperation,
  type KnownFileApplyState
} from "./node-known-file-apply-state.js";
import {
  KnownFileTransactionError,
  matchesKnownFileImage,
  observeKnownFile,
  sameKnownFileIdentity
} from "./node-known-file-transaction-filesystem.js";
import type { NodeKnownFileTransactionJournalStore } from "./node-known-file-transaction-journal-store.js";

interface OperationContext {
  readonly destination: string;
  readonly faultInjector?: KnownFileTransactionFaultInjector;
  readonly index: number;
  readonly parent: string;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: KnownFileApplyState;
  readonly temporary: PreparedKnownFileTemporary;
}

async function transitionAndCheckpoint(
  context: OperationContext,
  transition: Parameters<typeof transitionKnownFileOperation>[2],
  phase: Parameters<NonNullable<KnownFileTransactionFaultInjector>>[0]["phase"]
): Promise<void> {
  const operation = context.stored.envelope.journal.plan.operations[context.index]!;
  const journal = transitionKnownFileOperation(
    context.stored.envelope.journal,
    context.index,
    transition
  );
  await persistKnownFileApplyState(context.store, context.stored, journal);
  await context.faultInjector?.({
    phase,
    operationIndex: context.index,
    path: operation.path
  });
}

async function publishPreparedLink(
  context: OperationContext,
  replacement: boolean
): Promise<void> {
  const operation = context.stored.envelope.journal.plan.operations[context.index]!;
  await transitionAndCheckpoint(context, { state: "publishing" }, "after-operation-publishing");
  await publishKnownFileLink({
    destination: context.destination,
    operationPath: operation.path,
    temporaryPath: context.temporary.path,
    replacement
  });
  await context.faultInjector?.({
    phase: "after-postimage-linked",
    operationIndex: context.index,
    path: operation.path
  });
  await unlinkKnownFileTemporary(context.temporary.path);
}

async function prepareCapture(
  context: OperationContext
): Promise<KnownFileCapture> {
  const operation = context.stored.envelope.journal.plan.operations[context.index]!;
  await transitionAndCheckpoint(context, { state: "capture-authorized" }, "after-capture-authorized");
  const capture = await prepareKnownFileCapture({
    operation,
    operationIndex: context.index,
    parent: context.parent,
    planDigest: context.stored.envelope.journal.plan.planDigest
  });
  await context.faultInjector?.({
    phase: "after-capture-created-unbound",
    operationIndex: context.index,
    path: operation.path
  });
  await transitionAndCheckpoint(context, {
    captureDirectoryIdentity: serializeKnownFileIdentity(capture.identity),
    state: "capture-ready"
  }, "after-capture-ready");
  return capture;
}

async function executeKnownFileReplacement(context: OperationContext): Promise<void> {
  const operation = context.stored.envelope.journal.plan.operations[context.index]!;
  if (operation.precondition.state !== "known-file") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_JOURNAL_INVALID",
      `Replacement operation has no known preimage: ${operation.path}.`
    );
  }
  const capture = await prepareCapture(context);
  const captured = await captureKnownFilePreimage({
    capture,
    operation: { ...operation, precondition: operation.precondition },
    root: context.root
  });
  await context.faultInjector?.({
    phase: "after-preimage-linked-unbound",
    operationIndex: context.index,
    path: operation.path
  });
  await transitionAndCheckpoint(context, {
    capturedPreimageIdentity: serializeKnownFileIdentity(captured.identity),
    matchedPreimage: captured.matchedPreimage,
    state: "preimage-captured"
  }, "after-preimage-captured");
  await prepareKnownFileRollback({
    ...(context.faultInjector === undefined ? {} : { faultInjector: context.faultInjector }),
    index: context.index,
    operation: { ...operation, precondition: operation.precondition },
    parent: context.parent,
    preimageIndex: captured.matchedPreimage,
    store: context.store,
    stored: context.stored
  });
  await retireKnownFileDestination({
    capture,
    capturedIdentity: captured.identity,
    destination: context.destination,
    ...(context.faultInjector === undefined ? {} : { faultInjector: context.faultInjector }),
    index: context.index,
    operationPath: operation.path,
    parent: context.parent,
    preimage: operation.precondition.acceptedPreimages[captured.matchedPreimage]!
  });
  await transitionAndCheckpoint(context, { state: "destination-retired" }, "after-destination-retired");
  await publishPreparedLink(context, true);
}

async function verifyPublishedPostimage(context: OperationContext): Promise<void> {
  const operation = context.stored.envelope.journal.plan.operations[context.index]!;
  await syncDirectoryStrictly(context.parent);
  const published = await observeKnownFile(context.root, operation.path, operation.postimage.size);
  if (!matchesKnownFileImage(published, operation.postimage) || published.identity === undefined ||
    !sameKnownFileIdentity(published.identity, context.temporary.identity)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_POSTIMAGE_INVALID",
      `Published postimage failed exact verification: ${operation.path}.`
    );
  }
  await transitionAndCheckpoint(context, { state: "published" }, "after-operation-published");
}

export async function executeKnownFileOperation(options: {
  readonly faultInjector?: KnownFileTransactionFaultInjector;
  readonly index: number;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: KnownFileApplyState;
}): Promise<void> {
  const operation = options.stored.envelope.journal.plan.operations[options.index]!;
  const journalOperation = options.stored.envelope.journal.operations[options.index]!;
  if (journalOperation.state === "already-satisfied" || journalOperation.state === "published") {
    return;
  }
  if (journalOperation.state !== "pending") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_REQUIRED",
      `Operation ${operation.path} is already in progress and requires recovery.`
    );
  }
  const parent = await ensureKnownFileParentDirectories({
    ...options,
    operationPath: operation.path
  });
  const temporaryContext = {
    destination: join(options.root, ...operation.path.split("/")),
    ...options,
    parent
  };
  const authorized = transitionKnownFileOperation(
    options.stored.envelope.journal,
    options.index,
    { state: "temporary-authorized" }
  );
  await persistKnownFileApplyState(options.store, options.stored, authorized);
  await options.faultInjector?.({
    phase: "after-temporary-authorized",
    operationIndex: options.index,
    path: operation.path
  });
  const temporary = await prepareKnownFileTemporary({
    operation,
    operationIndex: options.index,
    parent,
    planDigest: options.stored.envelope.journal.plan.planDigest
  });
  await options.faultInjector?.({
    phase: "after-temporary-created-unbound",
    operationIndex: options.index,
    path: operation.path
  });
  const ready = transitionKnownFileOperation(
    options.stored.envelope.journal,
    options.index,
    { state: "temporary-ready", temporaryIdentity: serializeKnownFileIdentity(temporary.identity) }
  );
  await persistKnownFileApplyState(options.store, options.stored, ready);
  await options.faultInjector?.({
    phase: "after-temporary-synced",
    operationIndex: options.index,
    path: operation.path
  });
  await verifyKnownFileTemporary(temporary, operation.postimage);
  const context: OperationContext = { ...temporaryContext, temporary };
  if (operation.precondition.state === "absent") {
    await publishPreparedLink(context, false);
  } else {
    await executeKnownFileReplacement(context);
  }
  await verifyPublishedPostimage(context);
}
