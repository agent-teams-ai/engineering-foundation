import { opendir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  AbsentFilePublicationError,
  assertTemporaryPathsAbsent,
  classifyExactFilePostimage,
  ownedTemporaryCleanupResiduePrefix,
  publishAbsentFile,
  type OwnedTemporaryCleanupTransitionPort
} from "@agent-teams/repository-mutation/node";
import {
  publishAbsentFile as publishAbsentFileWithFaults
} from "@agent-teams/repository-mutation/qualification";
import type { MaterializeFileOperation } from "../../contract/scaffold-contract.js";
import { sha256Text } from "../../kernel/canonical-json.js";
import { ScaffoldError } from "../../scaffold-error.js";
import {
  assertSafeExistingAncestors,
  ensureSafeParent,
  isContainedPath
} from "./filesystem-path-guard.js";

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

interface FilesystemPublicationOptions {
  readonly cleanupTransition: OwnedTemporaryCleanupTransitionPort;
  readonly faultInjector?: FilesystemPublicationFaultInjector;
}

const maximumDirectoryEntries = 1024;

async function boundedDirectoryNames(parent: string): Promise<readonly string[]> {
  const directory = await opendir(parent);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = await directory.read();
      if (entry === null) {return names;}
      names.push(entry.name);
      if (names.length > maximumDirectoryEntries) {
        throw new ScaffoldError(
          "SCAFFOLD_RECOVERY_REQUIRED",
          "Scaffolding directory contains too many entries to inspect cleanup evidence safely."
        );
      }
    }
  } finally {
    await directory.close();
  }
}

function postimage(operation: MaterializeFileOperation) {
  return {
    bytes: Buffer.from(operation.after.contentBase64, "base64"),
    digest: operation.after.digest,
    mode: 0o644,
    size: operation.after.size
  } as const;
}

export async function classifyFilesystemOperation(
  root: string,
  operation: MaterializeFileOperation
): Promise<FilesystemOperationState> {
  const destination = resolve(root, operation.path);
  if (!isContainedPath(root, destination)) {
    return "conflict";
  }
  const state = await classifyExactFilePostimage(destination, postimage(operation));
  return state === "exact" ? "after" : state;
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

export async function assertNoOwnedCleanupResidue(
  root: string,
  plan: {
    readonly planDigest: string;
    readonly operations: readonly MaterializeFileOperation[];
  }
): Promise<void> {
  for (const operation of plan.operations) {
    const parent = dirname(resolve(root, operation.path));
    const temporary = join(
      parent,
      transactionTemporaryName(plan.planDigest, operation)
    );
    const prefix = ownedTemporaryCleanupResiduePrefix(temporary);
    let entries: string[];
    try {
      entries = [...await boundedDirectoryNames(parent)];
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    if (entries.some((entry) => entry.startsWith(prefix))) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        `Scaffolding owned temporary cleanup residue requires manual recovery: ${operation.path}.`
      );
    }
  }
}

export async function assertTransactionTemporariesAbsent(
  root: string,
  plan: {
    readonly planDigest: string;
    readonly operations: readonly MaterializeFileOperation[];
  }
): Promise<void> {
  await assertNoOwnedCleanupResidue(root, plan);
  try {
    await assertTemporaryPathsAbsent(
      plan.operations.map((operation) => {
        const parent = dirname(resolve(root, operation.path));
        return {
          displayPath: operation.path,
          temporaryPath: join(
            parent,
            transactionTemporaryName(plan.planDigest, operation)
          )
        };
      })
    );
  } catch (error) {
    if (
      error instanceof AbsentFilePublicationError &&
      error.code === "TEMPORARY_EXISTS"
    ) {
      const operationPath = error.message.slice(
        "Temporary path already exists: ".length,
        -1
      );
      throw new ScaffoldError(
        "SCAFFOLD_APPLY_CONFLICT",
        `Scaffolding transaction temporary path already exists: ${operationPath}.`
      );
    }
    throw error;
  }
}

function translatePublicationError(
  error: unknown,
  operation: MaterializeFileOperation
): never {
  if (!(error instanceof AbsentFilePublicationError)) {
    throw error;
  }
  const causeOptions =
    error.cause === undefined ? undefined : { cause: error.cause };
  switch (error.code) {
    case "CONFLICT":
      throw new ScaffoldError(
        "SCAFFOLD_APPLY_CONFLICT",
        `Scaffolding output changed concurrently: ${operation.path}.`,
        [],
        causeOptions
      );
    case "TEMPORARY_EXISTS":
      throw new ScaffoldError(
        "SCAFFOLD_APPLY_CONFLICT",
        `Scaffolding transaction temporary path already exists: ${operation.path}.`,
        [],
        causeOptions
      );
    case "TEMPORARY_REPLACED":
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        `Scaffolding temporary path was replaced concurrently: ${operation.path}.`
      );
    case "CLEANUP_FAILED":
      // Preserve the frozen scaffolding contract: cleanup failures were exposed
      // directly before publication mechanics moved into the neutral kernel.
      throw error.cleanupError;
    case "INVALID_ERROR":
    case "INVALID_POSTIMAGE":
    case "PUBLICATION_INVALID":
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        `Scaffolding publication failed with an invalid error value: ${operation.path}.`
      );
    case "PUBLICATION_INCOMPLETE":
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        `Scaffolding publication did not reach a terminal state: ${operation.path}.`
      );
    case "VERIFICATION_FAILED":
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        `Published scaffolding output failed digest verification: ${operation.path}.`
      );
    case "PUBLICATION_UNSUPPORTED":
      throw error.cause instanceof Error ? error.cause : error;
  }
}

export async function publishFilesystemOperation(
  root: string,
  operation: MaterializeFileOperation,
  planDigest: string,
  operationIndex: number,
  faultInjectorOrOptions?:
    | FilesystemPublicationFaultInjector
    | FilesystemPublicationOptions
): Promise<"already-satisfied" | "applied"> {
  const faultInjector =
    typeof faultInjectorOrOptions === "function"
      ? faultInjectorOrOptions
      : faultInjectorOrOptions?.faultInjector;
  const cleanupTransition =
    typeof faultInjectorOrOptions === "function"
      ? undefined
      : faultInjectorOrOptions?.cleanupTransition;
  await assertSafeExistingAncestors(root, operation.path);
  await assertNoOwnedCleanupResidue(root, {
    planDigest,
    operations: [operation]
  });
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
  const temporary = join(
    parent,
    transactionTemporaryName(planDigest, operation)
  );
  try {
    const publication = {
      allowUnsupportedDirectoryDurability: true,
      destinationPath: destination,
      displayPath: operation.path,
      postimage: postimage(operation),
      temporaryPath: temporary,
      ...(cleanupTransition === undefined
        ? {}
        : { transition: cleanupTransition })
    };
    const outcome = faultInjector === undefined
      ? await publishAbsentFile(publication)
      : await publishAbsentFileWithFaults({
          ...publication,
          faultInjector: async (point) => faultInjector({
            ...point,
            operationIndex,
            operationPath: operation.path
          })
        });
    return outcome === "published" ? "applied" : "already-satisfied";
  } catch (error) {
    translatePublicationError(error, operation);
  }
}
