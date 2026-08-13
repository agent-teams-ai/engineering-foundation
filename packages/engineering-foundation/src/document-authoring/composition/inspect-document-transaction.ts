import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { installedFoundationVersion } from "../../package-version.js";
import { installedFoundationBuildIdentity } from "../../transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import { NodeFoundationTransactionSlot } from "../../transaction-coordination/adapters/node/node-foundation-transaction-slot.js";
import type { DocumentTransactionInspectionV1 } from "../application/model/document-transaction-inspection.js";

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
  return {
    schemaVersion: 1,
    state: "manual-recovery-required",
    reason: status.state === "manual-recovery-required"
      ? status.reason
      : status.diagnostics[0]?.message ??
        "A foreign Foundation transaction blocks document authoring.",
    ...(kind === undefined ? {} : { operationKind: kind }),
    diagnostics: status.diagnostics,
  };
}

/** Inspects the shared transaction slot without acquiring mutation authority. */
export async function inspectDocumentTransactionV1(
  consumerRoot: string,
): Promise<DocumentTransactionInspectionV1> {
  const root = await realpath(resolve(consumerRoot));
  const status = await new NodeFoundationTransactionSlot({
    consumerRoot: root,
    installedVersion: await installedFoundationVersion(),
    installedBuildIdentity: await installedFoundationBuildIdentity(),
  }).inspect();
  return projectDocumentTransactionInspectionV1(status);
}
