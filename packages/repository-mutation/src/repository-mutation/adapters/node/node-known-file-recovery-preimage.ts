import type { KnownFileCoordination } from "./known-file-coordination.js";
import { link } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  KnownFileImageV1,
  KnownFileTransactionPlanV1
} from "../../application/model/known-file-transaction.js";
import { type KnownFileTransactionJournalV1, deserializeKnownFileIdentity, serializeKnownFileIdentity } from "../../application/model/known-file-transaction-journal.js";


import { syncDirectoryStrictly } from "./node-directory-durability.js";
import { matchesKnownFileImage, maximumKnownFileEvidenceBytes, sameKnownFileIdentity } from "./node-known-file-transaction-filesystem.js";
import { KnownFileTransactionError } from "../../application/model/known-file-transaction-error.js";
import {
  observeRecoveryFile,
  prepareRollbackTemporary
} from "./node-known-file-recovery-filesystem.js";
import { restoreCapturedPreimage } from "./node-known-file-recovery-preimage-captured.js";
import { retireJournalBoundPath } from "./node-known-file-recovery-retirement.js";
import {
  type KnownFileRecoveryFaultInjector,
  persistRecoveryJournal,
  type StoredRecoveryJournal
} from "./node-known-file-recovery-state.js";
import type { NodeKnownFileTransactionJournalStore } from "./node-known-file-transaction-journal-store.js";

type RecoveryJournalOperation = KnownFileTransactionJournalV1["operations"][number];

async function restoreAbsentPreimage(coordination: Pick<KnownFileCoordination, "pathMatchesRegularFileIdentity">, options: {
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
  readonly journalOperation: KnownFileTransactionJournalV1["operations"][number];
  readonly observed: Awaited<ReturnType<typeof observeRecoveryFile>>;
  readonly operation: KnownFileTransactionPlanV1["operations"][number];
  readonly operationIndex: number;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}): Promise<void> {
  if (options.observed.state === "absent") {return;}
  if (!matchesKnownFileImage(options.observed, options.operation.postimage) ||
    options.observed.identity === undefined ||
    !("temporaryIdentity" in options.journalOperation) ||
    !sameKnownFileIdentity(
      options.observed.identity,
      deserializeKnownFileIdentity(options.journalOperation.temporaryIdentity)
    )) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Created destination changed after publication: ${options.operation.path}.`
    );
  }
  await retireJournalBoundPath(coordination, {
    expectedIdentity: options.observed.identity,
    ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
    kind: "destination",
    operationIndex: options.operationIndex,
    root: options.root,
    store: options.store,
    stored: options.stored
  });
}

async function acceptRestoredPreimage(coordination: Pick<KnownFileCoordination, "pathMatchesRegularFileIdentity">, options: {
  readonly journalOperation: KnownFileTransactionJournalV1["operations"][number];
  readonly observed: Awaited<ReturnType<typeof observeRecoveryFile>>;
  readonly operationIndex: number;
  readonly operationPath: string;
  readonly preimage: KnownFileImageV1;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}): Promise<boolean> {
  if (!matchesKnownFileImage(options.observed, options.preimage)) {return false;}
  if (options.journalOperation.rollbackTemporaryIdentity !== undefined &&
    options.observed.identity !== undefined &&
    sameKnownFileIdentity(
      options.observed.identity,
      deserializeKnownFileIdentity(options.journalOperation.rollbackTemporaryIdentity)
    )) {
    await retireJournalBoundPath(coordination, {
      expectedIdentity: options.observed.identity,
      kind: "rollback-temporary",
      operationIndex: options.operationIndex,
      root: options.root,
      store: options.store,
      stored: options.stored
    });
  }
  return true;
}

function assertPublishedIdentity(options: {
  readonly journalOperation: Extract<
    KnownFileTransactionJournalV1["operations"][number],
    { readonly temporaryIdentity: unknown }
  >;
  readonly observed: Awaited<ReturnType<typeof observeRecoveryFile>>;
  readonly operationPath: string;
}): void {
  if (options.observed.identity === undefined ||
    !sameKnownFileIdentity(
      options.observed.identity,
      deserializeKnownFileIdentity(options.journalOperation.temporaryIdentity)
    )) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Published destination identity changed before rollback: ${options.operationPath}.`
    );
  }
}

