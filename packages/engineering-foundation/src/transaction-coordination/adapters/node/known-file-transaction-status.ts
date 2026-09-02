import type { InternalFoundationTransactionStatus } from "../../application/model/internal-transaction-status.js";
import { sha256Json, type CanonicalJsonValue } from "@agent-teams/repository-mutation";

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
  if (options.schemaVersion === 6) {
    const owner = options.value["ownerArtifact"];
    if (typeof owner !== "object" || owner === null || Array.isArray(owner)) {return undefined;}
    const identity = owner as Record<string, unknown>;
    if (typeof identity["version"] !== "string" ||
      typeof identity["buildIdentity"] !== "string") {return undefined;}
    return pendingKnownFileTransaction({
      foundationVersion: identity["version"],
      foundationBuildIdentity: identity["buildIdentity"],
      installedVersion: options.installedVersion,
      installedBuildIdentity: options.installedBuildIdentity
    });
  }
  if (options.schemaVersion !== 5) {return undefined;}
  try {
    const foundation = options.value["foundation"];
    if (typeof foundation !== "object" || foundation === null || Array.isArray(foundation)) {throw new Error("invalid identity");}
    const identity = foundation as Record<string, unknown>;
    const digest = options.value["envelopeDigest"];
    const body = { ...options.value };
    delete body["envelopeDigest"];
    if (Object.keys(identity).toSorted().join(",") !== "buildIdentity,version" ||
      typeof identity["version"] !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(String(identity["buildIdentity"])) ||
      digest !== sha256Json(body as CanonicalJsonValue)) {
      throw new Error("invalid legacy envelope");
    }
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
    foundationVersion: (options.value["foundation"] as Record<string, string>)["version"]!,
    foundationBuildIdentity: (options.value["foundation"] as Record<string, string>)["buildIdentity"]!,
    installedVersion: options.installedVersion,
    installedBuildIdentity: options.installedBuildIdentity
  });
}
