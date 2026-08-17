import type { InternalFoundationTransactionStatus } from "../../application/model/internal-transaction-status.js";
import { assertKnownFileTransactionEnvelope } from "../../../repository-mutation/application/policies/known-file-transaction-envelope.js";

function pendingKnownFileTransaction(options: {
  readonly foundationVersion: string;
  readonly foundationBuildIdentity: string;
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}): InternalFoundationTransactionStatus {
  const exactBuild = options.foundationVersion === options.installedVersion &&
    options.foundationBuildIdentity === options.installedBuildIdentity;
  return {
    state: "pending",
    operationKind: "known-file-transaction",
    format: "known-file-transaction-envelope-v1",
    foundationVersion: options.foundationVersion,
    foundationBuildIdentity: options.foundationBuildIdentity,
    recovery: {
      commandId: "replace-known-file-recover",
      exactFoundationVersion: options.foundationVersion,
      exactFoundationBuildIdentity: options.foundationBuildIdentity
    },
    diagnostics: [{
      code: exactBuild
        ? "FOUNDATION_TRANSACTION_ACTIVE"
        : "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
      message: exactBuild
        ? "A pending known-file transaction must be recovered before another Foundation mutation can start."
        : `Foundation ${options.foundationVersion} (${options.foundationBuildIdentity}) must recover the pending known-file transaction before package ${options.installedVersion} (${options.installedBuildIdentity}) can mutate this repository.`
    }]
  };
}

export function inspectKnownFileTransactionStatus(options: {
  readonly value: Record<string, unknown>;
  readonly schemaVersion: number;
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}): InternalFoundationTransactionStatus | undefined {
  if (options.schemaVersion !== 5) {return undefined;}
  try {
    assertKnownFileTransactionEnvelope(options.value);
  } catch {
    return {
      state: "manual-recovery-required",
      reason: "corrupt-or-incompatible",
      diagnostics: [{
        code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
        message: "The Foundation known-file transaction envelope is corrupt, tampered, or incompatible; it was preserved."
      }]
    };
  }
  return pendingKnownFileTransaction({
    foundationVersion: options.value.foundation.version,
    foundationBuildIdentity: options.value.foundation.buildIdentity,
    installedVersion: options.installedVersion,
    installedBuildIdentity: options.installedBuildIdentity
  });
}
