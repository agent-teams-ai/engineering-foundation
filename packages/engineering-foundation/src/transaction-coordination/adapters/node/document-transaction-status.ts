import type { InternalFoundationTransactionStatus } from "../../application/model/internal-transaction-status.js";

export function pendingDocumentTransaction(options: {
  readonly format?: "document-authoring-envelope-v3" | "document-authoring-envelope-v4";
  readonly foundationVersion: string;
  readonly foundationBuildIdentity: string;
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}): InternalFoundationTransactionStatus {
  const exactBuild = options.foundationVersion === options.installedVersion &&
    options.foundationBuildIdentity === options.installedBuildIdentity;
  return {
    state: "pending",
    operationKind: "document-authoring",
    format: options.format ?? "document-authoring-envelope-v3",
    foundationVersion: options.foundationVersion,
    foundationBuildIdentity: options.foundationBuildIdentity,
    recovery: {
      commandId: "docs-recover",
      exactFoundationVersion: options.foundationVersion,
      exactFoundationBuildIdentity: options.foundationBuildIdentity
    },
    diagnostics: [exactBuild
      ? {
          code: "FOUNDATION_TRANSACTION_ACTIVE",
          message: "A pending document-authoring transaction must be recovered before another Foundation mutation can start."
        }
      : {
          code: "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
          message: `Foundation ${options.foundationVersion} (${options.foundationBuildIdentity}) must recover the pending document-authoring transaction before package ${options.installedVersion} (${options.installedBuildIdentity}) can mutate this repository.`
        }]
  };
}
