import { lstat } from "node:fs/promises";
import { join } from "node:path";

import {
  LOCAL_OPERATION_LOCK,
  LOCAL_STATE_DIRECTORY
} from "../../../foundation-state-contract.js";
import { createNodeFoundationTransactionCoordinator } from "../../../transaction-coordination/adapters/node/node-foundation-transaction-coordinator.js";
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
  const [hasOperationLock, status] = await Promise.all([
    operationLockExists(root),
    createNodeFoundationTransactionCoordinator(root).then((coordinator) => coordinator.inspect())
  ]);
  if (status.state !== "idle") {
    const recoverableByInstalledBuild = status.state === "pending" &&
      status.operationKind === "known-file-transaction" &&
      !status.diagnostics.some(({ code }) =>
        code === "FOUNDATION_TRANSACTION_VERSION_MISMATCH"
      );
    return Object.freeze({
      state: "recovery-required",
      code: "KNOWN_FILE_RECOVERY_REQUIRED",
      recoverableByInstalledBuild,
      message: status.diagnostics[0]?.message ??
        "Foundation transaction evidence must be recovered before consumer integration can continue."
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
