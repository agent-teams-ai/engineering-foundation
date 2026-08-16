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
  readBoundedRegularFile
} from "./node-bounded-regular-file.js";
import { syncDirectoryStrictly } from "./node-directory-durability.js";
import { isLexicallyContainedPath } from "./node-repository-path.js";
import { NodeKnownFileTransactionJournalStore } from "./node-known-file-transaction-journal-store.js";
import { inspectKnownFileTransactionBarrier } from "./node-known-file-transaction-inspection.js";
import type { KnownFileJournalAuthority } from "./node-known-file-transaction-journal-store.js";
import {
  canonicalKnownFileRoot,
  classifyKnownFileOperation,
  knownFileAliasEntry,
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
  | { readonly phase: "after-journal-created" | "after-journal-committed" }
  | {
      readonly phase:
        | "after-directory-created"
        | "after-temporary-synced"
        | "after-operation-publishing"
        | "after-operation-published";
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
      const journal = Object.freeze({
        ...options.stored.envelope.journal,
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
  const temporary = await prepareTemporary({
    operation,
    operationIndex: options.index,
    parent,
    planDigest: options.stored.envelope.journal.plan.planDigest
  });
  await options.faultInjector?.({
    phase: "after-temporary-synced",
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
  await verifyTemporary(temporary.path, temporary.identity, operation.postimage);
  const observed = await observeKnownFile(options.root, operation.path, maximumKnownFileEvidenceBytes(operation));
  classifyKnownFileOperation(operation, observed);
  const destination = join(options.root, ...operation.path.split("/"));
  if (operation.precondition.state === "absent") {
    await link(temporary.path, destination).catch((error: unknown) => {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_CAS_MISMATCH",
        `Destination appeared during create CAS: ${operation.path}.`,
        { cause: error }
      );
    });
    await unlink(temporary.path);
  } else {
    await rename(temporary.path, destination);
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
    } as unknown as CanonicalJsonValue)
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
  if (barrier.state !== "idle") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_REQUIRED",
      barrier.message
    );
  }
  const preview = await initialJournal(root, options.plan);
  if (preview.operations.every(({ state }) => state === "already-satisfied")) {
    return compileKnownFileTransactionReceipt(preview, "already-satisfied");
  }
  const coordinator = await createNodeFoundationTransactionCoordinator(root);
  const lease = await coordinator.acquire({ requestedMutation: "known-file-transaction" });
  let retainBarrier = false;
  try {
    const journal = await initialJournal(root, options.plan);
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
    const store = new NodeKnownFileTransactionJournalStore(stateDirectory);
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
    await persist(store, stored, stored.envelope.journal, "COMMITTED");
    await options.faultInjector?.({ phase: "after-journal-committed" });
    await verifyCommittedKnownFilePostimages(root, stored.envelope.journal);
    const result = compileKnownFileTransactionReceipt(stored.envelope.journal, "applied");
    await store.remove(stored.authority);
    retainBarrier = false;
    return result;
  } catch (error) {
    retainBarrier = true;
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
