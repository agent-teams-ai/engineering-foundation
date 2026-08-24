import {
  link,
  lstat,
  mkdir,
  readdir,
  rename,
  rmdir,
  unlink
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
  KnownFileTransactionEnvelopeV1,
  KnownFileTransactionJournalV1
} from "../../application/model/known-file-transaction-journal.js";
import {
  deserializeKnownFileIdentity,
  serializeKnownFileIdentity
} from "../../application/model/known-file-transaction-journal.js";
import { classifyKnownFileRecoveryTransition } from "../../application/policies/classify-known-file-recovery-transition.js";
import { compileKnownFileTransactionEnvelope } from "../../application/policies/known-file-transaction-envelope.js";
import {
  pathMatchesRegularFileIdentity,
  readBoundedRegularFile
} from "./node-bounded-regular-file.js";
import { syncDirectoryStrictly } from "./node-directory-durability.js";
import {
  canonicalKnownFileRoot,
  knownFileErrorCode,
  knownFileTemporaryName,
  KnownFileTransactionError,
  matchesKnownFileImage,
  maximumKnownFileEvidenceBytes,
  observeKnownFile,
  sameKnownFileIdentity
} from "./node-known-file-transaction-filesystem.js";
import {
  cleanupCommittedKnownFileCaptures,
  knownFileCapturePaths,
  observeRecoveryFile,
  prepareRollbackTemporary
} from "./node-known-file-recovery-filesystem.js";
import {
  NodeKnownFileTransactionJournalStore,
  type KnownFileJournalAuthority
} from "./node-known-file-transaction-journal-store.js";
import {
  compileKnownFileTransactionReceipt,
  verifyCommittedKnownFilePostimages
} from "./node-known-file-transaction.js";
import { compileRolledBackReceipt } from "./node-known-file-transaction-receipt.js";

interface StoredRecoveryJournal {
  authority: KnownFileJournalAuthority;
  envelope: KnownFileTransactionEnvelopeV1;
}

export type KnownFileRecoveryFaultInjector = (point: {
  readonly phase:
    | "after-committed-capture-unlinked"
    | "after-destination-retired"
    | "after-rollback-linked"
    | "after-rollback-capture-unlinked"
    | "after-retirement-directory-bound"
    | "after-retirement-captured"
    | "after-retirement-unlink-authorized";
  readonly operationIndex: number;
  readonly path: string;
}) => Promise<void> | void;

async function persistRecoveryJournal(
  store: NodeKnownFileTransactionJournalStore,
  stored: StoredRecoveryJournal,
  journal: KnownFileTransactionJournalV1
): Promise<void> {
  const envelope = compileKnownFileTransactionEnvelope({
    foundation: stored.envelope.foundation,
    journal,
    state: stored.envelope.state
  });
  stored.authority = await store.replace(stored.authority, envelope);
  stored.envelope = envelope;
}

function replaceRecoveryOperation(
  journal: KnownFileTransactionJournalV1,
  index: number,
  operation: KnownFileTransactionJournalV1["operations"][number]
): KnownFileTransactionJournalV1 {
  return Object.freeze({
    ...journal,
    operations: Object.freeze(journal.operations.with(index, operation))
  });
}

function clearOperationRetirement(
  operation: KnownFileTransactionJournalV1["operations"][number]
): KnownFileTransactionJournalV1["operations"][number] {
  if (operation.retirement === undefined) {return operation;}
  const { retirement: _retirement, ...cleared } = operation;
  return Object.freeze(cleared);
}

function retirementPath(options: {
  readonly kind: "destination" | "rollback-temporary" | "temporary";
  readonly operation: KnownFileTransactionPlanV1["operations"][number];
  readonly operationIndex: number;
  readonly parent: string;
  readonly planDigest: string;
}): { readonly captured: string; readonly directory: string; readonly source: string } {
  const leaf = basename(options.operation.path);
  const directory = join(
    options.parent,
    `.${leaf}.agent-teams.retire.${options.planDigest.slice(7, 23)}.${options.operationIndex}.${options.kind}`
  );
  const source = options.kind === "destination"
    ? join(options.parent, leaf)
    : options.kind === "temporary"
      ? join(options.parent, knownFileTemporaryName(
        options.operation.path,
        options.planDigest,
        options.operationIndex
      ))
      : join(options.parent, `.${leaf}.agent-teams.rollback.${options.operationIndex}.tmp`);
  return { captured: join(directory, "captured"), directory, source };
}

