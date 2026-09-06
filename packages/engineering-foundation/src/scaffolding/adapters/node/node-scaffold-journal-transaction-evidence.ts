import { lstat, readdir } from "node:fs/promises";
import { dirname } from "node:path";

import { FOUNDATION_TRANSACTION_CLEANUP_RESIDUE_PREFIX } from "../../application/policies/transaction-identity.js";

import {
  SCAFFOLD_JOURNAL_QUARANTINE_PREFIX,
  scaffoldQuarantinePrefix,
  scaffoldRetiredPrefix
} from "./node-scaffold-journal-evidence.js";

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function scaffoldTransactionEvidenceExists(
  journalPath: string
): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(dirname(journalPath));
  } catch {
    return true;
  }
  return (await pathEntryExists(journalPath)) ||
    (await pathEntryExists(`${journalPath}.tmp`)) ||
    entries.some((entry) => entry.startsWith(SCAFFOLD_JOURNAL_QUARANTINE_PREFIX) ||
      entry.startsWith(scaffoldQuarantinePrefix) ||
      entry.startsWith(scaffoldRetiredPrefix) ||
      entry.startsWith(FOUNDATION_TRANSACTION_CLEANUP_RESIDUE_PREFIX));
}
