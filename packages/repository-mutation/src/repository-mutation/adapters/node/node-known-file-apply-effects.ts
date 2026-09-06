import type { KnownFileCoordination } from "./known-file-coordination.js";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { KnownFileImageV1, KnownFileTransactionPlanV1 } from "../../application/model/known-file-transaction.js";
import { serializeKnownFileIdentity } from "../../application/model/known-file-transaction-journal.js";

import { syncDirectoryStrictly } from "./node-directory-durability.js";
import { prepareRollbackTemporary } from "./node-known-file-recovery-filesystem.js";
import type { KnownFileTransactionFaultInjector } from "./node-known-file-apply-faults.js";
import {
  persistKnownFileApplyState,
  transitionKnownFileOperation,
  type KnownFileApplyState
} from "./node-known-file-apply-state.js";
import { knownFileAliasEntry, knownFileCaptureDirectoryName, knownFileErrorCode, knownFileImageBytes, knownFileTemporaryName, matchesKnownFileImage, maximumKnownFileEvidenceBytes, sameKnownFileIdentity } from "./node-known-file-transaction-filesystem.js";
import { KnownFileTransactionError } from "../../application/model/known-file-transaction-error.js";
import type { NodeKnownFileTransactionJournalStore } from "./node-known-file-transaction-journal-store.js";
import { isLexicallyContainedPath } from "./node-repository-path.js";

type Operation = KnownFileTransactionPlanV1["operations"][number];
type Identity = Awaited<ReturnType<KnownFileCoordination["captureFileHandleIdentity"]>>;

export interface PreparedKnownFileTemporary {
  readonly identity: Identity;
  readonly path: string;
}

export interface KnownFileCapture {
  readonly identity: Identity;
  readonly paths: {
    readonly captured: string;
    readonly directory: string;
    readonly retired: string;
  };
}

export async function ensureKnownFileParentDirectories(options: {
  readonly faultInjector?: KnownFileTransactionFaultInjector;
  readonly index: number;
  readonly operationPath: string;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: KnownFileApplyState;
}): Promise<string> {
  const segments = options.operationPath.split("/");
  segments.pop();
  let current = options.root;
  const traversed: string[] = [];
  for (const segment of segments) {
    traversed.push(segment);
    const repositoryPath = traversed.join("/");
    if (await knownFileAliasEntry(current, segment) === undefined) {
      const authorized = Object.freeze({
        ...options.stored.envelope.payload,
        authorizedDirectories: Object.freeze([
          ...options.stored.envelope.payload.authorizedDirectories,
          repositoryPath
        ])
      });
      await persistKnownFileApplyState(options.store, options.stored, authorized);
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
        ...options.stored.envelope.payload,
        authorizedDirectories: Object.freeze(
          options.stored.envelope.payload.authorizedDirectories.filter(
            (path) => path !== repositoryPath
          )
        ),
        createdDirectories: Object.freeze([
          ...options.stored.envelope.payload.createdDirectories,
          Object.freeze({ path: repositoryPath, identity })
        ])
      });
      await persistKnownFileApplyState(options.store, options.stored, journal);
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

export async function prepareKnownFileTemporary(coordination: Pick<KnownFileCoordination, "captureFileHandleIdentity">, options: {
  readonly operation: Operation;
  readonly operationIndex: number;
  readonly parent: string;
  readonly planDigest: string;
}): Promise<PreparedKnownFileTemporary> {
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
    return Object.freeze({ path, identity: await coordination.captureFileHandleIdentity(handle) });
  } finally {
    await handle.close();
  }
}

export async function verifyKnownFileTemporary(coordination: Pick<KnownFileCoordination, "readBoundedRegularFile">,
  temporary: PreparedKnownFileTemporary,
  image: KnownFileImageV1
): Promise<void> {
  const observed = await coordination.readBoundedRegularFile(temporary.path, image.size);
  if (observed.outcome !== "read" ||
    !sameKnownFileIdentity(observed.identity, temporary.identity) ||
    !matchesKnownFileImage({
      state: "file",
      bytes: observed.bytes,
      identity: observed.identity,
      mode: observed.mode & 0o777
    }, image)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_TEMPORARY_CHANGED",
      "Transaction-owned temporary changed before publication."
    );
  }
}

export async function prepareKnownFileCapture(options: {
  readonly operation: Operation;
  readonly operationIndex: number;
  readonly parent: string;
  readonly planDigest: string;
}): Promise<KnownFileCapture> {
  const directory = join(options.parent, knownFileCaptureDirectoryName(
    options.operation.path,
    options.planDigest,
    options.operationIndex
  ));
  const paths = {
    captured: join(directory, "preimage"),
    directory,
    retired: join(directory, "retired")
  };
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
  return Object.freeze({
    identity: {
      birthtimeNs: metadata.birthtimeNs,
      dev: metadata.dev,
      ino: metadata.ino
    },
    paths: Object.freeze(paths)
  });
}

