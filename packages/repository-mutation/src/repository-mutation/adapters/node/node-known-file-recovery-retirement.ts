import { lstat, mkdir, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { KnownFileTransactionPlanV1 } from "../../application/model/known-file-transaction.js";
import type { KnownFileTransactionJournalV1 } from "../../application/model/known-file-transaction-journal.js";
import {
  deserializeKnownFileIdentity,
  serializeKnownFileIdentity
} from "../../application/model/known-file-transaction-journal.js";
import { pathMatchesRegularFileIdentity } from "./node-bounded-regular-file.js";
import { syncDirectoryStrictly } from "./node-directory-durability.js";
import {
  knownFileErrorCode,
  knownFileTemporaryName,
  KnownFileTransactionError,
  sameKnownFileIdentity
} from "./node-known-file-transaction-filesystem.js";
import type { NodeKnownFileTransactionJournalStore } from "./node-known-file-transaction-journal-store.js";
import {
  type KnownFileRecoveryFaultInjector,
  persistRecoveryJournal,
  replaceRecoveryOperation,
  type StoredRecoveryJournal
} from "./node-known-file-recovery-state.js";

type RecoveryJournalOperation = KnownFileTransactionJournalV1["operations"][number];
type RecoveryJournalOperationWithIdentity = Extract<
  RecoveryJournalOperation,
  { readonly temporaryIdentity: unknown }
>;
type RecoveryRetirement = NonNullable<RecoveryJournalOperationWithIdentity["retirement"]>;

interface RetirementExecutionOptions {
  readonly expectedIdentity: ReturnType<typeof deserializeKnownFileIdentity>;
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
  readonly kind: "destination" | "rollback-temporary" | "temporary";
  readonly operationIndex: number;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredRecoveryJournal;
}

interface RetirementPaths {
  readonly captured: string;
  readonly directory: string;
  readonly source: string;
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

async function createRetirementAuthority(
  options: RetirementExecutionOptions,
  operation: KnownFileTransactionPlanV1["operations"][number],
  parent: string,
  paths: RetirementPaths,
  journalOperation: RecoveryJournalOperationWithIdentity
): Promise<RecoveryJournalOperationWithIdentity> {
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
  const retirement = Object.freeze({
    kind: options.kind,
    state: "ready" as const,
    directoryIdentity: serializeKnownFileIdentity(directory),
    pathIdentity: serializeKnownFileIdentity(options.expectedIdentity)
  });
  const updated = Object.freeze({ ...journalOperation, retirement });
  await persistRecoveryJournal(
    options.store,
    options.stored,
    replaceRecoveryOperation(options.stored.envelope.payload, options.operationIndex, updated)
  );
  await options.faultInjector?.({
    phase: "after-retirement-directory-bound",
    operationIndex: options.operationIndex,
    path: operation.path
  });
  return updated;
}

async function reconcileRetirementDirectory(
  options: RetirementExecutionOptions,
  operation: KnownFileTransactionPlanV1["operations"][number],
  paths: RetirementPaths,
  journalOperation: RecoveryJournalOperationWithIdentity,
  retirement: RecoveryRetirement
): Promise<"continue" | "complete"> {
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
    await persistRecoveryJournal(
      options.store,
      options.stored,
      replaceRecoveryOperation(
        options.stored.envelope.payload,
        options.operationIndex,
        clearOperationRetirement(journalOperation)
      )
    );
    return "complete";
  }
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
    directory.birthtimeNs !== expectedDirectory.birthtimeNs ||
    directory.dev !== expectedDirectory.dev || directory.ino !== expectedDirectory.ino) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Journal-bound retirement directory changed: ${operation.path}.`
    );
  }
  return "continue";
}

async function captureRetirementPath(
  options: RetirementExecutionOptions,
  context: {
    readonly operation: KnownFileTransactionPlanV1["operations"][number];
    readonly parent: string;
    readonly paths: RetirementPaths;
    readonly journalOperation: RecoveryJournalOperationWithIdentity;
    readonly retirement: RecoveryRetirement;
  }
): Promise<RecoveryJournalOperationWithIdentity> {
  const { journalOperation, operation, parent, paths, retirement } = context;
  if (retirement.state !== "ready") {return journalOperation;}
  const capturedMatch = await pathMatchesRegularFileIdentity(paths.captured, options.expectedIdentity);
  const sourceMatch = await pathMatchesRegularFileIdentity(paths.source, options.expectedIdentity);
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
  const updated = Object.freeze({
    ...journalOperation,
    retirement: Object.freeze({ ...retirement, state: "captured" as const })
  });
  await persistRecoveryJournal(
    options.store,
    options.stored,
    replaceRecoveryOperation(options.stored.envelope.payload, options.operationIndex, updated)
  );
  await options.faultInjector?.({
    phase: "after-retirement-captured",
    operationIndex: options.operationIndex,
    path: operation.path
  });
  return updated;
}

async function authorizeRetirementUnlink(
  options: RetirementExecutionOptions,
  operation: KnownFileTransactionPlanV1["operations"][number],
  paths: RetirementPaths,
  journalOperation: RecoveryJournalOperationWithIdentity
): Promise<RecoveryJournalOperationWithIdentity> {
  const retirement = journalOperation.retirement!;
  if (retirement.state !== "captured") {return journalOperation;}
  if (await pathMatchesRegularFileIdentity(paths.captured, options.expectedIdentity) !== "match") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Journal-bound retired bytes changed: ${operation.path}.`
    );
  }
  const updated = Object.freeze({
    ...journalOperation,
    retirement: Object.freeze({ ...retirement, state: "unlink-authorized" as const })
  });
  await persistRecoveryJournal(
    options.store,
    options.stored,
    replaceRecoveryOperation(options.stored.envelope.payload, options.operationIndex, updated)
  );
  await options.faultInjector?.({
    phase: "after-retirement-unlink-authorized",
    operationIndex: options.operationIndex,
    path: operation.path
  });
  return updated;
}

