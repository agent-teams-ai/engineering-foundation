import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalJson,
  sha256Json,
  type CanonicalJsonValue
} from "../../../canonical-json.js";
import { installedFoundationVersion } from "../../../package-version.js";
import { createNodeFoundationTransactionCoordinator } from "../../../transaction-coordination/adapters/node/node-foundation-transaction-coordinator.js";
import { installedFoundationBuildIdentity } from "../../../transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import { ensureFoundationStateDirectory } from "../../../transaction-coordination/adapters/node/node-foundation-state-directory.js";
import type {
  KnownFileImageV1,
  KnownFileTransactionOperationOutcome,
  KnownFileTransactionPlanV1,
  KnownFileTransactionReceiptV1
} from "../../application/model/known-file-transaction.js";
import type {
  KnownFileTransactionEnvelopeV1,
  KnownFileTransactionJournalOperationV1,
  KnownFileTransactionJournalV1
} from "../../application/model/known-file-transaction-journal.js";
import {
  serializeKnownFileIdentity
} from "../../application/model/known-file-transaction-journal.js";
import { compileKnownFileTransactionEnvelope } from "../../application/policies/known-file-transaction-envelope.js";
import { assertKnownFileTransactionPlan } from "../../application/policies/known-file-transaction-plan.js";
import {
  captureFileHandleIdentity,
  pathMatchesRegularFileIdentity,
  readBoundedRegularFile
} from "./node-bounded-regular-file.js";
import { syncDirectoryStrictly } from "./node-directory-durability.js";
import {
  cleanupCommittedKnownFileCaptures,
  prepareRollbackTemporary
} from "./node-known-file-recovery-filesystem.js";
import { isLexicallyContainedPath } from "./node-repository-path.js";
import { NodeKnownFileTransactionJournalStore } from "./node-known-file-transaction-journal-store.js";
import type { KnownFileJournalAuthority } from "./node-known-file-transaction-journal-store.js";
import { inspectKnownFileTransactionBarrier } from "./node-known-file-transaction-inspection.js";
import {
  canonicalKnownFileRoot,
  classifyKnownFileOperation,
  knownFileAliasEntry,
  knownFileCaptureDirectoryName,
  knownFileErrorCode,
  knownFileImageBytes,
  knownFileTemporaryName,
  KnownFileTransactionError,
  matchesKnownFileImage,
  maximumKnownFileEvidenceBytes,
  observeKnownFile,
  sameKnownFileIdentity
} from "./node-known-file-transaction-filesystem.js";

export { KnownFileTransactionError } from "./node-known-file-transaction-filesystem.js";

export type KnownFileTransactionFaultPoint =
  | { readonly phase: "after-barrier-acquired" | "after-journal-created" | "after-journal-committed" | "after-journal-retired" }
  | {
      readonly phase:
        | "after-directory-created"
        | "after-directory-created-unbound"
        | "after-directory-authorized"
        | "after-temporary-authorized"
        | "after-temporary-synced"
        | "after-temporary-created-unbound"
        | "after-capture-ready"
        | "after-capture-created-unbound"
        | "after-capture-authorized"
        | "after-preimage-captured"
        | "after-preimage-linked-unbound"
        | "after-rollback-temporary-created-unbound"
        | "after-rollback-temporary-ready"
        | "after-destination-captured"
        | "after-destination-retired"
        | "after-operation-publishing"
        | "after-postimage-linked"
        | "after-operation-published"
        | "after-committed-capture-unlinked";
      readonly operationIndex: number;
      readonly path: string;
    };

export type KnownFileTransactionFaultInjector = (
  point: KnownFileTransactionFaultPoint
) => Promise<void> | void;

interface StoredJournal {
  authority: KnownFileJournalAuthority;
  envelope: KnownFileTransactionEnvelopeV1;
}

async function initialJournal(
  root: string,
  plan: KnownFileTransactionPlanV1
): Promise<KnownFileTransactionJournalV1> {
  const operations = [];
  for (const operation of plan.operations) {
    operations.push(classifyKnownFileOperation(
      operation,
      await observeKnownFile(root, operation.path, maximumKnownFileEvidenceBytes(operation))
    ));
  }
  return Object.freeze({
    schemaVersion: 1,
    plan,
    operations: Object.freeze(operations),
    authorizedDirectories: Object.freeze([]),
    createdDirectories: Object.freeze([])
  });
}

