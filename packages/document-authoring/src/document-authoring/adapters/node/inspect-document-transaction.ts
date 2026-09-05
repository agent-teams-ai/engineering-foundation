import { classifyDocumentTransactionInspection, projectDocumentTransactionInspectionV1, unsafeDocumentTransactionInspection } from "../../application/policies/project-document-transaction-inspection.js";
import { lstat, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { NodeDocumentJournalStore } from "./node-document-journal-store.js";
import { recaptureDocumentPublicationPaths } from "./recapture-document-publication-paths.js";
import type {
  DocumentTransactionInspectionV1,
  DocumentTransactionInspectionV2
} from "../../application/model/document-transaction-inspection.js";
import { installedDocumentAuthoringBuildIdentity } from "./installed-artifact-identity.js";
import { installedDocumentAuthoringVersion } from "./package-version.js";
import { FOUNDATION_TRANSACTION_FILE, LOCAL_STATE_DIRECTORY } from "../../application/model/state-contract.js";

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
    return unsafeDocumentTransactionInspection("Document transaction evidence path cannot be inspected safely.");
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
    return unsafeDocumentTransactionInspection("Document transaction evidence path is redirected or cannot be inspected safely.");
  }

  const journalPath = join(stateDirectory, FOUNDATION_TRANSACTION_FILE);
  // Check residue before reading the canonical slot so every platform
  // exposes the same deterministic recovery coordinate.
  if (await hasForeignEvidence(stateDirectory)) {
    return unsafeDocumentTransactionInspection("journal-transition-residue");
  }
  let stored;
  try {
    stored = await new NodeDocumentJournalStore(journalPath).read();
  } catch {
    return unsafeDocumentTransactionInspection("Transaction evidence is foreign, corrupt, incompatible, or has transition residue; it was preserved.");
  }
  if (stored === undefined) {
    return await hasForeignEvidence(stateDirectory)
      ? unsafeDocumentTransactionInspection("Transaction transition evidence requires exact owner-package recovery.")
      : { schemaVersion: 2, state: "idle", diagnostics: [] };
  }
  const envelope = stored.envelope;
  const [version, buildIdentity] = await Promise.all([
    installedDocumentAuthoringVersion(), installedDocumentAuthoringBuildIdentity()
  ]);
  return classifyDocumentTransactionInspection(envelope, version, buildIdentity);
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
  return projectDocumentTransactionInspectionV1(observed);
}