// oxlint-disable-next-line complexity, max-lines-per-function
async function retireJournalBoundPath(options: {
  readonly expectedIdentity: ReturnType<typeof deserializeKnownFileIdentity>;
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
  readonly kind: "destination" | "rollback-temporary" | "temporary";
  readonly operationIndex: number;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}): Promise<void> {
  const operation = options.stored.envelope.journal.plan.operations[options.operationIndex]!;
  const parent = dirname(join(options.root, ...operation.path.split("/")));
  const paths = retirementPath({
    kind: options.kind,
    operation,
    operationIndex: options.operationIndex,
    parent,
    planDigest: options.stored.envelope.journal.plan.planDigest
  });
  const initialJournalOperation = options.stored.envelope.journal.operations[options.operationIndex]!;
  if (!("temporaryIdentity" in initialJournalOperation)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_JOURNAL_INVALID",
      `Retirement requires durable operation identity: ${operation.path}.`
    );
  }
  let journalOperation: Extract<
    KnownFileTransactionJournalV1["operations"][number],
    { readonly temporaryIdentity: unknown }
  > = initialJournalOperation;
  let retirement = journalOperation.retirement;
  if (retirement === undefined) {
    if (await pathMatchesRegularFileIdentity(paths.source, options.expectedIdentity) !== "match") {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Identity-bound recovery path changed before retirement: ${operation.path}.`
      );
    }
    const directory = await mkdir(paths.directory, { mode: 0o700 }).then(() =>
      lstat(paths.directory, { bigint: true })
    ).catch((error: unknown) => {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Retirement directory could not be exclusively created: ${operation.path}.`,
        { cause: error }
      );
    });
    await syncDirectoryStrictly(parent);
    const durableDirectory = await lstat(paths.directory, { bigint: true }).catch(
      (error: unknown) => {
        throw new KnownFileTransactionError(
          "KNOWN_FILE_RECOVERY_CONFLICT",
          `Retirement directory disappeared before durable identity binding: ${operation.path}.`,
          { cause: error }
        );
      }
    );
    if (!durableDirectory.isDirectory() || durableDirectory.isSymbolicLink() ||
      durableDirectory.birthtimeNs !== directory.birthtimeNs ||
      durableDirectory.dev !== directory.dev || durableDirectory.ino !== directory.ino) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Retirement directory changed before durable identity binding: ${operation.path}.`
      );
    }
    retirement = Object.freeze({
      kind: options.kind,
      state: "ready" as const,
      directoryIdentity: serializeKnownFileIdentity(directory),
      pathIdentity: serializeKnownFileIdentity(options.expectedIdentity)
    });
    journalOperation = Object.freeze({ ...journalOperation, retirement });
    await persistRecoveryJournal(
      options.store,
      options.stored,
      replaceRecoveryOperation(options.stored.envelope.journal, options.operationIndex, journalOperation)
    );
    await options.faultInjector?.({
      phase: "after-retirement-directory-bound",
      operationIndex: options.operationIndex,
      path: operation.path
    });
  }
  if (retirement.kind !== options.kind ||
    !sameKnownFileIdentity(deserializeKnownFileIdentity(retirement.pathIdentity), options.expectedIdentity)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Retirement authority does not match the requested path: ${operation.path}.`
    );
  }
  const expectedDirectory = deserializeKnownFileIdentity(retirement.directoryIdentity);
  const directory = await lstat(paths.directory, { bigint: true }).catch((error: unknown) => {
    if (knownFileErrorCode(error) === "ENOENT") {return null;}
    throw error;
  });
  if (directory === null) {
    if (retirement.state !== "unlink-authorized" ||
      await pathMatchesRegularFileIdentity(paths.source, options.expectedIdentity) === "match") {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Journal-bound retirement directory disappeared: ${operation.path}.`
      );
    }
    const cleared = clearOperationRetirement(journalOperation);
    await persistRecoveryJournal(
      options.store,
      options.stored,
      replaceRecoveryOperation(options.stored.envelope.journal, options.operationIndex, cleared)
    );
    return;
  }
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
    directory.birthtimeNs !== expectedDirectory.birthtimeNs ||
    directory.dev !== expectedDirectory.dev || directory.ino !== expectedDirectory.ino) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Journal-bound retirement directory changed: ${operation.path}.`
    );
  }
  const capturedMatch = await pathMatchesRegularFileIdentity(
    paths.captured,
    options.expectedIdentity
  );
  const sourceMatch = await pathMatchesRegularFileIdentity(paths.source, options.expectedIdentity);
  if (retirement.state === "ready") {
    if (capturedMatch === "missing" && sourceMatch === "match") {
      await rename(paths.source, paths.captured);
      await syncDirectoryStrictly(paths.directory);
      await syncDirectoryStrictly(parent);
    } else if (capturedMatch !== "match" || sourceMatch === "match") {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Journal-bound retirement capture is ambiguous: ${operation.path}.`
      );
    }
    retirement = Object.freeze({ ...retirement, state: "captured" as const });
    journalOperation = Object.freeze({ ...journalOperation, retirement });
    await persistRecoveryJournal(
      options.store,
      options.stored,
      replaceRecoveryOperation(options.stored.envelope.journal, options.operationIndex, journalOperation)
    );
    await options.faultInjector?.({
      phase: "after-retirement-captured",
      operationIndex: options.operationIndex,
      path: operation.path
    });
  }
  if (retirement.state === "captured") {
    if (await pathMatchesRegularFileIdentity(paths.captured, options.expectedIdentity) !== "match") {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Journal-bound retired bytes changed: ${operation.path}.`
      );
    }
    retirement = Object.freeze({ ...retirement, state: "unlink-authorized" as const });
    journalOperation = Object.freeze({ ...journalOperation, retirement });
    await persistRecoveryJournal(
      options.store,
      options.stored,
      replaceRecoveryOperation(options.stored.envelope.journal, options.operationIndex, journalOperation)
    );
    await options.faultInjector?.({
      phase: "after-retirement-unlink-authorized",
      operationIndex: options.operationIndex,
      path: operation.path
    });
  }
  const capturedAfterAuthorization = await pathMatchesRegularFileIdentity(
    paths.captured,
    options.expectedIdentity
  );
  if (capturedAfterAuthorization === "match") {
    await unlink(paths.captured);
    await syncDirectoryStrictly(paths.directory);
  } else if (capturedAfterAuthorization !== "missing") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Authorized retirement capture became foreign: ${operation.path}.`
    );
  }
  if ((await readdir(paths.directory)).length !== 0) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Retirement directory contains foreign evidence: ${operation.path}.`
    );
  }
  await rmdir(paths.directory);
  await syncDirectoryStrictly(parent);
  const cleared = clearOperationRetirement(journalOperation);
  await persistRecoveryJournal(
    options.store,
    options.stored,
    replaceRecoveryOperation(options.stored.envelope.journal, options.operationIndex, cleared)
  );
}

