import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import {
  FOUNDATION_TRANSACTION_FILE,
  FOUNDATION_LINK_STATE_FILE,
  FOUNDATION_REGISTRY_BACKUP,
  KNOWN_FILE_TRANSACTION_TEMPORARY_FILE,
  LOCAL_STATE_DIRECTORY
} from "../../../foundation-state-contract.js";
import { assertSchema } from "../../../schema-catalog.js";
import { sha256Json as sha256DocumentJson } from "../../../canonical-json.js";
import type {
  AuthorityScaffoldJournal,
  JsonValue
} from "../../../scaffolding/contract/types.js";
import { assertAuthorityScaffoldJournal } from "../../../scaffolding/kernel/authority-journal-validation.js";
import { parseStrictJson } from "../../../strict-json.js";
import type {
  FoundationRecoveryRoute,
  FoundationTransactionDiagnostic
} from "../../application/model/transaction-status.js";
import type {
  InternalFoundationManualRecoveryReason,
  InternalFoundationTransactionStatus
} from "../../application/model/internal-transaction-status.js";
import type { FoundationTransactionSlot } from "../../application/ports/foundation-transaction-slot.js";
import { readBoundedRegularFile } from "@agent-teams/repository-mutation/node";
import { portableRepositoryPathIdentity } from "@agent-teams/repository-mutation";
import {
  assertLegacyDocumentEnvelope,
  legacyFoundationEnvelopeSha256Json,
  isKnownLegacyDocumentEnvelope
} from "./legacy-document-envelope-v2.js";
import {
  inspectCurrentDocumentEnvelope,
  inspectDocumentTransactionBindings
} from "./document-envelope-bindings.js";
import { inspectFoundationTransitionEvidence } from "./foundation-transition-evidence.js";
import { inspectKnownFileTransactionStatus } from "./known-file-transaction-status.js";
import { pendingDocumentTransaction } from "./document-transaction-status.js";
import { inspectSchema6TransactionStatus } from "./schema6-transaction-status.js";