async function removeRetirementEvidence(
  options: RetirementExecutionOptions,
  operation: KnownFileTransactionPlanV1["operations"][number],
  parent: string,
  paths: RetirementPaths,
  journalOperation: RecoveryJournalOperationWithIdentity
): Promise<void> {
  const captured = await pathMatchesRegularFileIdentity(paths.captured, options.expectedIdentity);
  if (captured === "match") {
    await unlink(paths.captured);
    await syncDirectoryStrictly(paths.directory);
  } else if (captured !== "missing") {
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
  await persistRecoveryJournal(
    options.store,
    options.stored,
    replaceRecoveryOperation(
      options.stored.envelope.payload,
      options.operationIndex,
      clearOperationRetirement(journalOperation)
    )
  );
}

export async function retireJournalBoundPath(options: RetirementExecutionOptions): Promise<void> {
  const operation = options.stored.envelope.payload.plan.operations[options.operationIndex]!;
  const parent = dirname(join(options.root, ...operation.path.split("/")));
  const paths = retirementPath({
    kind: options.kind,
    operation,
    operationIndex: options.operationIndex,
    parent,
    planDigest: options.stored.envelope.payload.plan.planDigest
  });
  const initial = options.stored.envelope.payload.operations[options.operationIndex]!;
  if (!("temporaryIdentity" in initial)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_JOURNAL_INVALID",
      `Retirement requires durable operation identity: ${operation.path}.`
    );
  }
  let journalOperation = initial;
  if (journalOperation.retirement === undefined) {
    journalOperation = await createRetirementAuthority(
      options, operation, parent, paths, journalOperation
    );
  }
  const retirement = journalOperation.retirement!;
  if (retirement.kind !== options.kind ||
    !sameKnownFileIdentity(deserializeKnownFileIdentity(retirement.pathIdentity), options.expectedIdentity)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Retirement authority does not match the requested path: ${operation.path}.`
    );
  }
  if (await reconcileRetirementDirectory(
    options, operation, paths, journalOperation, retirement
  ) === "complete") {return;}
  journalOperation = await captureRetirementPath(
    options, { journalOperation, operation, parent, paths, retirement }
  );
  journalOperation = await authorizeRetirementUnlink(
    options, operation, paths, journalOperation
  );
  await removeRetirementEvidence(options, operation, parent, paths, journalOperation);
}