function replaceOperation(
  journal: KnownFileTransactionJournalV1,
  index: number,
  replacement: KnownFileTransactionJournalOperationV1
): KnownFileTransactionJournalV1 {
  return Object.freeze({
    ...journal,
    operations: Object.freeze(journal.operations.with(index, replacement))
  });
}

async function persist(
  store: NodeKnownFileTransactionJournalStore,
  stored: StoredJournal,
  journal: KnownFileTransactionJournalV1,
  state: KnownFileTransactionEnvelopeV1["state"] = "APPLYING"
): Promise<void> {
  const envelope = compileKnownFileTransactionEnvelope({
    foundation: stored.envelope.foundation,
    journal,
    state
  });
  stored.authority = await store.replace(stored.authority, envelope);
  stored.envelope = envelope;
}

async function ensureParentDirectories(options: {
  readonly faultInjector?: KnownFileTransactionFaultInjector;
  readonly index: number;
  readonly operationPath: string;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredJournal;
}): Promise<string> {
  const segments = options.operationPath.split("/");
  segments.pop();
  let current = options.root;
  const traversed: string[] = [];
  for (const segment of segments) {
    traversed.push(segment);
    const repositoryPath = traversed.join("/");
    const exists = await knownFileAliasEntry(current, segment);
    if (exists === undefined) {
      const authorized = Object.freeze({
        ...options.stored.envelope.journal,
        authorizedDirectories: Object.freeze([
          ...options.stored.envelope.journal.authorizedDirectories,
          repositoryPath
        ])
      });
      await persist(options.store, options.stored, authorized);
      await options.faultInjector?.({
        phase: "after-directory-authorized",
        operationIndex: options.index,
        path: repositoryPath
      });
      await mkdir(join(current, segment), { mode: 0o755 });
      await syncDirectoryStrictly(current);
      const metadata = await lstat(join(current, segment), { bigint: true });
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new KnownFileTransactionError(
          "KNOWN_FILE_DIRECTORY_INVALID",
          `Created ancestor is not one real directory: ${repositoryPath}.`
        );
      }
      const identity = serializeKnownFileIdentity({
        birthtimeNs: metadata.birthtimeNs,
        dev: metadata.dev,
        ino: metadata.ino
      });
      await options.faultInjector?.({
        phase: "after-directory-created-unbound",
        operationIndex: options.index,
        path: repositoryPath
      });
      const journal = Object.freeze({
        ...options.stored.envelope.journal,
        authorizedDirectories: Object.freeze(
          options.stored.envelope.journal.authorizedDirectories.filter(
            (path) => path !== repositoryPath
          )
        ),
        createdDirectories: Object.freeze([
          ...options.stored.envelope.journal.createdDirectories,
          Object.freeze({ path: repositoryPath, identity })
        ])
      });
      await persist(options.store, options.stored, journal);
      await options.faultInjector?.({
        phase: "after-directory-created",
        operationIndex: options.index,
        path: repositoryPath
      });
    }
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() ||
      !isLexicallyContainedPath(options.root, await realpath(current))) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_ANCESTOR_INVALID",
        `Managed path ancestor changed: ${options.operationPath}.`
      );
    }
  }
  return current;
}

async function prepareTemporary(options: {
  readonly operation: KnownFileTransactionPlanV1["operations"][number];
  readonly operationIndex: number;
  readonly parent: string;
  readonly planDigest: string;
}): Promise<{
  readonly identity: Awaited<ReturnType<typeof captureFileHandleIdentity>>;
  readonly path: string;
}> {
  const path = join(options.parent, knownFileTemporaryName(
    options.operation.path,
    options.planDigest,
    options.operationIndex
  ));
  const handle = await open(path, "wx", 0o600).catch((error: unknown) => {
    throw new KnownFileTransactionError(
      knownFileErrorCode(error) === "EEXIST" ? "KNOWN_FILE_TEMPORARY_EXISTS" : "KNOWN_FILE_TEMPORARY_CREATE_FAILED",
      `Could not create the transaction-owned temporary for ${options.operation.path}.`,
      { cause: error }
    );
  });
  try {
    await handle.writeFile(knownFileImageBytes(options.operation.postimage));
    await handle.chmod(options.operation.postimage.mode);
    await handle.sync();
    return { path, identity: await captureFileHandleIdentity(handle) };
  } finally {
    await handle.close();
  }
}