function assertRollbackTemporary(options: {
  readonly identity: ReturnType<typeof deserializeKnownFileIdentity>;
  readonly observed: Awaited<ReturnType<KnownFileCoordination["readBoundedRegularFile"]>>;
  readonly operationPath: string;
  readonly preimage: KnownFileImageV1;
}): void {
  if (options.observed.outcome !== "read" ||
    !sameKnownFileIdentity(options.observed.identity, options.identity) ||
    !matchesKnownFileImage({
      state: "file", bytes: options.observed.bytes, identity: options.observed.identity,
      mode: options.observed.mode & 0o777
    }, options.preimage)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Rollback temporary changed before copy: ${options.operationPath}.`
    );
  }
}

export interface RestorePreimageOptions {
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
  readonly operation: KnownFileTransactionPlanV1["operations"][number];
  readonly operationIndex: number;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}

async function restoreUncapturedPreimage(coordination: Pick<KnownFileCoordination,
  "captureFileHandleIdentity"
  | "pathMatchesRegularFileIdentity"
  | "readBoundedRegularFile"
  | "readBoundedRegularFileHandle"
>, options: RestorePreimageOptions & {
  readonly destination: string;
  readonly journalOperation: RecoveryJournalOperation;
  readonly parent: string;
  readonly operation: KnownFileTransactionPlanV1["operations"][number] & {
    readonly precondition: Extract<
      KnownFileTransactionPlanV1["operations"][number]["precondition"],
      { readonly state: "known-file" }
    >;
  };
}): Promise<void> {
  const operation = options.operation;
  let journalOperation = options.journalOperation;
  const observed = await observeRecoveryFile(coordination,
    options.destination,
    maximumKnownFileEvidenceBytes(operation)
  );
  const postMatches = matchesKnownFileImage(observed, operation.postimage);
  if (!("temporaryIdentity" in journalOperation)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_JOURNAL_INVALID",
      `Published operation lacks temporary identity authority: ${operation.path}.`
    );
  }
  const matched = journalOperation.matchedPreimage;
  if (matched === undefined) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_JOURNAL_INVALID",
      `Replacement preimage binding is absent: ${operation.path}.`
    );
  }
  const preimage = operation.precondition.acceptedPreimages[matched]!;
  if (await acceptRestoredPreimage(coordination, {
    journalOperation,
    observed,
    operationIndex: options.operationIndex,
    operationPath: operation.path,
    preimage,
    root: options.root,
    store: options.store,
    stored: options.stored
  })) {return;}
  const resumingAfterRetirement = observed.state === "absent" &&
    journalOperation.rollbackTemporaryIdentity !== undefined;
  if (!postMatches && !resumingAfterRetirement) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Published destination changed before rollback: ${operation.path}.`
    );
  }
  if (postMatches) {
    assertPublishedIdentity({ journalOperation, observed, operationPath: operation.path });
  }
  const rollbackPath = join(
    options.parent,
    `.${basename(operation.path)}.agent-teams.rollback.${options.operationIndex}.tmp`
  );
  const rollbackIdentity = await prepareRollbackTemporary(coordination, {
    ...(journalOperation.rollbackTemporaryIdentity === undefined
      ? {}
      : {
          expectedIdentity: deserializeKnownFileIdentity(
            journalOperation.rollbackTemporaryIdentity
          )
        }),
    operationPath: operation.path,
    path: rollbackPath,
    preimage
  });
  await syncDirectoryStrictly(options.parent);
  if (await coordination.pathMatchesRegularFileIdentity(rollbackPath, rollbackIdentity) !== "match") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Rollback temporary changed before durable identity binding: ${operation.path}.`
    );
  }
  if (journalOperation.rollbackTemporaryIdentity === undefined) {
    journalOperation = Object.freeze({
      ...journalOperation,
      rollbackTemporaryIdentity: serializeKnownFileIdentity(rollbackIdentity)
    });
    await persistRecoveryJournal(options.store, options.stored, Object.freeze({
      ...options.stored.envelope.payload,
      operations: Object.freeze(options.stored.envelope.payload.operations.with(
        options.operationIndex,
        journalOperation
      ))
    }));
  }
  if (!resumingAfterRetirement) {
    await retireJournalBoundPath(coordination, {
      expectedIdentity: observed.identity!,
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
      path: operation.path
    });
  }
  const prepared = await coordination.readBoundedRegularFile(rollbackPath, preimage.size);
  assertRollbackTemporary({
    identity: rollbackIdentity,
    observed: prepared,
    operationPath: operation.path,
    preimage
  });
  await link(rollbackPath, options.destination).catch((error: unknown) => {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Destination appeared during rollback CAS: ${operation.path}.`,
      { cause: error }
    );
  });
  await options.faultInjector?.({
    phase: "after-rollback-linked",
    operationIndex: options.operationIndex,
    path: operation.path
  });
  await syncDirectoryStrictly(options.parent);
  const restored = await observeRecoveryFile(coordination, options.destination, preimage.size);
  if (!matchesKnownFileImage(restored, preimage) || restored.identity === undefined ||
    !sameKnownFileIdentity(restored.identity, rollbackIdentity)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_FAILED",
      `Preimage restoration failed: ${operation.path}.`
    );
  }
  await retireJournalBoundPath(coordination, {
    expectedIdentity: rollbackIdentity,
    ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
    kind: "rollback-temporary",
    operationIndex: options.operationIndex,
    root: options.root,
    store: options.store,
    stored: options.stored
  });
}

export async function restorePreimage(coordination: Pick<KnownFileCoordination,
  "captureFileHandleIdentity"
  | "pathMatchesRegularFileIdentity"
  | "readBoundedRegularFile"
  | "readBoundedRegularFileHandle"
>, options: RestorePreimageOptions): Promise<void> {
  const operation = options.operation;
  const journalOperation = options.stored.envelope.payload.operations[options.operationIndex]!;
  const destination = join(options.root, ...operation.path.split("/"));
  const parent = dirname(destination);
  if (operation.precondition.state === "absent") {
    const observed = await observeRecoveryFile(coordination,
      destination,
      maximumKnownFileEvidenceBytes(operation)
    );
    await restoreAbsentPreimage(coordination, {
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
      journalOperation,
      observed,
      operation,
      operationIndex: options.operationIndex,
      root: options.root,
      store: options.store,
      stored: options.stored
    });
    return;
  }
  if (journalOperation.captureDirectoryIdentity !== undefined) {
    await restoreCapturedPreimage(coordination, {
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
      journalOperation: journalOperation as Extract<
        KnownFileTransactionJournalV1["operations"][number],
        { readonly temporaryIdentity: unknown }
      > & { readonly captureDirectoryIdentity: NonNullable<typeof journalOperation.captureDirectoryIdentity> },
      operation: { ...operation, precondition: operation.precondition },
      operationIndex: options.operationIndex,
      planDigest: options.stored.envelope.payload.plan.planDigest,
      root: options.root,
      store: options.store,
      stored: options.stored
    });
    return;
  }
  await restoreUncapturedPreimage(coordination, {
    ...options,
    destination,
    journalOperation,
    operation: { ...operation, precondition: operation.precondition },
    parent
  });
}
