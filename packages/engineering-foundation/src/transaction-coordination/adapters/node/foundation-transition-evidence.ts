import { opendir } from "node:fs/promises";

import {
  FOUNDATION_TRANSACTION_CLEANUP_RESIDUE_PREFIX,
  FOUNDATION_TRANSACTION_FILE,
  FOUNDATION_TRANSACTION_TEMPORARY_FILE
} from "../../../foundation-state-contract.js";
import type { InternalFoundationTransactionStatus } from "../../application/model/internal-transaction-status.js";
import { portableRepositoryPathIdentity } from "@agent-teams/repository-mutation";

export { FOUNDATION_TRANSACTION_CLEANUP_RESIDUE_PREFIX } from "../../../foundation-state-contract.js";

const maximumStateDirectoryEntries = 1024;

const documentTransition = `${FOUNDATION_TRANSACTION_FILE}.document-transition`;
const documentQuarantine = `${FOUNDATION_TRANSACTION_FILE}.document-quarantine.`;
const documentRetired = `${FOUNDATION_TRANSACTION_FILE}.document-retired.`;
const scaffoldQuarantine = `${FOUNDATION_TRANSACTION_FILE}.scaffold-quarantine.`;
const scaffoldRetired = `${FOUNDATION_TRANSACTION_FILE}.scaffold-retired.`;

/**
 * Operation-neutral state marker for a transaction-owned output cleanup that
 * was durably quarantined outside the state directory. Producers append an
 * opaque transaction-specific token; the common coordinator never interprets
 * it and only uses its presence as a fail-closed recovery barrier.
 */
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

function manual(
  reason: "journal-transition-residue" | "orphan-temporary",
  message: string
): InternalFoundationTransactionStatus {
  return {
    state: "manual-recovery-required",
    reason,
    diagnostics: [{
      code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
      message
    }]
  };
}

function isTransitionResidue(entry: string): boolean {
  return entry === documentTransition ||
    entry.startsWith(documentQuarantine) ||
    entry.startsWith(documentRetired) ||
    entry.startsWith(scaffoldQuarantine) ||
    entry.startsWith(scaffoldRetired) ||
    entry.startsWith(FOUNDATION_TRANSACTION_CLEANUP_RESIDUE_PREFIX);
}

function isAmbiguousCommonEvidence(entry: string): boolean {
  const portable = portableRepositoryPathIdentity(entry);
  const transaction = portableRepositoryPathIdentity(FOUNDATION_TRANSACTION_FILE);
  const exactNames = [
    FOUNDATION_TRANSACTION_FILE,
    FOUNDATION_TRANSACTION_TEMPORARY_FILE,
    `${FOUNDATION_TRANSACTION_FILE}.known-file.tmp`,
    `${FOUNDATION_TRANSACTION_FILE}.completed-known-file-evidence`,
    `${FOUNDATION_TRANSACTION_FILE}.completed-document-evidence`,
    `${FOUNDATION_TRANSACTION_FILE}.completed-scaffold-evidence`
  ];
  if (exactNames.some((name) =>
    portable === portableRepositoryPathIdentity(name) && entry !== name)) {
    return true;
  }
  return portable.startsWith(`${transaction}.`) &&
    !exactNames.includes(entry) && !isTransitionResidue(entry);
}

async function boundedStateEntries(stateDirectory: string): Promise<readonly string[]> {
  const directory = await opendir(stateDirectory);
  const entries: string[] = [];
  try {
    for (;;) {
      const entry = await directory.read();
      if (entry === null) {return entries;}
      entries.push(entry.name);
      if (entries.length > maximumStateDirectoryEntries) {
        throw new Error("Foundation state directory enumeration budget exceeded.");
      }
    }
  } finally {
    await directory.close();
  }
}

export async function inspectFoundationTransitionEvidence(
  stateDirectory: string
): Promise<InternalFoundationTransactionStatus | undefined> {
  let entries: readonly string[];
  try {
    entries = await boundedStateEntries(stateDirectory);
  } catch (error) {
    return isMissing(error)
      ? undefined
      : manual(
          "journal-transition-residue",
          "Foundation transaction transition evidence cannot be inspected safely."
        );
  }
  const ambiguousEntries = entries.filter(
    (entry) => isTransitionResidue(entry) || isAmbiguousCommonEvidence(entry)
  );
  if (ambiguousEntries.length !== 0) {
    return manual(
      "journal-transition-residue",
      `An incomplete Foundation transaction transition was preserved and requires recovery before another Foundation mutation can start (${ambiguousEntries.join(", ")}).`
    );
  }
  return entries.includes(FOUNDATION_TRANSACTION_TEMPORARY_FILE)
    ? manual(
        "orphan-temporary",
        "An orphan Foundation transaction temporary exists; it was preserved and requires manual recovery."
      )
    : undefined;
}
