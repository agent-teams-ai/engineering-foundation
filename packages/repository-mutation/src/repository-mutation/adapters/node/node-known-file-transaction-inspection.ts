import type { KnownFileCoordination } from "./known-file-coordination.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { knownFileStateNames } from "../../application/policies/known-file-state-names.js";
import { installedMutationArtifact } from "../../application/policies/known-file-mutation-admission.js";

import { NodeKnownFileTransactionJournalStore } from "./node-known-file-transaction-journal-store.js";
import { canonicalKnownFileRoot, knownFileErrorCode } from "./node-known-file-transaction-filesystem.js";

export type KnownFileTransactionBarrierInspection =
  | { readonly state: "idle" }
  | {
      readonly state: "recovery-required";
      readonly code:
        | "KNOWN_FILE_OPERATION_ACTIVE"
        | "KNOWN_FILE_RECOVERY_REQUIRED";
      readonly recoverableByInstalledBuild: boolean;
      readonly message: string;
    };

async function operationLockExists(root: string): Promise<boolean> {
  try {
    await lstat(join(root, knownFileStateNames.directory, knownFileStateNames.operationLock));
    return true;
  } catch (error) {
    if (knownFileErrorCode(error) === "ENOENT") {return false;}
    throw error;
  }
}

export async function inspectKnownFileTransactionBarrier(coordination: Pick<KnownFileCoordination,
  "assertTerminalEvidenceDirectory"
  | "captureFileHandleIdentity"
  | "ensureTerminalEvidenceDirectory"
  | "installedRepositoryMutationBuildIdentity"
  | "installedRepositoryMutationVersion"
  | "pathMatchesRegularFileIdentity"
  | "readBoundedRegularFile"
>, options: {
  readonly consumerRoot: string;
}): Promise<KnownFileTransactionBarrierInspection> {
  const root = await canonicalKnownFileRoot(options.consumerRoot);
  const hasOperationLock = await operationLockExists(root);
  const artifact = await installedMutationArtifact(coordination);
  let observed;
  try {
    observed = await new NodeKnownFileTransactionJournalStore(coordination,
      join(root, knownFileStateNames.directory), artifact, artifact
    ).read();
  } catch {
    return Object.freeze({
      state: "recovery-required",
      code: "KNOWN_FILE_RECOVERY_REQUIRED",
      recoverableByInstalledBuild: false,
      message: "Unknown, legacy, corrupt, or ambiguous common transaction evidence must be recovered by its exact owner artifact."
    });
  }
  if (observed !== undefined) {
    return Object.freeze({
      state: "recovery-required", code: "KNOWN_FILE_RECOVERY_REQUIRED",
      recoverableByInstalledBuild: true,
      message: "A known-file transaction must be recovered before another mutation."
    });
  }
  if (hasOperationLock) {
    return Object.freeze({
      state: "recovery-required",
      code: "KNOWN_FILE_OPERATION_ACTIVE",
      recoverableByInstalledBuild: false,
      message: "A Foundation operation is active or interrupted; retry after it completes or recover its evidence."
    });
  }
  return Object.freeze({ state: "idle" });
}