export async function captureKnownFilePreimage(coordination: Pick<KnownFileCoordination, "readBoundedRegularFile">, options: {
  readonly capture: KnownFileCapture;
  readonly operation: Operation & {
    readonly precondition: Extract<Operation["precondition"], { readonly state: "known-file" }>;
  };
  readonly root: string;
}): Promise<{ readonly identity: Identity; readonly matchedPreimage: number }> {
  const destination = join(options.root, ...options.operation.path.split("/"));
  await link(destination, options.capture.paths.captured).catch((error: unknown) => {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_CAS_MISMATCH",
      `Could not capture the exact replacement preimage: ${options.operation.path}.`,
      { cause: error }
    );
  });
  await syncDirectoryStrictly(options.capture.paths.directory);
  const captured = await coordination.readBoundedRegularFile(
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
    await unlink(options.capture.paths.captured);
    await syncDirectoryStrictly(options.capture.paths.directory);
    throw new KnownFileTransactionError(
      "KNOWN_FILE_CAS_MISMATCH",
      `Captured replacement preimage is no longer accepted: ${options.operation.path}.`
    );
  }
  return Object.freeze({ identity: captured.identity, matchedPreimage });
}

export async function prepareKnownFileRollback(coordination: Pick<KnownFileCoordination,
  "captureFileHandleIdentity"
  | "pathMatchesRegularFileIdentity"
  | "readBoundedRegularFile"
  | "readBoundedRegularFileHandle"
>, options: {
  readonly faultInjector?: KnownFileTransactionFaultInjector;
  readonly index: number;
  readonly operation: Operation & {
    readonly precondition: Extract<Operation["precondition"], { readonly state: "known-file" }>;
  };
  readonly parent: string;
  readonly preimageIndex: number;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: KnownFileApplyState;
}): Promise<void> {
  const rollbackPath = join(
    options.parent,
    `.${options.operation.path.split("/").at(-1)!}.agent-teams.rollback.${options.index}.tmp`
  );
  const rollbackIdentity = await prepareRollbackTemporary(coordination, {
    operationPath: options.operation.path,
    path: rollbackPath,
    preimage: options.operation.precondition.acceptedPreimages[options.preimageIndex]!
  });
  await options.faultInjector?.({
    phase: "after-rollback-temporary-created-unbound",
    operationIndex: options.index,
    path: options.operation.path
  });
  await syncDirectoryStrictly(options.parent);
  if (await coordination.pathMatchesRegularFileIdentity(rollbackPath, rollbackIdentity) !== "match") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_CAS_MISMATCH",
      `Rollback temporary changed before durable identity binding: ${options.operation.path}.`
    );
  }
  const journal = transitionKnownFileOperation(
    options.stored.envelope.payload,
    options.index,
    { rollbackTemporaryIdentity: serializeKnownFileIdentity(rollbackIdentity) }
  );
  await persistKnownFileApplyState(options.store, options.stored, journal);
  await options.faultInjector?.({
    phase: "after-rollback-temporary-ready",
    operationIndex: options.index,
    path: options.operation.path
  });
}

export async function retireKnownFileDestination(coordination: Pick<KnownFileCoordination, "readBoundedRegularFile">, options: {
  readonly capture: KnownFileCapture;
  readonly capturedIdentity: Identity;
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
  const retired = await coordination.readBoundedRegularFile(options.capture.paths.retired, 8 * 1024 * 1024);
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
  const stableCaptured = await coordination.readBoundedRegularFile(
    options.capture.paths.captured,
    options.preimage.size
  );
  if (stableCaptured.outcome !== "read" ||
    stableCaptured.linkCount !== 2n ||
    !sameKnownFileIdentity(stableCaptured.identity, options.capturedIdentity) ||
    !matchesKnownFileImage({
      state: "file",
      bytes: stableCaptured.bytes,
      identity: stableCaptured.identity,
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

export async function publishKnownFileLink(options: {
  readonly destination: string;
  readonly operationPath: string;
  readonly temporaryPath: string;
  readonly replacement: boolean;
}): Promise<void> {
  await link(options.temporaryPath, options.destination).catch((error: unknown) => {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_CAS_MISMATCH",
      options.replacement
        ? `Destination appeared during replacement publication: ${options.operationPath}.`
        : `Destination appeared during create CAS: ${options.operationPath}.`,
      { cause: error }
    );
  });
}

export async function unlinkKnownFileTemporary(path: string): Promise<void> {
  await unlink(path);
}
