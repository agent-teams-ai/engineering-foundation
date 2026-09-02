import { lstat, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { NodeDocumentJournalStore } from "../adapters/node/node-document-journal-store.js";
import { recaptureDocumentPublicationPaths } from "../adapters/node/recapture-document-publication-paths.js";
import type {
  DocumentTransactionInspectionDiagnostic,
  DocumentTransactionInspectionV1,
  DocumentTransactionInspectionV2
} from "../application/model/document-transaction-inspection.js";
import { installedDocumentAuthoringBuildIdentity } from "../installed-artifact-identity.js";
import { installedDocumentAuthoringVersion } from "../package-version.js";
import { FOUNDATION_TRANSACTION_FILE, LOCAL_STATE_DIRECTORY } from "../state-contract.js";

const maximumStateEntries = 1024;
const transitionNames = new Set([
  `${FOUNDATION_TRANSACTION_FILE}.tmp`,
  `${FOUNDATION_TRANSACTION_FILE}.known-file.tmp`,
  `${FOUNDATION_TRANSACTION_FILE}.document-transition`
]);

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

function diagnostic(
  code: DocumentTransactionInspectionDiagnostic["code"], message: string
): readonly DocumentTransactionInspectionDiagnostic[] {
  return [{ code, message }];
}

function unsafe(reason: string): Extract<DocumentTransactionInspectionV2, {
  readonly state: "manual-recovery-required";
}> {
  return {
    schemaVersion: 2,
    state: "manual-recovery-required",
    reason,
    transactionKind: "corrupt",
    diagnostics: diagnostic("FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED", reason)
  };
}

async function hasForeignEvidence(stateDirectory: string): Promise<boolean> {
  const directory = await opendir(stateDirectory);
  let count = 0;
  try {
    for (;;) {
      const entry = await directory.read();
      if (entry === null) {
        return false;
      }
      count += 1;
      if (count > maximumStateEntries) {
        return true;
      }
      if (transitionNames.has(entry.name) ||
        entry.name.startsWith(`${FOUNDATION_TRANSACTION_FILE}.document-quarantine.`) ||
        entry.name.startsWith(`${FOUNDATION_TRANSACTION_FILE}.document-retired.`)) {
        return true;
      }
    }
  } finally {
    await directory.close();
  }
}

async function inspectV2(consumerRoot: string): Promise<DocumentTransactionInspectionV2> {
  const root = await realpath(resolve(consumerRoot));
  const stateDirectory = join(root, LOCAL_STATE_DIRECTORY);
  try { await lstat(stateDirectory); }
  catch (error) {
    if (missing(error)) {
      return { schemaVersion: 2, state: "idle", diagnostics: [] };
    }
    return unsafe("Document transaction evidence path cannot be inspected safely.");
  }
  try {
    await recaptureDocumentPublicationPaths({
      consumerRoot: root,
      destination: `${LOCAL_STATE_DIRECTORY}/${FOUNDATION_TRANSACTION_FILE}`
    });
  } catch {
    try {
      await lstat(stateDirectory);
    } catch (error) {
      if (missing(error)) {
        return { schemaVersion: 2, state: "idle", diagnostics: [] };
      }
    }
    return unsafe("Document transaction evidence path is redirected or cannot be inspected safely.");
  }

  const journalPath = join(stateDirectory, FOUNDATION_TRANSACTION_FILE);
  let stored;
  try {
    stored = await new NodeDocumentJournalStore(journalPath).read();
  } catch {
    return unsafe("Transaction evidence is foreign, corrupt, incompatible, or has transition residue; it was preserved.");
  }
  if (stored === undefined) {
    return await hasForeignEvidence(stateDirectory)
      ? unsafe("Transaction transition evidence requires exact owner-package recovery.")
      : { schemaVersion: 2, state: "idle", diagnostics: [] };
  }
  const envelope = stored.envelope;
  const [version, buildIdentity] = await Promise.all([
    installedDocumentAuthoringVersion(), installedDocumentAuthoringBuildIdentity()
  ]);
  const exact = envelope.foundation.version === version &&
    envelope.foundation.buildIdentity === buildIdentity;
  const format = envelope.schemaVersion === 4
    ? "document-authoring-envelope-v4" as const
    : "document-authoring-envelope-v3" as const;
  if (!exact) {
    const reason = `Document Authoring ${envelope.foundation.version} (${envelope.foundation.buildIdentity}) must recover this transaction before ${version} (${buildIdentity}) can mutate the repository.`;
    return {
      schemaVersion: 2,
      state: "manual-recovery-required",
      reason,
      operationKind: "document-authoring",
      transactionKind: "version-mismatch",
      format,
      foundationVersion: envelope.foundation.version,
      foundationBuildIdentity: envelope.foundation.buildIdentity,
      recovery: {
        commandId: "docs-recover",
        args: {
          exactFoundationVersion: envelope.foundation.version,
          exactFoundationBuildIdentity: envelope.foundation.buildIdentity
        }
      },
      diagnostics: diagnostic("FOUNDATION_TRANSACTION_VERSION_MISMATCH", reason)
    };
  }
  return {
    schemaVersion: 2,
    state: "recoverable",
    operationKind: "document-authoring",
    format,
    foundationVersion: version,
    foundationBuildIdentity: buildIdentity,
    recovery: {
      commandId: "docs-recover",
      exactFoundationVersion: version,
      exactFoundationBuildIdentity: buildIdentity
    },
    diagnostics: diagnostic("FOUNDATION_TRANSACTION_ACTIVE", "A pending document-authoring transaction must be recovered.")
  };
}

export async function inspectDocumentTransactionV2(
  consumerRoot: string
): Promise<DocumentTransactionInspectionV2> {
  return inspectV2(consumerRoot);
}

export async function inspectDocumentTransactionV1(
  consumerRoot: string
): Promise<DocumentTransactionInspectionV1> {
  const observed = await inspectV2(consumerRoot);
  if (observed.state === "idle") {
    return { schemaVersion: 1, state: "idle", diagnostics: [] };
  }
  if (observed.state === "recoverable" && observed.format === "document-authoring-envelope-v3") {
    return { ...observed, schemaVersion: 1, format: "document-authoring-envelope-v3" };
  }
  if (observed.state === "recoverable") {
    return {
      schemaVersion: 1,
      state: "manual-recovery-required",
      reason: "Document transaction envelope v4 requires the v2 inspection contract.",
      operationKind: "document-authoring",
      transactionKind: "document",
      format: observed.format,
      foundationVersion: observed.foundationVersion,
      foundationBuildIdentity: observed.foundationBuildIdentity,
      recovery: {
        commandId: "docs-recover",
        args: {
          exactFoundationVersion: observed.recovery.exactFoundationVersion,
          exactFoundationBuildIdentity: observed.recovery.exactFoundationBuildIdentity
        }
      },
      diagnostics: observed.diagnostics
    };
  }
  return { ...observed, schemaVersion: 1 };
}
