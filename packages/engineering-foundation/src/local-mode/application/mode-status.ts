import type { FoundationLinkState, FoundationTransactionAwareStatus, FoundationTransactionStatus } from "./model.js";
import type { InternalFoundationTransactionStatus } from "../../transaction-coordination/application/model/internal-transaction-status.js";

export interface InstalledFoundation {
  readonly root?: string;
  readonly version?: string;
}

export function buildStatus(input: {
  readonly consumerRoot: string;
  readonly dependencySpec?: string;
  readonly installed: InstalledFoundation;
  readonly provenance?: { readonly lockfilePath: string; readonly packageKey: string; readonly integrity: string };
  readonly linkState?: FoundationLinkState;
  readonly transaction?: FoundationTransactionStatus;
  readonly issues: readonly string[];
}): FoundationTransactionAwareStatus {
  return {
    mode: input.issues.length === 0
      ? input.linkState === undefined ? "REGISTRY" : "LOCAL"
      : "INVALID",
    consumerRoot: input.consumerRoot,
    ...(input.dependencySpec === undefined ? {} : { dependencySpec: input.dependencySpec }),
    ...(input.installed.root === undefined ? {} : { installedPackageRoot: input.installed.root }),
    ...(input.installed.version === undefined ? {} : { installedVersion: input.installed.version }),
    ...(input.provenance === undefined
      ? {}
      : {
          lockfilePath: input.provenance.lockfilePath,
          lockfilePackageKey: input.provenance.packageKey,
          registryIntegrity: input.provenance.integrity
        }),
    ...(input.linkState === undefined ? {} : { linkState: input.linkState }),
    ...(input.transaction === undefined ? {} : { transaction: input.transaction }),
    issues: input.issues
  };
}

export function projectPublicTransactionStatus(
  status: InternalFoundationTransactionStatus
): FoundationTransactionStatus {
  if (
    status.state === "pending" &&
    status.operationKind === "known-file-transaction"
  ) {
    return status;
  }
  if (
    status.state === "pending" &&
    status.operationKind === "document-authoring"
  ) {
    return {
      state: "manual-recovery-required",
      reason: "recovery-handler-unavailable",
      operationKind: "document-authoring",
      diagnostics: status.diagnostics
    };
  }
  if (status.state === "manual-recovery-required") {
    if (
      status.reason === "journal-transition-residue" ||
      status.reason === "physical-identity-unverifiable" ||
      status.format === "envelope-v3" ||
      status.format === "envelope-v4" ||
      status.format === "known-file-transaction-envelope-v1"
    ) {
      return {
        state: "manual-recovery-required",
        reason: "recovery-handler-unavailable",
        ...(status.operationKind === undefined
          ? {}
          : { operationKind: status.operationKind }),
        diagnostics: status.diagnostics
      };
    }
    return {
      state: "manual-recovery-required",
      reason: status.reason,
      ...(status.operationKind === undefined
        ? {}
        : { operationKind: status.operationKind }),
      ...(status.format === undefined ? {} : { format: status.format }),
      ...(status.foundationVersion === undefined
        ? {}
        : { foundationVersion: status.foundationVersion }),
      ...(status.foundationBuildIdentity === undefined
        ? {}
        : { foundationBuildIdentity: status.foundationBuildIdentity }),
      diagnostics: status.diagnostics
    };
  }
  return status;
}

