import { FOUNDATION_LINK_STATE_FILE, FOUNDATION_REGISTRY_BACKUP } from "../../../foundation-state-contract.js";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import {
  FOUNDATION_TRANSACTION_FILE,
  KNOWN_FILE_TRANSACTION_TEMPORARY_FILE,
  LOCAL_STATE_DIRECTORY
} from "../../application/model/foundation-transaction-identity.js";
import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";
import type {
  InternalFoundationManualRecoveryReason,
  InternalFoundationTransactionStatus
} from "../../application/model/internal-transaction-status.js";
import type { FoundationTransactionSlot } from "../../application/ports/foundation-transaction-slot.js";
import type { FoundationTransactionInspection } from "../../application/ports/foundation-transaction-inspection.js";
import { readBoundedRegularFile } from "@agent-teams/repository-mutation/node";
import { portableRepositoryPathIdentity } from "@agent-teams/repository-mutation";
import { inspectFoundationTransitionEvidence } from "./foundation-transition-evidence.js";

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


export class NodeFoundationTransactionSlot implements FoundationTransactionSlot {
  readonly #inspection: FoundationTransactionInspection;
  readonly #stateDirectory: string;
  readonly #slotPath: string;
  readonly #knownFileTemporaryPath: string;

  constructor(options: {
    readonly consumerRoot: string;
    readonly inspection: FoundationTransactionInspection;
  }) {
    this.#inspection = options.inspection;
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
      return await this.#inspection.inspect(parseStrictJson(source));
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