async function restoreAbsentPreimage(options: {
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
  await retireJournalBoundPath({
    expectedIdentity: options.observed.identity,
    ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
    kind: "destination",
    operationIndex: options.operationIndex,
    root: options.root,
    store: options.store,
    stored: options.stored
  });
}

async function acceptRestoredPreimage(options: {
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
    await retireJournalBoundPath({
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

// oxlint-disable-next-line complexity, max-lines-per-function
async function restorePreimage(options: {
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
  readonly operation: KnownFileTransactionPlanV1["operations"][number];
  readonly operationIndex: number;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}): Promise<void> {
  const operation = options.operation;
  let journalOperation = options.stored.envelope.journal.operations[options.operationIndex]!;
  const destination = join(options.root, ...operation.path.split("/"));
  const parent = dirname(destination);
  if (operation.precondition.state === "absent") {
    const observed = await observeRecoveryFile(
      destination,
      maximumKnownFileEvidenceBytes(operation)
    );
    await restoreAbsentPreimage({
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
    await restoreCapturedPreimage({
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
      journalOperation: journalOperation as Extract<
        KnownFileTransactionJournalV1["operations"][number],
        { readonly temporaryIdentity: unknown }
      > & { readonly captureDirectoryIdentity: NonNullable<typeof journalOperation.captureDirectoryIdentity> },
      operation: { ...operation, precondition: operation.precondition },
      operationIndex: options.operationIndex,
      planDigest: options.stored.envelope.journal.plan.planDigest,
      root: options.root,
      store: options.store,
      stored: options.stored
    });
    return;
  }
  const observed = await observeRecoveryFile(
    destination,
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
  if (await acceptRestoredPreimage({
    journalOperation,
    observed,
    operationIndex: options.operationIndex,
    operationPath: operation.path,
    preimage,
    root: options.root,
    store: options.store,
    stored: options.stored
  })) {
    return;
  }
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
    parent,
    `.${basename(operation.path)}.agent-teams.rollback.${options.operationIndex}.tmp`
  );
  const rollbackIdentity = await prepareRollbackTemporary({
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
  await syncDirectoryStrictly(parent);
  if (await pathMatchesRegularFileIdentity(rollbackPath, rollbackIdentity) !== "match") {
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
    const journal = Object.freeze({
      ...options.stored.envelope.journal,
      operations: Object.freeze(
        options.stored.envelope.journal.operations.with(
          options.operationIndex,
          journalOperation
        )
      )
    });
    await persistRecoveryJournal(options.store, options.stored, journal);
  }
  if (!resumingAfterRetirement) {
    await retireJournalBoundPath({
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
  const prepared = await readBoundedRegularFile(rollbackPath, preimage.size);
  if (prepared.outcome !== "read" ||
    !sameKnownFileIdentity(prepared.identity, rollbackIdentity) ||
    !matchesKnownFileImage({
      state: "file", bytes: prepared.bytes, identity: prepared.identity,
      mode: prepared.mode & 0o777
    }, preimage)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Rollback temporary changed before copy: ${operation.path}.`
    );
  }
  await link(rollbackPath, destination).catch((error: unknown) => {
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
  await syncDirectoryStrictly(parent);
  const restored = await observeRecoveryFile(destination, preimage.size);
  if (!matchesKnownFileImage(restored, preimage) || restored.identity === undefined ||
    !sameKnownFileIdentity(restored.identity, rollbackIdentity)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_FAILED",
      `Preimage restoration failed: ${operation.path}.`
    );
  }
  await retireJournalBoundPath({
    expectedIdentity: rollbackIdentity,
    ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
    kind: "rollback-temporary",
    operationIndex: options.operationIndex,
    root: options.root,
    store: options.store,
    stored: options.stored
  });
}

// oxlint-disable-next-line complexity, max-lines-per-function
async function restoreCapturedPreimage(options: {
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
    readonly precondition: Extract<KnownFileTransactionPlanV1["operations"][number]["precondition"], { readonly state: "known-file" }>;
  };
  readonly operationIndex: number;
  readonly planDigest: string;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}): Promise<void> {
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
    const matched = options.journalOperation.matchedPreimage;
    if (matched === undefined) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_JOURNAL_INVALID",
        `Restored replacement lacks exact preimage authority: ${options.operation.path}.`
      );
    }
    const preimage = options.operation.precondition.acceptedPreimages[matched]!;
    const destinationObserved = await observeRecoveryFile(destination, recoveryMaximumBytes);
    if (!matchesKnownFileImage(destinationObserved, preimage)) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Restored destination changed during cleanup: ${options.operation.path}.`
      );
    }
    const rollbackPath = join(
      parent,
      `.${basename(options.operation.path)}.agent-teams.rollback.${options.operationIndex}.tmp`
    );
    if (options.journalOperation.rollbackTemporaryIdentity !== undefined) {
      const rollbackObserved = await observeRecoveryFile(rollbackPath, preimage.size);
      if (rollbackObserved.state === "file") {
        const expectedRollback = deserializeKnownFileIdentity(
          options.journalOperation.rollbackTemporaryIdentity
        );
        if (rollbackObserved.identity === undefined ||
          !sameKnownFileIdentity(rollbackObserved.identity, expectedRollback) ||
          !matchesKnownFileImage(rollbackObserved, preimage)) {
          throw new KnownFileTransactionError(
            "KNOWN_FILE_RECOVERY_CONFLICT",
            `Rollback copy changed during cleanup: ${options.operation.path}.`
          );
        }
        await unlink(rollbackPath);
        await syncDirectoryStrictly(parent);
      }
    }
    const directory = await lstat(paths.directory, { bigint: true }).catch((error: unknown) => {
      if (knownFileErrorCode(error) === "ENOENT") {return null;}
      throw error;
    });
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
    const capturedObserved = await observeRecoveryFile(paths.captured, recoveryMaximumBytes);
    if (capturedObserved.state === "file") {
      const expectedCaptured = options.journalOperation.capturedPreimageIdentity;
      if (expectedCaptured === undefined || capturedObserved.identity === undefined ||
        !sameKnownFileIdentity(
          capturedObserved.identity,
          deserializeKnownFileIdentity(expectedCaptured)
        ) || !matchesKnownFileImage(capturedObserved, preimage)) {
        throw new KnownFileTransactionError(
          "KNOWN_FILE_RECOVERY_CONFLICT",
          `Rollback capture changed during cleanup: ${options.operation.path}.`
        );
      }
      await unlink(paths.captured);
      await syncDirectoryStrictly(paths.directory);
      await options.faultInjector?.({
        phase: "after-rollback-capture-unlinked",
        operationIndex: options.operationIndex,
        path: options.operation.path
      });
    }
    const retiredObserved = await observeRecoveryFile(paths.retired, recoveryMaximumBytes);
    if (retiredObserved.state !== "absent") {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Rollback capture retains foreign retired evidence: ${options.operation.path}.`
      );
    }
    await rmdir(paths.directory);
    await syncDirectoryStrictly(parent);
    return;
  }
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
  const captured = await observeRecoveryFile(
    paths.captured,
    recoveryMaximumBytes
  );
  const destinationBefore = await observeRecoveryFile(
    destination,
    recoveryMaximumBytes
  );
  const retired = await observeRecoveryFile(
    paths.retired,
    recoveryMaximumBytes
  );
  const matched = options.journalOperation.matchedPreimage;
  if (matched === undefined) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_JOURNAL_INVALID",
      `Captured replacement lacks its exact preimage binding: ${options.operation.path}.`
    );
  }
  const preimage = options.operation.precondition.acceptedPreimages[matched]!;

  if (options.journalOperation.capturedPreimageIdentity === undefined) {
    if (retired.state !== "absent" || captured.state !== "absent") {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Replacement capture contains bytes without durable identity authority: ${options.operation.path}.`
      );
    }
    const stableDestination = await readBoundedRegularFile(destination, preimage.size);
    if (stableDestination.outcome !== "read" || stableDestination.linkCount !== 1n ||
      !matchesKnownFileImage({
        state: "file",
        bytes: stableDestination.bytes,
        identity: stableDestination.identity,
        mode: stableDestination.mode & 0o777
      }, preimage)) {
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
        options.stored.envelope.journal,
        options.operationIndex,
        restoredOperation
      )
    );
    await rmdir(paths.directory);
    await syncDirectoryStrictly(parent);
    return;
  }

  const capturedIdentity = deserializeKnownFileIdentity(
    options.journalOperation.capturedPreimageIdentity
  );
  const captureIdentityMatches = captured.state === "file" && captured.identity !== undefined &&
    sameKnownFileIdentity(captured.identity, capturedIdentity);
  if (!captureIdentityMatches) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Captured replacement identity changed: ${options.operation.path}.`
    );
  }
  const captureBytesStable = matchesKnownFileImage(captured, preimage);
  const rollbackPath = join(
    parent,
    `.${basename(options.operation.path)}.agent-teams.rollback.${options.operationIndex}.tmp`
  );
  const rollbackIdentity = options.journalOperation.rollbackTemporaryIdentity === undefined
    ? undefined
    : deserializeKnownFileIdentity(options.journalOperation.rollbackTemporaryIdentity);
  const rollbackObserved = rollbackIdentity === undefined
    ? { state: "absent" as const }
    : await observeRecoveryFile(rollbackPath, preimage.size);
  if (rollbackIdentity !== undefined &&
    (rollbackObserved.state !== "file" || rollbackObserved.identity === undefined ||
      !sameKnownFileIdentity(rollbackObserved.identity, rollbackIdentity) ||
      !matchesKnownFileImage(rollbackObserved, preimage))) {
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
  const rollbackSource = rollbackIdentity === undefined ? paths.captured : rollbackPath;
  const rollbackSourceIdentity = rollbackIdentity ?? capturedIdentity;

  if (retired.state === "file") {
    if (retired.identity !== undefined &&
      sameKnownFileIdentity(retired.identity, capturedIdentity)) {
      await unlink(paths.retired);
      await syncDirectoryStrictly(paths.directory);
    } else {
      if (destinationBefore.state === "absent") {
        await link(paths.retired, destination);
        await syncDirectoryStrictly(parent);
        await unlink(paths.retired);
        await syncDirectoryStrictly(paths.directory);
      }
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Foreign destination was preserved from an interrupted capture: ${options.operation.path}.`
      );
    }
  }

  let observed = await observeRecoveryFile(
    destination,
    recoveryMaximumBytes
  );
  if (matchesKnownFileImage(observed, preimage)) {
    // A foreign exact preimage is already the correct rollback result. Never
    // replace it merely to recover the original inode.
    if (observed.identity === undefined ||
      !sameKnownFileIdentity(observed.identity, rollbackSourceIdentity)) {
      const restoredJournalOperation = Object.freeze({
        ...options.journalOperation,
        state: "rollback-restored" as const
      });
      await persistRecoveryJournal(
        options.store,
        options.stored,
        Object.freeze({
          ...options.stored.envelope.journal,
          operations: Object.freeze(options.stored.envelope.journal.operations.with(
            options.operationIndex,
            restoredJournalOperation
          ))
        })
      );
      if (rollbackIdentity !== undefined) {await unlink(rollbackPath);}
      if (captureBytesStable) {await unlink(paths.captured);}
      await syncDirectoryStrictly(paths.directory);
      if (captureBytesStable) {
        await options.faultInjector?.({
          phase: "after-rollback-capture-unlinked",
          operationIndex: options.operationIndex,
          path: options.operation.path
        });
      }
      if (captureBytesStable) {await rmdir(paths.directory);}
      await syncDirectoryStrictly(parent);
      if (!captureBytesStable) {
        throw new KnownFileTransactionError(
          "KNOWN_FILE_RECOVERY_CONFLICT",
          `Edited retired inode was preserved after exact rollback: ${options.operation.path}.`
        );
      }
      return;
    }
  } else if (observed.state === "file") {
    const temporaryIdentity = deserializeKnownFileIdentity(
      options.journalOperation.temporaryIdentity
    );
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
    observed = { state: "absent" };
  }

  if (observed.state === "absent") {
    await link(rollbackSource, destination).catch((error: unknown) => {
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
    await syncDirectoryStrictly(parent);
  }
  const restored = await observeRecoveryFile(destination, preimage.size);
  if (!matchesKnownFileImage(restored, preimage) || restored.identity === undefined ||
    !sameKnownFileIdentity(restored.identity, rollbackSourceIdentity)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_FAILED",
      `Captured preimage restoration failed: ${options.operation.path}.`
    );
  }
  const restoredJournalOperation = Object.freeze({
    ...options.journalOperation,
    state: "rollback-restored" as const
  });
  const restoredJournal = Object.freeze({
    ...options.stored.envelope.journal,
    operations: Object.freeze(options.stored.envelope.journal.operations.with(
      options.operationIndex,
      restoredJournalOperation
    ))
  });
  await persistRecoveryJournal(options.store, options.stored, restoredJournal);
  if (rollbackIdentity !== undefined) {await unlink(rollbackPath);}
  if (captureBytesStable) {await unlink(paths.captured);}
  await syncDirectoryStrictly(paths.directory);
  if (captureBytesStable) {
    await options.faultInjector?.({
      phase: "after-rollback-capture-unlinked",
      operationIndex: options.operationIndex,
      path: options.operation.path
    });
  }
  if (captureBytesStable) {await rmdir(paths.directory);}
  await syncDirectoryStrictly(parent);
  if (!captureBytesStable) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Edited retired inode was preserved after exact rollback: ${options.operation.path}.`
    );
  }
}

async function cleanupOperationTemporaries(options: {
  readonly operationIndex: number;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}): Promise<void> {
  const operation = options.stored.envelope.journal.plan.operations[options.operationIndex]!;
  const journalOperation = options.stored.envelope.journal.operations[options.operationIndex]!;
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
        options.stored.envelope.journal.plan.planDigest,
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

async function rollback(options: {
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}): Promise<void> {
  for (let index = options.stored.envelope.journal.operations.length - 1; index >= 0; index -= 1) {
    let journalOperation = options.stored.envelope.journal.operations[index]!;
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
      journalOperation = options.stored.envelope.journal.operations[index]!;
    }
    if (journalOperation.state === "capture-authorized") {
      await cleanupAuthorizedCapture({
        journal: options.stored.envelope.journal,
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
      operation: options.stored.envelope.journal.plan.operations[index]!,
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
  for (let index = options.stored.envelope.journal.operations.length - 1; index >= 0; index -= 1) {
    const journal = options.stored.envelope.journal;
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
  const journal = options.stored.envelope.journal;
  await removeCreatedDirectories(options.root, journal.createdDirectories);
  await removeAuthorizedDirectories(options.root, journal.authorizedDirectories);
}

async function verifyRolledBackKnownFileState(
  root: string,
  journal: KnownFileTransactionJournalV1
): Promise<void> {
  for (const [index, operation] of journal.plan.operations.entries()) {
    const journalOperation = journal.operations[index]!;
    const observed = await observeKnownFile(
      root,
      operation.path,
      maximumKnownFileEvidenceBytes(operation)
    );
    if (journalOperation.state === "already-satisfied") {
      if (!matchesKnownFileImage(observed, operation.postimage)) {
        throw new KnownFileTransactionError(
          "KNOWN_FILE_RECOVERY_CONFLICT",
          `Unchanged guard drifted during rollback: ${operation.path}.`
        );
      }
      continue;
    }
    if (operation.precondition.state === "absent") {
      if (observed.state !== "absent") {
        throw new KnownFileTransactionError(
          "KNOWN_FILE_RECOVERY_CONFLICT",
          `Absent preimage was not restored: ${operation.path}.`
        );
      }
      continue;
    }
    const matched = journalOperation.matchedPreimage;
    if (matched === undefined ||
      !matchesKnownFileImage(observed, operation.precondition.acceptedPreimages[matched]!)) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Exact preimage was not restored: ${operation.path}.`
      );
    }
  }
}

export async function recoverKnownFileTransaction(options: {
  readonly consumerRoot: string;
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
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
    const observed = await store.read();
    if (observed === undefined) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_JOURNAL_MISSING",
        "Known-file recovery journal disappeared."
      );
    }
    const stored: StoredRecoveryJournal = observed;
    const [version, buildIdentity] = await Promise.all([
      installedFoundationVersion(),
      installedFoundationBuildIdentity()
    ]);
    const transition = classifyKnownFileRecoveryTransition({
      envelope: stored.envelope,
      installedBuild: { buildIdentity, version }
    });
    if (transition.action === "reject") {
      throw new KnownFileTransactionError(
        transition.code,
        transition.message
      );
    }
    if (transition.action === "resume-committed-cleanup") {
      await verifyCommittedKnownFilePostimages(root, stored.envelope.journal);
      await cleanupCommittedKnownFileCaptures(
        root,
        stored.envelope.journal,
        options.faultInjector
      );
      await verifyCommittedKnownFilePostimages(root, stored.envelope.journal);
      const result = compileKnownFileTransactionReceipt(
        stored.envelope.journal,
        "applied"
      );
      await store.remove(stored.authority);
      retainBarrier = false;
      return result;
    }
    await rollback({
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
      root,
      store,
      stored
    });
    await verifyRolledBackKnownFileState(root, stored.envelope.journal);
    const result = compileRolledBackReceipt(stored.envelope.journal);
    await store.remove(stored.authority);
    retainBarrier = false;
    return result;
  } finally {
    await lease.release({ retainTransactionBarrier: retainBarrier });
    if (!retainBarrier) {await pruneFoundationStateDirectory(root);}
  }
}
