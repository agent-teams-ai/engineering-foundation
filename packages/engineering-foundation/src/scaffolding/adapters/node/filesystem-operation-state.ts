import { link, lstat, open, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { MaterializeFileOperation } from "../../contract/scaffold-contract.js";
import { sha256Bytes, sha256Text } from "../../kernel/canonical-json.js";
import { ScaffoldError } from "../../scaffold-error.js";
import {
  assertSafeExistingAncestors,
  ensureSafeParent,
  isContainedPath,
  syncDirectory
} from "./filesystem-path-guard.js";
import {
  captureFileHandleIdentity,
  pathMatchesFileIdentity,
  readBoundedRegularFile,
  type PortableFileIdentity
} from "./filesystem-file-identity.js";

export type FilesystemOperationState = "absent" | "after" | "conflict";

interface FilesystemPublicationFaultPoint {
  readonly phase:
    | "after-hard-link"
    | "after-temporary-synced"
    | "after-temporary-written";
  readonly operationIndex: number;
  readonly operationPath: string;
}

export type FilesystemPublicationFaultInjector = (
  point: FilesystemPublicationFaultPoint
) => Promise<void> | void;

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

export async function classifyFilesystemOperation(
  root: string,
  operation: MaterializeFileOperation
): Promise<FilesystemOperationState> {
  const destination = resolve(root, operation.path);
  if (!isContainedPath(root, destination)) {
    return "conflict";
  }
  try {
    const result = await readBoundedRegularFile(
      destination,
      operation.after.size
    );
    if (result.outcome !== "read") {
      return "conflict";
    }
    const modeMatches =
      process.platform === "win32" || (result.mode & 0o777) === 0o644;
    return sha256Bytes(result.bytes) === operation.after.digest && modeMatches
      ? "after"
      : "conflict";
  } catch (error) {
    if (isMissing(error)) {
      return "absent";
    }
    throw error;
  }
}

function transactionTemporaryName(
  planDigest: string,
  operation: MaterializeFileOperation
): string {
  const identity = sha256Text(`${planDigest}:${operation.id}`).slice(
    "sha256:".length
  );
  return `.foundation-${identity}.tmp`;
}

export async function removeTransactionTemporary(
  root: string,
  planDigest: string,
  operation: MaterializeFileOperation
): Promise<void> {
  await assertSafeExistingAncestors(root, operation.path);
  const parent = dirname(resolve(root, operation.path));
  const temporary = join(parent, transactionTemporaryName(planDigest, operation));
  try {
    const metadata = await lstat(temporary);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        `Scaffolding temporary path is not a file: ${operation.path}.`
      );
    }
    await rm(temporary, { force: true });
    await syncDirectory(parent);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

export async function assertTransactionTemporariesAbsent(
  root: string,
  plan: { readonly planDigest: string; readonly operations: readonly MaterializeFileOperation[] }
): Promise<void> {
  for (const operation of plan.operations) {
    const parent = dirname(resolve(root, operation.path));
    const temporary = join(
      parent,
      transactionTemporaryName(plan.planDigest, operation)
    );
    const metadata = await lstat(temporary).catch((error: unknown) => {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    });
    if (metadata !== null) {
      throw new ScaffoldError(
        "SCAFFOLD_APPLY_CONFLICT",
        `Scaffolding transaction temporary path already exists: ${operation.path}.`
      );
    }
  }
}

export async function publishFilesystemOperation(
  root: string,
  operation: MaterializeFileOperation,
  planDigest: string,
  operationIndex: number,
  faultInjector?: FilesystemPublicationFaultInjector
): Promise<"already-satisfied" | "applied"> {
  await assertSafeExistingAncestors(root, operation.path);
  const state = await classifyFilesystemOperation(root, operation);
  if (state === "after") {
    return "already-satisfied";
  }
  if (state === "conflict") {
    throw new ScaffoldError(
      "SCAFFOLD_APPLY_CONFLICT",
      `Scaffolding output changed concurrently: ${operation.path}.`
    );
  }
  const parent = await ensureSafeParent(root, operation.path);
  const destination = join(parent, basename(operation.path));
  const temporary = join(parent, transactionTemporaryName(planDigest, operation));
  const bytes = Buffer.from(operation.after.contentBase64, "base64");
  let temporaryIdentity: PortableFileIdentity | undefined;
  let concurrentSatisfied = false;
  let published = false;
  let publicationError: unknown;
  try {
    const handle = await open(temporary, "wx", 0o600).catch((error: unknown) => {
      if (hasErrorCode(error, "EEXIST")) {
        throw new ScaffoldError(
          "SCAFFOLD_APPLY_CONFLICT",
          `Scaffolding transaction temporary path already exists: ${operation.path}.`,
          [],
          { cause: error }
        );
      }
      throw error;
    });
    try {
      await handle.writeFile(bytes);
      await faultInjector?.({
        phase: "after-temporary-written",
        operationIndex,
        operationPath: operation.path
      });
      await handle.chmod(0o644);
      await handle.sync();
      temporaryIdentity = await captureFileHandleIdentity(handle);
    } finally {
      await handle.close();
    }
    await faultInjector?.({
      phase: "after-temporary-synced",
      operationIndex,
      operationPath: operation.path
    });
    try {
      await link(temporary, destination);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        const concurrentState = await classifyFilesystemOperation(root, operation);
        if (concurrentState === "after") {
          concurrentSatisfied = true;
        } else {
          throw new ScaffoldError(
            "SCAFFOLD_APPLY_CONFLICT",
            `Scaffolding output changed concurrently: ${operation.path}.`,
            [],
            { cause: error }
          );
        }
      } else {
        throw error;
      }
    }
    if (!concurrentSatisfied) {
      published = true;
      await faultInjector?.({
        phase: "after-hard-link",
        operationIndex,
        operationPath: operation.path
      });
      await syncDirectory(parent);
    }
  } catch (error) {
    publicationError = error;
  }
  const temporaryOwnership =
    temporaryIdentity === undefined
      ? "missing"
      : await pathMatchesFileIdentity(temporary, temporaryIdentity);
  if (temporaryOwnership === "match") {
    await rm(temporary);
    await syncDirectory(parent);
  } else if (temporaryOwnership === "different") {
    throw new ScaffoldError(
      "SCAFFOLD_RECOVERY_REQUIRED",
      `Scaffolding temporary path was replaced concurrently: ${operation.path}.`
    );
  }
  if (publicationError !== undefined) {
    if (!(publicationError instanceof Error)) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        `Scaffolding publication failed with an invalid error value: ${operation.path}.`
      );
    }
    throw publicationError;
  }
  if (concurrentSatisfied) {
    return "already-satisfied";
  }
  if (!published) {
    throw new ScaffoldError(
      "SCAFFOLD_RECOVERY_REQUIRED",
      `Scaffolding publication did not reach a terminal state: ${operation.path}.`
    );
  }
  if ((await classifyFilesystemOperation(root, operation)) !== "after") {
    throw new ScaffoldError(
      "SCAFFOLD_RECOVERY_REQUIRED",
      `Published scaffolding output failed digest verification: ${operation.path}.`
    );
  }
  return "applied";
}

export async function classifyFilesystemPlan(
  root: string,
  plan: { readonly operations: readonly MaterializeFileOperation[] }
): Promise<readonly {
  readonly operation: MaterializeFileOperation;
  readonly state: FilesystemOperationState;
}[]> {
  return Promise.all(
    plan.operations.map(async (operation) => ({
      operation,
      state: await classifyFilesystemOperation(root, operation)
    }))
  );
}
