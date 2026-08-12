import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import {
  FOUNDATION_TRANSACTION_FILE,
  FOUNDATION_TRANSACTION_TEMPORARY_FILE,
  LOCAL_STATE_DIRECTORY
} from "../../../foundation-state-contract.js";
import { assertSchema } from "../../../schema-catalog.js";
import {
  sha256Bytes,
  sha256Json
} from "../../../scaffolding/kernel/canonical-json.js";
import type {
  AuthorityScaffoldJournal,
  JsonValue
} from "../../../scaffolding/contract/types.js";
import { assertAuthorityScaffoldJournal } from "../../../scaffolding/kernel/authority-journal-validation.js";
import { parseStrictJson } from "../../../strict-json.js";
import type {
  FoundationRecoveryRoute,
  FoundationManualRecoveryReason,
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

function recoveryRoute(
  operationKind: "document-authoring" | "scaffolding",
  exactFoundationVersion: string,
  exactFoundationBuildIdentity?: string
): FoundationRecoveryRoute {
  if (operationKind === "scaffolding") {
    return {
      commandId: "scaffold-recover",
      exactFoundationVersion,
      ...(exactFoundationBuildIdentity === undefined
        ? {}
        : { exactFoundationBuildIdentity })
    };
  }
  if (exactFoundationBuildIdentity === undefined) {
    throw new Error("Document recovery requires an exact Foundation build identity.");
  }
  return {
    commandId: "docs-recover",
    exactFoundationVersion,
    exactFoundationBuildIdentity
  };
}

function pending(options: {
  readonly operationKind: "document-authoring" | "scaffolding";
  readonly format: "envelope-v2" | "legacy-scaffolding-v1";
  readonly foundationVersion: string;
  readonly foundationBuildIdentity?: string;
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}): FoundationTransactionStatus {
  const diagnostics: FoundationTransactionDiagnostic[] = [];
  const buildMismatch =
    options.foundationBuildIdentity !== undefined &&
    options.foundationBuildIdentity !== options.installedBuildIdentity;
  if (options.foundationVersion !== options.installedVersion || buildMismatch) {
    diagnostics.push({
      code: "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
      message: `Foundation ${options.foundationVersion}${options.foundationBuildIdentity === undefined ? "" : ` (${options.foundationBuildIdentity})`} must recover the pending ${options.operationKind} transaction before package ${options.installedVersion} (${options.installedBuildIdentity}) can mutate this repository.`
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
    ...(options.foundationBuildIdentity === undefined
      ? {}
      : { foundationBuildIdentity: options.foundationBuildIdentity }),
    recovery: recoveryRoute(
      options.operationKind,
      options.foundationVersion,
      options.foundationBuildIdentity
    ),
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

function assertDocumentPlanDigest(plan: Record<string, unknown>): void {
  const { planDigest, ...body } = plan;
  if (planDigest !== sha256Json(body as JsonValue)) {
    throw new Error("Document Plan digest is invalid.");
  }
}

function assertDocumentTransactionBindings(
  journal: Record<string, unknown>,
  plan: Record<string, unknown>
): void {
  const intent = plan["intent"];
  const output = plan["output"];
  const destination = journal["destination"];
  if (
    !isRecord(intent) ||
    plan["intentDigest"] !== sha256Json(intent as JsonValue) ||
    !isRecord(output) ||
    typeof output["contentBase64"] !== "string" ||
    !isRecord(destination) ||
    destination["path"] !== plan["destination"]
  ) {
    throw new Error("Document transaction semantic binding is invalid.");
  }
  const outputBytes = Buffer.from(output["contentBase64"], "base64");
  if (
    outputBytes.toString("base64") !== output["contentBase64"] ||
    output["size"] !== outputBytes.byteLength ||
    output["digest"] !== sha256Bytes(outputBytes)
  ) {
    throw new Error("Document transaction output binding is invalid.");
  }
  const ownedTemporary = journal["ownedTemporary"];
  if (ownedTemporary !== undefined) {
    if (
      !isRecord(ownedTemporary) ||
      ownedTemporary["digest"] !== output["digest"] ||
      typeof ownedTemporary["path"] !== "string" ||
      ownedTemporary["path"] !== `${String(plan["destination"])}.foundation-document.tmp`
    ) {
      throw new Error("Document transaction temporary binding is invalid.");
    }
  }
}

async function inspectParsedTransaction(
  value: unknown,
  installedVersion: string,
  installedBuildIdentity: string
): Promise<FoundationTransactionStatus> {
  if (!isRecord(value) || typeof value["schemaVersion"] !== "number") {
    return manual(
      "invalid-slot",
      "The Foundation transaction slot is invalid and was preserved."
    );
  }
  if (value["schemaVersion"] === 1) {
    await assertSchema(
      "scaffold-recovery-journal/v1",
      value,
      "foundation-transaction-slot"
    );
    const journal = value as unknown as AuthorityScaffoldJournal;
    assertAuthorityScaffoldJournal(journal);
    const plan = journal.plan;
    const compiler = plan["compiler"];
    if (!isRecord(compiler) || typeof compiler["version"] !== "string") {
      throw new Error("Legacy scaffolding journal compiler version is invalid.");
    }
    return pending({
      operationKind: "scaffolding",
      format: "legacy-scaffolding-v1",
      foundationVersion: compiler["version"],
      installedVersion,
      installedBuildIdentity
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
      assertDocumentPlanDigest(plan);
      assertDocumentTransactionBindings(journal, plan);
    } else {
      assertAuthorityScaffoldJournal(
        journal as unknown as AuthorityScaffoldJournal
      );
    }
    return pending({
      operationKind: operationKind as "document-authoring" | "scaffolding",
      format: "envelope-v2",
      foundationVersion: foundation["version"],
      foundationBuildIdentity: foundation["buildIdentity"],
      installedVersion,
      installedBuildIdentity
    });
  }
  return manual(
    "unsupported-schema",
    `Foundation transaction schema version ${String(value["schemaVersion"])} is unsupported and was preserved.`
  );
}

export class NodeFoundationTransactionSlot implements FoundationTransactionSlot {
  readonly #installedBuildIdentity: string;
  readonly #installedVersion: string;
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
    this.#slotPath = join(stateDirectory, FOUNDATION_TRANSACTION_FILE);
    this.#temporaryPath = join(
      stateDirectory,
      FOUNDATION_TRANSACTION_TEMPORARY_FILE
    );
  }

  async inspect(): Promise<FoundationTransactionStatus> {
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
}
