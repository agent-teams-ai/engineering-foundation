import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  FOUNDATION_TRANSACTION_FILE,
  LOCAL_STATE_DIRECTORY,
} from "../../foundation-state-contract.js";
import { installedFoundationVersion } from "../../package-version.js";
import { installedFoundationBuildIdentity } from "../../transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import { NodeFoundationTransactionSlot } from "../../transaction-coordination/adapters/node/node-foundation-transaction-slot.js";
import type { DocumentTransactionInspectionV1 } from "../application/model/document-transaction-inspection.js";
import { recaptureDocumentPublicationPaths } from "../adapters/node/recapture-document-publication-paths.js";

type ObservedTransactionStatus = Awaited<
  ReturnType<NodeFoundationTransactionSlot["inspect"]>
>;

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key) as unknown
    : undefined;
}

function isExactDocumentRecovery(
  status: ObservedTransactionStatus,
): status is Extract<ObservedTransactionStatus, {
  readonly state: "pending";
  readonly operationKind: "document-authoring";
}> {
  return status.state === "pending" &&
    status.operationKind === "document-authoring" &&
    property(status, "format") === "document-authoring-envelope-v3" &&
    property(property(status, "recovery"), "commandId") === "docs-recover" &&
    status.recovery.exactFoundationVersion === status.foundationVersion &&
    status.recovery.exactFoundationBuildIdentity === status.foundationBuildIdentity &&
    !status.diagnostics.some(
      ({ code }) => code === "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
    );
}

function operationKind(status: Exclude<ObservedTransactionStatus, {
  readonly state: "idle";
}>): "document-authoring" | "local-mode" | "scaffolding" | undefined {
  return property(status, "operationKind") as
    | "document-authoring"
    | "local-mode"
    | "scaffolding"
    | undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  const candidate = property(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function hasVersionMismatch(status: Exclude<ObservedTransactionStatus, {
  readonly state: "idle";
}>): boolean {
  return status.diagnostics.some(
    ({ code }) => code === "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
  );
}

function transactionKind(
  status: Exclude<ObservedTransactionStatus, { readonly state: "idle" }>,
): Exclude<DocumentTransactionInspectionV1, {
  readonly state: "idle" | "recoverable";
}>["transactionKind"] & {} {
  if (hasVersionMismatch(status)) {
    return "version-mismatch";
  }
  if (status.state === "pending") {
    switch (status.operationKind) {
      case "document-authoring": return "document";
      case "local-mode": return "local-mode";
      case "scaffolding": return "scaffold";
    }
  }
  switch (status.reason) {
    case "journal-transition-residue":
    case "orphan-temporary": return "transition-residue";
    case "corrupt-or-incompatible":
    case "invalid-slot":
    case "local-mode-evidence-invalid":
    case "physical-identity-unverifiable":
    case "unstable-slot": return "corrupt";
    case "unsupported-schema": return "version-mismatch";
    case "recovery-handler-unavailable":
      switch (status.operationKind) {
        case "document-authoring": return "document";
        case "scaffolding": return "scaffold";
        case undefined: return "unknown";
      }
      return "unknown";
    case "multiple-transactions": return "unknown";
  }
}

function exactRecovery(
  status: Exclude<ObservedTransactionStatus, { readonly state: "idle" }>,
): Extract<DocumentTransactionInspectionV1, {
  readonly state: "manual-recovery-required";
}>["recovery"] {
  const recovery = property(status, "recovery");
  const commandId = stringProperty(recovery, "commandId");
  if (commandId === "detach") {
    return { commandId, args: {} };
  }
  if (commandId !== "docs-recover" && commandId !== "scaffold-recover") {
    return undefined;
  }
  const exactFoundationVersion = stringProperty(recovery, "exactFoundationVersion");
  if (exactFoundationVersion === undefined) {
    return undefined;
  }
  const exactFoundationBuildIdentity =
    stringProperty(recovery, "exactFoundationBuildIdentity");
  return {
    commandId,
    args: {
      exactFoundationVersion,
      ...(exactFoundationBuildIdentity === undefined
        ? {} : { exactFoundationBuildIdentity }),
    },
  };
}

export function projectDocumentTransactionInspectionV1(
  status: ObservedTransactionStatus,
): DocumentTransactionInspectionV1 {
  if (status.state === "idle") {
    return { schemaVersion: 1, state: "idle", diagnostics: [] };
  }
  if (isExactDocumentRecovery(status)) {
    return {
      schemaVersion: 1,
      state: "recoverable",
      operationKind: "document-authoring",
      format: status.format,
      foundationVersion: status.foundationVersion,
      foundationBuildIdentity: status.foundationBuildIdentity,
      recovery: status.recovery,
      diagnostics: status.diagnostics,
    };
  }
  const kind = operationKind(status);
  const format = stringProperty(status, "format");
  const foundationVersion = stringProperty(status, "foundationVersion");
  const foundationBuildIdentity = stringProperty(
    status,
    "foundationBuildIdentity",
  );
  const recovery = exactRecovery(status);
  return {
    schemaVersion: 1,
    state: "manual-recovery-required",
    reason: status.state === "manual-recovery-required"
      ? status.reason
      : status.diagnostics[0]?.message ??
        "A foreign Foundation transaction blocks document authoring.",
    ...(kind === undefined ? {} : { operationKind: kind }),
    transactionKind: transactionKind(status),
    ...(format === undefined ? {} : { format }),
    ...(foundationVersion === undefined ? {} : { foundationVersion }),
    ...(foundationBuildIdentity === undefined
      ? {} : { foundationBuildIdentity }),
    ...(recovery === undefined ? {} : { recovery }),
    diagnostics: status.diagnostics,
  };
}

/** Inspects the shared transaction slot without acquiring mutation authority. */
export async function inspectDocumentTransactionV1(
  consumerRoot: string,
): Promise<DocumentTransactionInspectionV1> {
  const root = await realpath(resolve(consumerRoot));
  const stateDirectory = join(root, LOCAL_STATE_DIRECTORY);
  try {
    await lstat(stateDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, state: "idle", diagnostics: [] };
    }
    return unsafeTransactionPathInspection();
  }
  try {
    // Reuse the writer's strict real-directory ancestry recapture. This rejects
    // redirected state directories, portable aliases, and roots that escape the
    // canonical consumer root before the shared slot is allowed to read evidence.
    await recaptureDocumentPublicationPaths({
      consumerRoot: root,
      destination: `${LOCAL_STATE_DIRECTORY}/${FOUNDATION_TRANSACTION_FILE}`,
    });
  } catch {
    return unsafeTransactionPathInspection();
  }
  const status = await new NodeFoundationTransactionSlot({
    consumerRoot: root,
    installedVersion: await installedFoundationVersion(),
    installedBuildIdentity: await installedFoundationBuildIdentity(),
  }).inspect();
  return projectDocumentTransactionInspectionV1(status);
}

function unsafeTransactionPathInspection(): DocumentTransactionInspectionV1 {
  return {
    schemaVersion: 1,
    state: "manual-recovery-required",
    reason: "Foundation transaction evidence path is redirected or cannot be inspected safely.",
    transactionKind: "corrupt",
    diagnostics: [{
      code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
      message: "Foundation transaction evidence path is redirected or cannot be inspected safely.",
    }],
  };
}