async function verifyTemporary(
  path: string,
  identity: Awaited<ReturnType<typeof captureFileHandleIdentity>>,
  image: KnownFileImageV1
): Promise<void> {
  const observed = await readBoundedRegularFile(path, image.size);
  if (observed.outcome !== "read" || !sameKnownFileIdentity(observed.identity, identity) ||
    !matchesKnownFileImage({ state: "file", bytes: observed.bytes, identity: observed.identity, mode: observed.mode & 0o777 }, image)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_TEMPORARY_CHANGED",
      "Transaction-owned temporary changed before publication."
    );
  }
}

function capturePaths(options: {
  readonly operation: KnownFileTransactionPlanV1["operations"][number];
  readonly operationIndex: number;
  readonly parent: string;
  readonly planDigest: string;
}): { readonly captured: string; readonly directory: string; readonly retired: string } {
  const directory = join(options.parent, knownFileCaptureDirectoryName(
    options.operation.path,
    options.planDigest,
    options.operationIndex
  ));
  return {
    captured: join(directory, "preimage"),
    directory,
    retired: join(directory, "retired")
  };
}

async function prepareCaptureDirectory(options: {
  readonly operation: KnownFileTransactionPlanV1["operations"][number];
  readonly operationIndex: number;
  readonly parent: string;
  readonly planDigest: string;
}): Promise<{
  readonly identity: Awaited<ReturnType<typeof captureFileHandleIdentity>>;
  readonly paths: ReturnType<typeof capturePaths>;
}> {
  const paths = capturePaths(options);
  await mkdir(paths.directory, { mode: 0o700 }).catch((error: unknown) => {
    throw new KnownFileTransactionError(
      knownFileErrorCode(error) === "EEXIST"
        ? "KNOWN_FILE_CAPTURE_EXISTS"
        : "KNOWN_FILE_CAPTURE_CREATE_FAILED",
      `Could not create the transaction-owned capture for ${options.operation.path}.`,
      { cause: error }
    );
  });
  await syncDirectoryStrictly(options.parent);
  const metadata = await lstat(paths.directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_CAPTURE_INVALID",
      `Transaction capture is not one real directory: ${options.operation.path}.`
    );
  }
  return {
    identity: {
      birthtimeNs: metadata.birthtimeNs,
      dev: metadata.dev,
      ino: metadata.ino
    },
    paths
  };
}

async function captureKnownPreimage(options: {
  readonly capture: Awaited<ReturnType<typeof prepareCaptureDirectory>>;
  readonly faultInjector?: KnownFileTransactionFaultInjector;
  readonly index: number;
  readonly operation: KnownFileTransactionPlanV1["operations"][number] & {
    readonly precondition: Extract<KnownFileTransactionPlanV1["operations"][number]["precondition"], { readonly state: "known-file" }>;
  };
  readonly root: string;
}): Promise<{
  readonly identity: Awaited<ReturnType<typeof captureFileHandleIdentity>>;
  readonly matchedPreimage: number;
}> {
  const destination = join(options.root, ...options.operation.path.split("/"));
  await link(destination, options.capture.paths.captured).catch((error: unknown) => {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_CAS_MISMATCH",
      `Could not capture the exact replacement preimage: ${options.operation.path}.`,
      { cause: error }
    );
  });
  await syncDirectoryStrictly(options.capture.paths.directory);
  const captured = await readBoundedRegularFile(
    options.capture.paths.captured,
    maximumKnownFileEvidenceBytes(options.operation)
  );
  const matchedPreimage = captured.outcome === "read"
    ? options.operation.precondition.acceptedPreimages.findIndex((image) =>
        matchesKnownFileImage({
          state: "file",
          bytes: captured.bytes,
          identity: captured.identity,
          mode: captured.mode & 0o777
        }, image)
      )
    : -1;
  if (captured.outcome !== "read" || captured.linkCount !== 2n || matchedPreimage < 0) {
    // This pathname is an alias created by this transaction. Removing the alias
    // cannot remove the editor's public pathname and never discards unknown bytes.
    await unlink(options.capture.paths.captured);
    await syncDirectoryStrictly(options.capture.paths.directory);
    throw new KnownFileTransactionError(
      "KNOWN_FILE_CAS_MISMATCH",
      `Captured replacement preimage is no longer accepted: ${options.operation.path}.`
    );
  }
  return { identity: captured.identity, matchedPreimage };
}

