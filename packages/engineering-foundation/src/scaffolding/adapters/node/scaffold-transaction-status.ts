import { canonicalJson, type CanonicalJsonValue } from "@agent-teams/repository-mutation";
import { assertEnvelopeDigests } from "../../../transaction-coordination/adapters/node/legacy-envelope-digests.js";
import type { ScaffoldSchemaValidator } from "../schema-validation.js";
import type {
  AuthorityScaffoldJournal
} from "../../contract/types.js";
import type { FoundationRecoveryRoute, FoundationTransactionDiagnostic } from "../../../transaction-coordination/application/model/transaction-status.js";
import type { InternalFoundationTransactionStatus } from "../../../transaction-coordination/application/model/internal-transaction-status.js";
import { assertLegacyScaffoldingJournal } from "./legacy-scaffolding-transaction-validation.js";
import { parseFoundationScaffoldEnvelope } from "./foundation-scaffold-envelope.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recoveryRoute(exactFoundationVersion: string): FoundationRecoveryRoute {
  return {
    commandId: "scaffold-recover",
    exactFoundationVersion
  };
}

function pending(options: {
  readonly operationKind: "scaffolding";
  readonly format: "foundation-scaffolding-envelope-v6" | "legacy-scaffolding-v1";
  readonly foundationVersion: string;
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}): InternalFoundationTransactionStatus {
  const diagnostics: FoundationTransactionDiagnostic[] = [];
  if (options.foundationVersion !== options.installedVersion) {
    diagnostics.push({
      code: "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
      message: `Foundation ${options.foundationVersion} must recover the pending ${options.operationKind} transaction before package ${options.installedVersion} (${options.installedBuildIdentity}) can mutate this repository.`
    });
  } else {
    diagnostics.push({
      code: "FOUNDATION_TRANSACTION_ACTIVE",
      message: `A pending ${options.operationKind} transaction must be recovered before another Foundation mutation can start.`
    });
  }
  return {
    state: "pending",
    operationKind: options.operationKind,
    format: options.format,
    foundationVersion: options.foundationVersion,
    recovery: recoveryRoute(options.foundationVersion),
    diagnostics
  };
}

export async function inspectLegacyScaffoldingJournal(options: {
  readonly value: Record<string, unknown>;
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}, assertSchema: ScaffoldSchemaValidator): Promise<InternalFoundationTransactionStatus> {
  await assertSchema(
    "scaffold-recovery-journal/v1",
    options.value,
    "foundation-transaction-slot"
  );
  const journal = options.value as unknown as AuthorityScaffoldJournal;
  assertLegacyScaffoldingJournal(options.value);
  const compiler = journal.plan["compiler"];
  if (!isRecord(compiler) || typeof compiler["version"] !== "string") {
    throw new Error("Legacy scaffolding journal compiler version is invalid.");
  }
  return pending({
    operationKind: "scaffolding",
    format: "legacy-scaffolding-v1",
    foundationVersion: compiler["version"],
    installedVersion: options.installedVersion,
    installedBuildIdentity: options.installedBuildIdentity
  });
}

export async function inspectCurrentScaffoldingTransaction(options: {
  readonly bytes: Uint8Array;
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}): Promise<InternalFoundationTransactionStatus> {
  const { envelope } = await parseFoundationScaffoldEnvelope(options.bytes);
  if (envelope.ownerArtifact.version !== options.installedVersion ||
      envelope.ownerArtifact.buildIdentity !== options.installedBuildIdentity) {
    throw new Error("Foundation scaffolding installed artifact identity is incompatible.");
  }
  return {
    state: "pending",
    operationKind: "scaffolding",
    format: "foundation-scaffolding-envelope-v6",
    foundationVersion: options.installedVersion,
    recovery: {
      commandId: "scaffold-recover",
      exactFoundationVersion: options.installedVersion
    },
    diagnostics: [{
      code: "FOUNDATION_TRANSACTION_ACTIVE",
      message: "A pending scaffolding transaction must be recovered before another Foundation mutation can start."
    }]
  };
}

export async function inspectLegacyScaffoldingEnvelope(
  value: Record<string, unknown>,
  assertSchema: ScaffoldSchemaValidator
): Promise<InternalFoundationTransactionStatus> {
  await assertSchema("foundation-transaction-envelope/v2", value, "foundation-transaction-slot");
  assertEnvelopeDigests(value);
  const foundation = value["foundation"];
  const journal = value["journal"];
  if (!isRecord(foundation) || typeof foundation["version"] !== "string" ||
      typeof foundation["buildIdentity"] !== "string" || !isRecord(journal)) {
    throw new Error("Foundation transaction envelope binding is invalid.");
  }
  const plan = journal["plan"];
  if (!isRecord(plan)) {
    throw new Error("Foundation transaction Plan binding is invalid.");
  }
  const compiler = plan["compiler"];
  if (!isRecord(compiler) || compiler["version"] !== foundation["version"]) {
    throw new Error("Foundation transaction compiler binding is invalid.");
  }
  assertLegacyScaffoldingJournal(journal);
  return {
    state: "manual-recovery-required",
    reason: "recovery-handler-unavailable",
    operationKind: "scaffolding",
    format: "envelope-v2",
    foundationVersion: foundation["version"],
    foundationBuildIdentity: foundation["buildIdentity"],
    diagnostics: [{
      code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
      message: `A verified scaffolding envelope v2 from Foundation ${foundation["version"]} (${foundation["buildIdentity"]}) was preserved, but this release does not yet provide its recovery handler.`
    }]
  };
}

export function inspectCurrentScaffoldingRecord(input: {
  readonly value: Record<string, unknown>;
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}): Promise<InternalFoundationTransactionStatus> {
  return inspectCurrentScaffoldingTransaction({
    bytes: Buffer.from(canonicalJson(input.value as CanonicalJsonValue), "utf8"),
    installedVersion: input.installedVersion,
    installedBuildIdentity: input.installedBuildIdentity
  });
}
