import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import {
  FOUNDATION_TRANSACTION_FILE,
  FOUNDATION_TRANSACTION_TEMPORARY_FILE,
  LOCAL_STATE_DIRECTORY
} from "./foundation-state-paths.js";
import { assertSchema } from "../../../schema-catalog.js";
import { assertAuthorityScaffoldPlanDigest } from "../../../scaffolding/kernel/plan-validation.js";
import { sha256Json } from "../../../scaffolding/kernel/canonical-json.js";
import type { JsonValue } from "../../../scaffolding/contract/types.js";
import { parseStrictJson } from "../../../strict-json.js";
import type {
  FoundationRecoveryRoute,
  FoundationTransactionDiagnostic,
  FoundationTransactionStatus
} from "../../application/model/transaction-status.js";
import type { FoundationTransactionSlot } from "../../application/ports/foundation-transaction-slot.js";
import { readBoundedRegularFile } from "../../../scaffolding/adapters/node/filesystem-file-identity.js";

const maximumTransactionBytes = 32 * 1024 * 1024;
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

function manual(message: string): FoundationTransactionStatus {
  return {
    state: "manual-recovery-required",
    diagnostics: [
      {
        code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
        message
      }
    ]
  };
}

function recoveryRoute(
  operationKind: "document-authoring" | "scaffolding",
  exactFoundationVersion: string
): FoundationRecoveryRoute {
  return operationKind === "scaffolding"
    ? { commandId: "scaffold-recover", exactFoundationVersion }
    : { commandId: "docs-recover", exactFoundationVersion };
}

function pending(options: {
  readonly operationKind: "document-authoring" | "scaffolding";
  readonly format: "envelope-v2" | "legacy-scaffolding-v1";
  readonly foundationVersion: string;
  readonly installedVersion: string;
}): FoundationTransactionStatus {
  const diagnostics: FoundationTransactionDiagnostic[] = [];
  if (options.foundationVersion !== options.installedVersion) {
    diagnostics.push({
      code: "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
      message: `Foundation ${options.foundationVersion} must recover the pending ${options.operationKind} transaction before package version ${options.installedVersion} can mutate this repository.`
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
    recovery: recoveryRoute(options.operationKind, options.foundationVersion),
    diagnostics
  };
}

function assertEnvelopeDigests(envelope: Record<string, unknown>): void {
  const journal = envelope["journal"];
  if (envelope["payloadDigest"] !== sha256Json(journal as JsonValue)) {
    throw new Error("Foundation transaction payload digest is invalid.");
  }
  const { envelopeDigest, ...body } = envelope;
  if (envelopeDigest !== sha256Json(body as JsonValue)) {
    throw new Error("Foundation transaction envelope digest is invalid.");
  }
}

async function inspectParsedTransaction(
  value: unknown,
  installedVersion: string
): Promise<FoundationTransactionStatus> {
  if (!isRecord(value) || typeof value["schemaVersion"] !== "number") {
    return manual("The Foundation transaction slot is invalid and was preserved.");
  }
  if (value["schemaVersion"] === 1) {
    await assertSchema(
      "scaffold-recovery-journal/v1",
      value,
      "foundation-transaction-slot"
    );
    const plan = value["plan"];
    if (!isRecord(plan)) {
      throw new Error("Legacy scaffolding journal Plan is invalid.");
    }
    assertAuthorityScaffoldPlanDigest(plan as never);
    const compiler = plan["compiler"];
    if (!isRecord(compiler) || typeof compiler["version"] !== "string") {
      throw new Error("Legacy scaffolding journal compiler version is invalid.");
    }
    return pending({
      operationKind: "scaffolding",
      format: "legacy-scaffolding-v1",
      foundationVersion: compiler["version"],
      installedVersion
    });
  }
  if (value["schemaVersion"] === 2) {
    await assertSchema(
      "foundation-transaction-envelope/v2",
      value,
      "foundation-transaction-slot"
    );
    assertEnvelopeDigests(value);
    const foundation = value["foundation"];
    const operationKind = value["operationKind"];
    if (
      !isRecord(foundation) ||
      typeof foundation["version"] !== "string" ||
      !["document-authoring", "scaffolding"].includes(String(operationKind))
    ) {
      throw new Error("Foundation transaction envelope binding is invalid.");
    }
    return pending({
      operationKind: operationKind as "document-authoring" | "scaffolding",
      format: "envelope-v2",
      foundationVersion: foundation["version"],
      installedVersion
    });
  }
  return manual(
    `Foundation transaction schema version ${String(value["schemaVersion"])} is unsupported and was preserved.`
  );
}

export class NodeFoundationTransactionSlot implements FoundationTransactionSlot {
  readonly #installedVersion: string;
  readonly #slotPath: string;
  readonly #temporaryPath: string;

  constructor(options: {
    readonly consumerRoot: string;
    readonly installedVersion: string;
  }) {
    this.#installedVersion = options.installedVersion;
    const stateDirectory = join(options.consumerRoot, LOCAL_STATE_DIRECTORY);
    this.#slotPath = join(stateDirectory, FOUNDATION_TRANSACTION_FILE);
    this.#temporaryPath = join(
      stateDirectory,
      FOUNDATION_TRANSACTION_TEMPORARY_FILE
    );
  }

  async inspect(): Promise<FoundationTransactionStatus> {
    if (await pathExists(this.#temporaryPath)) {
      return manual(
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
        "The Foundation transaction slot could not be read safely and was preserved."
      );
    }
    if (record.outcome !== "read") {
      return manual(
        "The Foundation transaction slot is not a stable bounded regular file and was preserved."
      );
    }
    try {
      const source = strictUtf8.decode(record.bytes);
      return await inspectParsedTransaction(
        parseStrictJson(source),
        this.#installedVersion
      );
    } catch {
      return manual(
        "The Foundation transaction slot is corrupt, tampered, or incompatible; it was preserved."
      );
    }
  }
}

export async function inspectNodeFoundationTransaction(options: {
  readonly consumerRoot: string;
  readonly installedVersion: string;
}): Promise<FoundationTransactionStatus> {
  return new NodeFoundationTransactionSlot(options).inspect();
}