async function retireCapturedDestination(options: {
  readonly capture: Awaited<ReturnType<typeof prepareCaptureDirectory>>;
  readonly capturedIdentity: Awaited<ReturnType<typeof captureFileHandleIdentity>>;
  readonly destination: string;
  readonly faultInjector?: KnownFileTransactionFaultInjector;
  readonly index: number;
  readonly operationPath: string;
  readonly parent: string;
  readonly preimage: KnownFileImageV1;
}): Promise<void> {
  await rename(options.destination, options.capture.paths.retired).catch((error: unknown) => {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_CAS_MISMATCH",
      `Destination disappeared before identity-bound capture: ${options.operationPath}.`,
      { cause: error }
    );
  });
  await syncDirectoryStrictly(options.capture.paths.directory);
  await syncDirectoryStrictly(options.parent);
  await options.faultInjector?.({
    phase: "after-destination-captured",
    operationIndex: options.index,
    path: options.operationPath
  });
  const retired = await readBoundedRegularFile(options.capture.paths.retired, 8 * 1024 * 1024);
  if (retired.outcome !== "read" ||
    !sameKnownFileIdentity(retired.identity, options.capturedIdentity)) {
    if (retired.outcome === "read") {
      try {
        await link(options.capture.paths.retired, options.destination);
        await syncDirectoryStrictly(options.parent);
        await unlink(options.capture.paths.retired);
        await syncDirectoryStrictly(options.capture.paths.directory);
      } catch (error) {
        if (knownFileErrorCode(error) !== "EEXIST") {throw error;}
      }
    }
    throw new KnownFileTransactionError(
      "KNOWN_FILE_CAS_MISMATCH",
      `A foreign destination appeared during identity-bound capture: ${options.operationPath}.`
    );
  }
  const stableCaptured = await readBoundedRegularFile(
    options.capture.paths.captured,
    options.preimage.size
  );
  if (stableCaptured.outcome !== "read" ||
    stableCaptured.linkCount !== 2n ||
    !sameKnownFileIdentity(stableCaptured.identity, options.capturedIdentity) ||
    !matchesKnownFileImage({
      state: "file", bytes: stableCaptured.bytes, identity: stableCaptured.identity,
      mode: stableCaptured.mode & 0o777
    }, options.preimage)) {
    await link(options.capture.paths.retired, options.destination).catch((error: unknown) => {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Mutated retired destination could not be restored: ${options.operationPath}.`,
        { cause: error }
      );
    });
    await syncDirectoryStrictly(options.parent);
    await unlink(options.capture.paths.retired);
    await syncDirectoryStrictly(options.capture.paths.directory);
    throw new KnownFileTransactionError(
      "KNOWN_FILE_CAS_MISMATCH",
      `Captured replacement preimage changed through an open file handle: ${options.operationPath}.`
    );
  }
  await unlink(options.capture.paths.retired);
  await syncDirectoryStrictly(options.capture.paths.directory);
}

// oxlint-disable-next-line complexity, max-lines-per-function
async function executeOperation(options: {
  readonly faultInjector?: KnownFileTransactionFaultInjector;
  readonly index: number;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredJournal;
}): Promise<void> {
  const operation = options.stored.envelope.journal.plan.operations[options.index]!;
  let journalOperation = options.stored.envelope.journal.operations[options.index]!;
  if (journalOperation.state === "already-satisfied" || journalOperation.state === "published") {
    return;
  }
  if (journalOperation.state !== "pending") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_REQUIRED",
      `Operation ${operation.path} is already in progress and requires recovery.`
    );
  }
  const parent = await ensureParentDirectories({
    ...options,
    operationPath: operation.path
  });
  journalOperation = Object.freeze({ ...journalOperation, state: "temporary-authorized" as const });
  await persist(
    options.store,
    options.stored,
    replaceOperation(options.stored.envelope.journal, options.index, journalOperation)
  );
  await options.faultInjector?.({
    phase: "after-temporary-authorized",
    operationIndex: options.index,
    path: operation.path
  });
  const temporary = await prepareTemporary({
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
  journalOperation = Object.freeze({
    ...journalOperation,
    state: "temporary-ready" as const,
    temporaryIdentity: serializeKnownFileIdentity(temporary.identity)
  });
  await persist(
    options.store,
    options.stored,
    replaceOperation(options.stored.envelope.journal, options.index, journalOperation)
  );
  await options.faultInjector?.({
    phase: "after-temporary-synced",
    operationIndex: options.index,
    path: operation.path
  });
  await verifyTemporary(temporary.path, temporary.identity, operation.postimage);
  const destination = join(options.root, ...operation.path.split("/"));
  if (operation.precondition.state === "absent") {
    journalOperation = Object.freeze({ ...journalOperation, state: "publishing" as const });
    await persist(
      options.store,
      options.stored,
      replaceOperation(options.stored.envelope.journal, options.index, journalOperation)
    );
    await options.faultInjector?.({
      phase: "after-operation-publishing",
      operationIndex: options.index,
      path: operation.path
    });
    await link(temporary.path, destination).catch((error: unknown) => {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_CAS_MISMATCH",
        `Destination appeared during create CAS: ${operation.path}.`,
        { cause: error }
      );
    });
    await options.faultInjector?.({
      phase: "after-postimage-linked",
      operationIndex: options.index,
      path: operation.path
    });
    await unlink(temporary.path);
  } else {
    journalOperation = Object.freeze({ ...journalOperation, state: "capture-authorized" as const });
    await persist(
      options.store,
      options.stored,
      replaceOperation(options.stored.envelope.journal, options.index, journalOperation)
    );
    await options.faultInjector?.({
      phase: "after-capture-authorized",
      operationIndex: options.index,
      path: operation.path
    });
    const capture = await prepareCaptureDirectory({
      operation,
      operationIndex: options.index,
      parent,
      planDigest: options.stored.envelope.journal.plan.planDigest
    });
    await options.faultInjector?.({
      phase: "after-capture-created-unbound",
      operationIndex: options.index,
      path: operation.path
    });
    journalOperation = Object.freeze({
      ...journalOperation,
      captureDirectoryIdentity: serializeKnownFileIdentity(capture.identity),
      state: "capture-ready" as const
    });
    await persist(
      options.store,
      options.stored,
      replaceOperation(options.stored.envelope.journal, options.index, journalOperation)
    );
    await options.faultInjector?.({
      phase: "after-capture-ready",
      operationIndex: options.index,
      path: operation.path
    });
    const captured = await captureKnownPreimage({
      capture,
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
      index: options.index,
      operation: { ...operation, precondition: operation.precondition },
      root: options.root
    });
    await options.faultInjector?.({
      phase: "after-preimage-linked-unbound",
      operationIndex: options.index,
      path: operation.path
    });
    journalOperation = Object.freeze({
      ...journalOperation,
      capturedPreimageIdentity: serializeKnownFileIdentity(captured.identity),
      matchedPreimage: captured.matchedPreimage,
      state: "preimage-captured" as const
    });
    await persist(
      options.store,
      options.stored,
      replaceOperation(options.stored.envelope.journal, options.index, journalOperation)
    );
    await options.faultInjector?.({
      phase: "after-preimage-captured",
      operationIndex: options.index,
      path: operation.path
    });
    const rollbackPath = join(
      parent,
      `.${operation.path.split("/").at(-1)!}.agent-teams.rollback.${options.index}.tmp`
    );
    const rollbackIdentity = await prepareRollbackTemporary({
      operationPath: operation.path,
      path: rollbackPath,
      preimage: operation.precondition.acceptedPreimages[captured.matchedPreimage]!
    });
    await options.faultInjector?.({
      phase: "after-rollback-temporary-created-unbound",
      operationIndex: options.index,
      path: operation.path
    });
    await syncDirectoryStrictly(parent);
    if (await pathMatchesRegularFileIdentity(rollbackPath, rollbackIdentity) !== "match") {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_CAS_MISMATCH",
        `Rollback temporary changed before durable identity binding: ${operation.path}.`
      );
    }
    journalOperation = Object.freeze({
      ...journalOperation,
      rollbackTemporaryIdentity: serializeKnownFileIdentity(rollbackIdentity)
    });
    await persist(
      options.store,
      options.stored,
      replaceOperation(options.stored.envelope.journal, options.index, journalOperation)
    );
    await options.faultInjector?.({
      phase: "after-rollback-temporary-ready",
      operationIndex: options.index,
      path: operation.path
    });
    await retireCapturedDestination({
      capture,
      capturedIdentity: captured.identity,
      destination,
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
      index: options.index,
      operationPath: operation.path,
      parent,
      preimage: operation.precondition.acceptedPreimages[captured.matchedPreimage]!
    });
    journalOperation = Object.freeze({ ...journalOperation, state: "destination-retired" as const });
    await persist(
      options.store,
      options.stored,
      replaceOperation(options.stored.envelope.journal, options.index, journalOperation)
    );
    await options.faultInjector?.({
      phase: "after-destination-retired",
      operationIndex: options.index,
      path: operation.path
    });
    journalOperation = Object.freeze({ ...journalOperation, state: "publishing" as const });
    await persist(
      options.store,
      options.stored,
      replaceOperation(options.stored.envelope.journal, options.index, journalOperation)
    );
    await options.faultInjector?.({
      phase: "after-operation-publishing",
      operationIndex: options.index,
      path: operation.path
    });
    await link(temporary.path, destination).catch((error: unknown) => {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_CAS_MISMATCH",
        `Destination appeared during replacement publication: ${operation.path}.`,
        { cause: error }
      );
    });
    await options.faultInjector?.({
      phase: "after-postimage-linked",
      operationIndex: options.index,
      path: operation.path
    });
    await unlink(temporary.path);
  }
  await syncDirectoryStrictly(parent);
  const published = await observeKnownFile(options.root, operation.path, operation.postimage.size);
  if (!matchesKnownFileImage(published, operation.postimage) || published.identity === undefined ||
    !sameKnownFileIdentity(published.identity, temporary.identity)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_POSTIMAGE_INVALID",
      `Published postimage failed exact verification: ${operation.path}.`
    );
  }
  journalOperation = Object.freeze({ ...journalOperation, state: "published" as const });
  await persist(
    options.store,
    options.stored,
    replaceOperation(options.stored.envelope.journal, options.index, journalOperation)
  );
  await options.faultInjector?.({
    phase: "after-operation-published",
    operationIndex: options.index,
    path: operation.path
  });
}

export function compileKnownFileTransactionReceipt(
  journal: KnownFileTransactionJournalV1,
  outcome: "already-satisfied" | "applied"
): KnownFileTransactionReceiptV1 {
  const operations = journal.operations.map((entry, index) => {
    const planOperation = journal.plan.operations[index]!;
    const operationOutcome: KnownFileTransactionOperationOutcome =
      entry.state === "already-satisfied"
        ? "already-satisfied"
        : planOperation.precondition.state === "absent" ? "created" : "replaced";
    return Object.freeze({
      path: entry.path,
      outcome: operationOutcome,
      resultDigest: planOperation.postimage.digest
    });
  });
  const body = {
    schemaVersion: 1 as const,
    protocol: "foundation.replace-known-file/v1" as const,
    planDigest: journal.plan.planDigest,
    outcome,
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

export async function verifyCommittedKnownFilePostimages(
  root: string,
  journal: KnownFileTransactionJournalV1
): Promise<void> {
  for (const operation of journal.plan.operations) {
    if (!matchesKnownFileImage(
      await observeKnownFile(root, operation.path, operation.postimage.size),
      operation.postimage
    )) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_COMMITTED_DRIFT",
        `Committed postimage changed before journal retirement: ${operation.path}.`
      );
    }
  }
}

async function verifyApplyingKnownFilePostimages(
  root: string,
  journal: KnownFileTransactionJournalV1
): Promise<void> {
  for (const operation of journal.plan.operations) {
    if (!matchesKnownFileImage(
      await observeKnownFile(root, operation.path, operation.postimage.size),
      operation.postimage
    )) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_PRECOMMIT_DRIFT",
        `Transaction postimage changed before commit: ${operation.path}.`
      );
    }
  }
}

export async function applyKnownFileTransaction(options: {
  readonly consumerRoot: string;
  readonly plan: KnownFileTransactionPlanV1;
  readonly faultInjector?: KnownFileTransactionFaultInjector;
}): Promise<KnownFileTransactionReceiptV1> {
  assertKnownFileTransactionPlan(options.plan);
  if (process.platform === "win32") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_APPLY_UNSUPPORTED",
      "Known-file apply requires strict directory durability and is not qualified on Windows."
    );
  }
  const root = await canonicalKnownFileRoot(options.consumerRoot);
  const barrier = await inspectKnownFileTransactionBarrier({ consumerRoot: root });
  if (barrier.state !== "idle" && barrier.code === "KNOWN_FILE_RECOVERY_REQUIRED") {
    throw new KnownFileTransactionError(
      barrier.code,
      barrier.message
    );
  }
  const optimisticJournal = await initialJournal(root, options.plan);
  if (barrier.state === "idle" &&
    optimisticJournal.operations.every(({ state }) => state === "already-satisfied")) {
    return compileKnownFileTransactionReceipt(optimisticJournal, "already-satisfied");
  }
  const coordinator = await createNodeFoundationTransactionCoordinator(root);
  const lease = await coordinator.acquire({ requestedMutation: "known-file-transaction" });
  let retainBarrier = false;
  let store: NodeKnownFileTransactionJournalStore | undefined;
  try {
    await options.faultInjector?.({ phase: "after-barrier-acquired" });
    const journal = await initialJournal(root, options.plan);
    if (journal.operations.every(({ state }) => state === "already-satisfied")) {
      return compileKnownFileTransactionReceipt(journal, "already-satisfied");
    }
    const [version, buildIdentity] = await Promise.all([
      installedFoundationVersion(),
      installedFoundationBuildIdentity()
    ]);
    const envelope = compileKnownFileTransactionEnvelope({
      foundation: { version, buildIdentity },
      journal,
      state: "APPLYING"
    });
    const stateDirectory = await ensureFoundationStateDirectory(root);
    store = new NodeKnownFileTransactionJournalStore(stateDirectory);
    const stored: StoredJournal = {
      authority: await store.create(envelope),
      envelope
    };
    retainBarrier = true;
    await options.faultInjector?.({ phase: "after-journal-created" });
    for (let index = 0; index < options.plan.operations.length; index += 1) {
      await executeOperation({
        ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
        index,
        root,
        store,
        stored
      });
    }
    await verifyApplyingKnownFilePostimages(root, stored.envelope.journal);
    await persist(store, stored, stored.envelope.journal, "COMMITTED");
    await options.faultInjector?.({ phase: "after-journal-committed" });
    await verifyCommittedKnownFilePostimages(root, stored.envelope.journal);
    await cleanupCommittedKnownFileCaptures(
      root,
      stored.envelope.journal,
      options.faultInjector
    );
    await verifyCommittedKnownFilePostimages(root, stored.envelope.journal);
    const result = compileKnownFileTransactionReceipt(stored.envelope.journal, "applied");
    await store.remove(stored.authority);
    await options.faultInjector?.({ phase: "after-journal-retired" });
    retainBarrier = false;
    return result;
  } catch (error) {
    if (store !== undefined) {
      try {
        retainBarrier = await store.read() !== undefined;
      } catch {
        // Unreadable evidence must stay protected for manual inspection.
        retainBarrier = true;
      }
    }
    throw error;
  } finally {
    await lease.release({ retainTransactionBarrier: retainBarrier });
  }
}

export function canonicalKnownFileTransactionReceipt(
  value: KnownFileTransactionReceiptV1
): string {
  return `${canonicalJson(value as unknown as CanonicalJsonValue)}\n`;
}
