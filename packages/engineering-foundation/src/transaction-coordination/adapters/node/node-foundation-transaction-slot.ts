import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import {
  FOUNDATION_TRANSACTION_FILE,
  FOUNDATION_TRANSACTION_TEMPORARY_FILE,
  FOUNDATION_LINK_STATE_FILE,
  FOUNDATION_REGISTRY_BACKUP,
  LOCAL_STATE_DIRECTORY
} from "../../../foundation-state-contract.js";
import { assertSchema } from "../../../schema-catalog.js";
import { sha256Json as sha256DocumentJson } from "../../../canonical-json.js";
import type {
  AuthorityScaffoldJournal,
  JsonValue
} from "../../../scaffolding/contract/types.js";
import { assertAuthorityScaffoldJournal } from "../../../scaffolding/kernel/authority-journal-validation.js";
import { sha256Json as sha256ScaffoldingJson } from "../../../scaffolding/kernel/canonical-json.js";
import { parseStrictJson } from "../../../strict-json.js";
import type {
  FoundationRecoveryRoute,
  FoundationManualRecoveryReason,
  FoundationTransactionDiagnostic,
  FoundationTransactionStatus
} from "../../application/model/transaction-status.js";
import type { FoundationTransactionSlot } from "../../application/ports/foundation-transaction-slot.js";
import { readBoundedRegularFile } from "../../../repository-mutation/adapters/node/node-bounded-regular-file.js";
import {
  assertLegacyDocumentEnvelope,
  isKnownLegacyDocumentEnvelope
} from "./legacy-document-envelope-v2.js";
import {
  inspectCurrentDocumentEnvelope,
  inspectDocumentTransactionBindings
} from "./document-envelope-bindings.js";
import { inspectDocumentTransitionEvidence } from "./document-transition-evidence.js";

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

function manual(
  reason: FoundationManualRecoveryReason,
  message: string
): FoundationTransactionStatus {
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
  readonly format: "legacy-scaffolding-v1";
  readonly foundationVersion: string;
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}): FoundationTransactionStatus {
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

function pendingDocument(options: {
  readonly foundationVersion: string;
  readonly foundationBuildIdentity: string;
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}): FoundationTransactionStatus {
  const exactBuild =
    options.foundationVersion === options.installedVersion &&
    options.foundationBuildIdentity === options.installedBuildIdentity;
  return {
    state: "pending",
    operationKind: "document-authoring",
    format: "document-authoring-envelope-v3",
    foundationVersion: options.foundationVersion,
    foundationBuildIdentity: options.foundationBuildIdentity,
    recovery: {
      commandId: "docs-recover",
      exactFoundationVersion: options.foundationVersion,
      exactFoundationBuildIdentity: options.foundationBuildIdentity
    },
    diagnostics: [
      exactBuild
        ? {
            code: "FOUNDATION_TRANSACTION_ACTIVE",
            message:
              "A pending document-authoring transaction must be recovered before another Foundation mutation can start."
          }
        : {
            code: "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
            message: `Foundation ${options.foundationVersion} (${options.foundationBuildIdentity}) must recover the pending document-authoring transaction before package ${options.installedVersion} (${options.installedBuildIdentity}) can mutate this repository.`
          }
    ]
  };
}

function localModePending(message: string): FoundationTransactionStatus {
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
): Promise<FoundationTransactionStatus> {
  let entries: string[];
  try {
    entries = await readdir(stateDirectory);
  } catch (error) {
    if (isMissing(error)) {
      return { state: "idle", diagnostics: [] };
    }
    return manual(
      "local-mode-evidence-invalid",
      "Foundation local-mode recovery evidence cannot be inspected safely."
    );
  }
  if (entries.length > maximumStateDirectoryEntries) {
    return manual(
      "local-mode-evidence-invalid",
      "Foundation local-mode state contains too many entries."
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
  const sha256EnvelopeJson =
    envelope["operationKind"] === "scaffolding"
      ? sha256ScaffoldingJson
      : sha256DocumentJson;
  const journal = envelope["journal"];
  if (envelope["payloadDigest"] !== sha256EnvelopeJson(journal as JsonValue)) {
    throw new Error("Foundation transaction payload digest is invalid.");
  }
  const { envelopeDigest, ...body } = envelope;
  if (envelopeDigest !== sha256EnvelopeJson(body as JsonValue)) {
    throw new Error("Foundation transaction envelope digest is invalid.");
  }
}

async function inspectLegacyScaffoldingJournal(options: {
  readonly value: Record<string, unknown>;
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}): Promise<FoundationTransactionStatus> {
  await assertSchema(
    "scaffold-recovery-journal/v1",
    options.value,
    "foundation-transaction-slot"
  );
  const journal = options.value as unknown as AuthorityScaffoldJournal;
  assertAuthorityScaffoldJournal(journal);
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

async function inspectParsedTransaction(
  value: unknown,
  installedVersion: string,
  installedBuildIdentity: string
): Promise<FoundationTransactionStatus> {
  if (!isRecord(value)) {
    return manual(
      "invalid-slot",
      "The Foundation transaction slot is invalid and was preserved."
    );
  }
  const schemaVersion = value["schemaVersion"];
  if (typeof schemaVersion !== "number") {
    return manual("invalid-slot", "The Foundation transaction slot is invalid and was preserved.");
  }
  switch (schemaVersion) {
  case 1:
    return inspectLegacyScaffoldingJournal({
      value,
      installedVersion,
      installedBuildIdentity
    });
  case 3:
    return inspectCurrentDocumentEnvelope({
      value, installedVersion, installedBuildIdentity, pending: pendingDocument
    });
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
      assertAuthorityScaffoldJournal(
        journal as unknown as AuthorityScaffoldJournal
      );
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
    return manual(
      "unsupported-schema",
      `Foundation transaction schema version ${String(schemaVersion)} is unsupported and was preserved.`
    );
  }
}

export class NodeFoundationTransactionSlot implements FoundationTransactionSlot {
  readonly #installedBuildIdentity: string;
  readonly #installedVersion: string;
  readonly #stateDirectory: string;
  readonly #slotPath: string;
  readonly #temporaryPath: string;

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
    this.#temporaryPath = join(
      stateDirectory,
      FOUNDATION_TRANSACTION_TEMPORARY_FILE
    );
  }

  async #inspectTransactionEvidence(): Promise<FoundationTransactionStatus> {
    const documentTransition = await inspectDocumentTransitionEvidence(
      this.#stateDirectory
    );
    if (documentTransition !== undefined) {
      return documentTransition;
    }
    if (await pathExists(this.#temporaryPath)) {
      return manual(
        "orphan-temporary",
        "An orphan Foundation transaction temporary exists; it was preserved and requires manual recovery."
      );
    }
    let record;
    try {
      record = await readBoundedRegularFile(
        this.#slotPath,
        maximumTransactionBytes
      );
    } catch (error) {
      if (isMissing(error)) {
        return { state: "idle", diagnostics: [] };
      }
      return manual(
        "invalid-slot",
        "The Foundation transaction slot could not be read safely and was preserved."
      );
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

  async inspect(): Promise<FoundationTransactionStatus> {
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