const maximumTransactionBytes = 32 * 1024 * 1024;
const maximumLinkStateBytes = 64 * 1024;
const maximumStateDirectoryEntries = 1024;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manual(
  reason: InternalFoundationManualRecoveryReason,
  message: string
): InternalFoundationTransactionStatus {
  return {
    state: "manual-recovery-required",
    reason,
    diagnostics: [
      {
        code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
        message
      }
    ]
  };
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

function localModePending(message: string): InternalFoundationTransactionStatus {
  return {
    state: "pending",
    operationKind: "local-mode",
    format: "local-mode-v1",
    recovery: { commandId: "detach" },
    diagnostics: [{ code: "FOUNDATION_TRANSACTION_ACTIVE", message }]
  };
}

function parseLinkPhase(value: unknown): "ATTACHING" | "DETACHING" | "LOCAL" {
  if (!isRecord(value)) {
    throw new Error("Foundation local-mode recovery state is invalid.");
  }
  const expectedKeys = [
    "attachedAt",
    "consumerRoot",
    "gitCommit",
    "gitDirty",
    "packageVersion",
    "phase",
    "registryBackupPath",
    "registryEntryKind",
    "registryPackageRoot",
    "schemaVersion",
    "targetPackageRoot"
  ];
  if (
    value["schemaVersion"] !== 1 ||
    !["ATTACHING", "DETACHING", "LOCAL"].includes(String(value["phase"])) ||
    typeof value["consumerRoot"] !== "string" ||
    typeof value["targetPackageRoot"] !== "string" ||
    typeof value["registryBackupPath"] !== "string" ||
    !["directory", "symbolic-link"].includes(String(value["registryEntryKind"])) ||
    typeof value["registryPackageRoot"] !== "string" ||
    typeof value["packageVersion"] !== "string" ||
    typeof value["gitCommit"] !== "string" ||
    typeof value["gitDirty"] !== "boolean" ||
    typeof value["attachedAt"] !== "string" ||
    Object.keys(value).toSorted().join(",") !== expectedKeys.join(",")
  ) {
    throw new Error("Foundation local-mode recovery state is invalid.");
  }
  return value["phase"] as "ATTACHING" | "DETACHING" | "LOCAL";
}

async function inspectLocalModeEvidence(
  stateDirectory: string
): Promise<InternalFoundationTransactionStatus> {
  let entries: string[] = [];
  try {
    const directory = await opendir(stateDirectory);
    try {
      for (;;) {
        const entry = await directory.read();
        if (entry === null) {
          break;
        }
        entries.push(entry.name);
        if (entries.length > maximumStateDirectoryEntries) {
          throw new Error("Foundation local-mode state enumeration budget exceeded.");
        }
      }
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (isMissing(error)) {
      return { state: "idle", diagnostics: [] };
    }
    return manual(
      "local-mode-evidence-invalid",
      "Foundation local-mode recovery evidence cannot be inspected safely."
    );
  }
  const linkIdentity = portableRepositoryPathIdentity(FOUNDATION_LINK_STATE_FILE);
  const backupIdentity = portableRepositoryPathIdentity(FOUNDATION_REGISTRY_BACKUP);
  if (entries.some((entry) =>
    (portableRepositoryPathIdentity(entry) === linkIdentity && entry !== FOUNDATION_LINK_STATE_FILE) ||
    (portableRepositoryPathIdentity(entry) === backupIdentity && entry !== FOUNDATION_REGISTRY_BACKUP))) {
    return manual(
      "local-mode-evidence-invalid",
      "Foundation local-mode state contains a case or Unicode alias."
    );
  }
  if (
    entries.some(
      (entry) =>
        entry.startsWith(`${FOUNDATION_LINK_STATE_FILE}.`) &&
        entry.endsWith(".tmp")
    )
  ) {
    return manual(
      "local-mode-evidence-invalid",
      "An incomplete Foundation local-mode state write requires manual recovery."
    );
  }
  const hasBackup = entries.includes(FOUNDATION_REGISTRY_BACKUP);
  if (!entries.includes(FOUNDATION_LINK_STATE_FILE)) {
    return hasBackup
      ? localModePending(
          "An orphan Foundation registry backup must be recovered with detach before another mutation can start."
        )
      : { state: "idle", diagnostics: [] };
  }
  try {
    const record = await readBoundedRegularFile(
      join(stateDirectory, FOUNDATION_LINK_STATE_FILE),
      maximumLinkStateBytes
    );
    if (record.outcome !== "read") {
      throw new Error("Foundation local-mode state is not a stable regular file.");
    }
    const phase = parseLinkPhase(
      parseStrictJson(strictUtf8.decode(record.bytes))
    );
    if (phase === "LOCAL" && hasBackup) {
      return { state: "idle", diagnostics: [] };
    }
    return localModePending(
      `Foundation local-mode recovery is required (${phase}${hasBackup ? "" : ", registry backup missing"}) before another mutation can start.`
    );
  } catch {
    return manual(
      "local-mode-evidence-invalid",
      "Foundation local-mode recovery evidence is invalid and was preserved."
    );
  }
}

function assertEnvelopeDigests(envelope: Record<string, unknown>): void {
  const sha256EnvelopeJson = (value: unknown): string =>
    envelope["operationKind"] === "scaffolding"
      ? legacyFoundationEnvelopeSha256Json(value)
      : sha256DocumentJson(value as JsonValue);
  const journal = envelope["journal"];
  if (envelope["payloadDigest"] !== sha256EnvelopeJson(journal as JsonValue)) {
    throw new Error("Foundation transaction payload digest is invalid.");
  }
  const { envelopeDigest, ...body } = envelope;
  if (envelopeDigest !== sha256EnvelopeJson(body as JsonValue)) {
    throw new Error("Foundation transaction envelope digest is invalid.");
  }
}

function normalizeLegacyScaffoldingValue(value: unknown): unknown {
  if (typeof value === "number") {
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    return value.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
  }
  if (Array.isArray(value)) {
    return value.map(normalizeLegacyScaffoldingValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, normalizeLegacyScaffoldingValue(item)
    ]));
  }
  return value;
}

