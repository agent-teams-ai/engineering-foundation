import { readdir } from "node:fs/promises";

import { FOUNDATION_TRANSACTION_FILE } from "../../../foundation-state-contract.js";
import type { FoundationTransactionStatus } from "../../application/model/transaction-status.js";

const maximumStateDirectoryEntries = 1024;
const transition = `${FOUNDATION_TRANSACTION_FILE}.document-transition`;
const quarantine = `${FOUNDATION_TRANSACTION_FILE}.document-quarantine.`;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

function manual(message: string): FoundationTransactionStatus {
  return {
    state: "manual-recovery-required",
    reason: "journal-transition-residue",
    diagnostics: [{
      code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
      message
    }]
  };
}

export async function inspectDocumentTransitionEvidence(
  stateDirectory: string
): Promise<FoundationTransactionStatus | undefined> {
  let entries: string[];
  try {
    entries = await readdir(stateDirectory);
  } catch (error) {
    return isMissing(error)
      ? undefined
      : manual("Foundation document journal transition evidence cannot be inspected safely.");
  }
  if (entries.length > maximumStateDirectoryEntries) {
    return manual(
      "Foundation state contains too many entries to inspect document journal transitions safely."
    );
  }
  return entries.includes(transition) ||
    entries.some((entry) => entry.startsWith(quarantine))
    ? manual(
        "An incomplete document journal transition was preserved and requires recovery before another Foundation mutation can start."
      )
    : undefined;
}
