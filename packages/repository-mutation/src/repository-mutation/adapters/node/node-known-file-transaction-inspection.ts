import { lstat } from "node:fs/promises";
import { join } from "node:path";

import {
  LOCAL_OPERATION_LOCK,
  LOCAL_STATE_DIRECTORY
} from "../../../state-contract.js";
import { installedRepositoryMutationBuildIdentity } from "../../../installed-artifact-identity.js";
import { installedRepositoryMutationVersion, REPOSITORY_MUTATION_PACKAGE_NAME } from "../../../package-version.js";
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
    await lstat(join(root, LOCAL_STATE_DIRECTORY, LOCAL_OPERATION_LOCK));
    return true;
  } catch (error) {
    if (knownFileErrorCode(error) === "ENOENT") {return false;}
    throw error;
  }
}

export async function inspectKnownFileTransactionBarrier(options: {
  readonly consumerRoot: string;
}): Promise<KnownFileTransactionBarrierInspection> {
  const root = await canonicalKnownFileRoot(options.consumerRoot);
  const hasOperationLock = await operationLockExists(root);
  let observed;
  try {
    observed = await new NodeKnownFileTransactionJournalStore(join(root, LOCAL_STATE_DIRECTORY)).read();
  } catch {
    return Object.freeze({
      state: "recovery-required",
      code: "KNOWN_FILE_RECOVERY_REQUIRED",
      recoverableByInstalledBuild: false,
      message: "Unknown, legacy, corrupt, or ambiguous common transaction evidence must be recovered by its exact owner artifact."
    });
  }
  if (observed !== undefined) {
    const [version, buildIdentity] = await Promise.all([
      installedRepositoryMutationVersion(), installedRepositoryMutationBuildIdentity()
    ]);
    const exact = [observed.envelope.ownerArtifact, observed.envelope.kernelArtifact].every((artifact) =>
      artifact.name === REPOSITORY_MUTATION_PACKAGE_NAME && artifact.version === version && artifact.buildIdentity === buildIdentity);
    return Object.freeze({
      state: "recovery-required", code: "KNOWN_FILE_RECOVERY_REQUIRED",
      recoverableByInstalledBuild: exact,
      message: exact ? "A known-file transaction must be recovered before another mutation."
        : "The exact owner and kernel artifacts that created the transaction must recover it."
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