function assertLegacyScaffoldingJournal(journal: Record<string, unknown>): void {
  const plan = journal["plan"];
  if (!isRecord(plan)) {
    throw new Error("Legacy scaffolding Plan binding is invalid.");
  }
  const { planDigest, ...body } = plan;
  if (planDigest !== legacyFoundationEnvelopeSha256Json(body)) {
    throw new Error("Legacy scaffolding Plan digest is invalid.");
  }
  const normalized = normalizeLegacyScaffoldingValue(journal) as AuthorityScaffoldJournal;
  const { planDigest: _normalizedDigest, ...normalizedBody } = normalized.plan;
  (normalized as unknown as { plan: { planDigest: string } }).plan.planDigest =
    sha256DocumentJson(normalizedBody as unknown as JsonValue);
  assertAuthorityScaffoldJournal(normalized);
}

async function inspectLegacyScaffoldingJournal(options: {
  readonly value: Record<string, unknown>;
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}): Promise<InternalFoundationTransactionStatus> {
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

function transactionSchemaVersion(value: Record<string, unknown>): number {
  const schemaVersion = value["schemaVersion"];
  return typeof schemaVersion === "number" ? schemaVersion : Number.NaN;
}

function inspectUnsupportedTransaction(options: {
  readonly value: Record<string, unknown>;
  readonly schemaVersion: number;
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}): InternalFoundationTransactionStatus {
  return inspectKnownFileTransactionStatus(options) ?? manual(
    "unsupported-schema",
    `Foundation transaction schema version ${String(options.schemaVersion)} is unsupported and was preserved.`
  );
}

async function inspectParsedTransaction(
  value: unknown,
  installedVersion: string,
  installedBuildIdentity: string
): Promise<InternalFoundationTransactionStatus> {
  if (!isRecord(value)) {
    return manual(
      "invalid-slot",
      "The Foundation transaction slot is invalid and was preserved."
    );
  }
  const schemaVersion = transactionSchemaVersion(value);
  switch (schemaVersion) {
  case 1:
    return inspectLegacyScaffoldingJournal({
      value,
      installedVersion,
      installedBuildIdentity
    });
  case 3:
    return inspectCurrentDocumentEnvelope({
      value, installedVersion, installedBuildIdentity, pending: pendingDocumentTransaction
    });
  case 4:
    return inspectCurrentDocumentEnvelope({
      value,
      installedVersion,
      installedBuildIdentity,
      pending: (identity) => pendingDocumentTransaction({
        ...identity,
        format: "document-authoring-envelope-v4"
      })
    });
  case 6: {
    return inspectSchema6TransactionStatus({
      value,
      installedFoundationVersion: installedVersion,
      installedFoundationBuildIdentity: installedBuildIdentity
    });
  }
  case 2: {
    const legacyDocumentEnvelope = isKnownLegacyDocumentEnvelope(value);
    if (legacyDocumentEnvelope) {
      assertLegacyDocumentEnvelope(value);
    } else {
      await assertSchema(
        "foundation-transaction-envelope/v2",
        value,
        "foundation-transaction-slot"
      );
      assertEnvelopeDigests(value);
    }
    const foundation = value["foundation"];
    const operationKind = value["operationKind"];
    const journal = value["journal"];
    if (
      !isRecord(foundation) ||
      typeof foundation["version"] !== "string" ||
      typeof foundation["buildIdentity"] !== "string" ||
      !isRecord(journal) ||
      !["document-authoring", "scaffolding"].includes(String(operationKind))
    ) {
      throw new Error("Foundation transaction envelope binding is invalid.");
    }
    const plan = journal["plan"];
    if (!isRecord(plan)) {
      throw new Error("Foundation transaction Plan binding is invalid.");
    }
    const compiler = plan["compiler"];
    if (
      !isRecord(compiler) ||
      compiler["version"] !== foundation["version"] ||
      (operationKind === "document-authoring" &&
        compiler["buildIdentity"] !== foundation["buildIdentity"])
    ) {
      throw new Error("Foundation transaction compiler binding is invalid.");
    }
    if (operationKind === "document-authoring") {
      const documentStatus = inspectDocumentTransactionBindings({
        foundation,
        journal,
        journalVersion: 1,
        legacyDigestSemantics: legacyDocumentEnvelope,
        plan,
        state: value["state"]
      });
      if (documentStatus !== undefined) {
        return documentStatus;
      }
    } else {
      assertLegacyScaffoldingJournal(journal);
    }
    return {
      state: "manual-recovery-required",
      reason: "recovery-handler-unavailable",
      operationKind: operationKind as "document-authoring" | "scaffolding",
      format: "envelope-v2",
      foundationVersion: foundation["version"],
      foundationBuildIdentity: foundation["buildIdentity"],
      diagnostics: [
        {
          code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
          message: `A verified ${String(operationKind)} envelope v2 from Foundation ${foundation["version"]} (${foundation["buildIdentity"]}) was preserved, but this release does not yet provide its recovery handler.`
        }
      ]
    };
  }
  default:
    return inspectUnsupportedTransaction({
      value,
      schemaVersion,
      installedVersion,
      installedBuildIdentity
    });
  }
}

export class NodeFoundationTransactionSlot implements FoundationTransactionSlot {
  readonly #installedBuildIdentity: string;
  readonly #installedVersion: string;
  readonly #stateDirectory: string;
  readonly #slotPath: string;
  readonly #knownFileTemporaryPath: string;

  constructor(options: {
    readonly consumerRoot: string;
    readonly installedBuildIdentity: string;
    readonly installedVersion: string;
  }) {
    this.#installedBuildIdentity = options.installedBuildIdentity;
    this.#installedVersion = options.installedVersion;
    const stateDirectory = join(options.consumerRoot, LOCAL_STATE_DIRECTORY);
    this.#stateDirectory = stateDirectory;
    this.#slotPath = join(stateDirectory, FOUNDATION_TRANSACTION_FILE);
    this.#knownFileTemporaryPath = join(
      stateDirectory,
      KNOWN_FILE_TRANSACTION_TEMPORARY_FILE
    );
  }

  async #inspectTransactionEvidence(): Promise<InternalFoundationTransactionStatus> {
    const transitionEvidence = await inspectFoundationTransitionEvidence(
      this.#stateDirectory
    );
    if (transitionEvidence !== undefined) {
      return transitionEvidence;
    }
    let record;
    try {
      record = await readBoundedRegularFile(
        this.#slotPath,
        maximumTransactionBytes
      );
    } catch (error) {
      if (isMissing(error)) {
        try {
          record = await readBoundedRegularFile(
            this.#knownFileTemporaryPath,
            maximumTransactionBytes
          );
        } catch (temporaryError) {
          if (isMissing(temporaryError)) {
            return { state: "idle", diagnostics: [] };
          }
          return manual(
            "invalid-slot",
            "The Foundation known-file transaction transition could not be read safely and was preserved."
          );
        }
        if (record.outcome !== "read") {
          return manual(
            "unstable-slot",
            "The Foundation known-file transaction transition is not a stable bounded regular file and was preserved."
          );
        }
      } else {
        return manual(
          "invalid-slot",
          "The Foundation transaction slot could not be read safely and was preserved."
        );
      }
    }
    if (record.outcome !== "read") {
      return manual(
        "unstable-slot",
        "The Foundation transaction slot is not a stable bounded regular file and was preserved."
      );
    }
    try {
      const source = strictUtf8.decode(record.bytes);
      return await inspectParsedTransaction(
        parseStrictJson(source),
        this.#installedVersion,
        this.#installedBuildIdentity
      );
    } catch {
      return manual(
        "corrupt-or-incompatible",
        "The Foundation transaction slot is corrupt, tampered, or incompatible; it was preserved."
      );
    }
  }

  async inspect(): Promise<InternalFoundationTransactionStatus> {
    const [localMode, transaction] = await Promise.all([
      inspectLocalModeEvidence(this.#stateDirectory),
      this.#inspectTransactionEvidence()
    ]);
    if (localMode.state !== "idle" && transaction.state !== "idle") {
      return manual(
        "multiple-transactions",
        "Local-mode and transaction-slot recovery evidence coexist; both were preserved and require manual recovery."
      );
    }
    return transaction.state === "idle" ? localMode : transaction;
  }
}
