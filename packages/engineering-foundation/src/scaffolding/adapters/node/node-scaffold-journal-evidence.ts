import { mkdir, opendir } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import {
  FOUNDATION_TRANSACTION_FILE,
  FOUNDATION_TRANSACTION_TEMPORARY_FILE
} from "../../../foundation-state-contract.js";
import type { AuthorityScaffoldJournal } from "../../contract/types.js";
import { assertAuthorityScaffoldJournal } from "../../kernel/authority-journal-validation.js";
import { sha256Bytes } from "../../kernel/canonical-json.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { assertSchema } from "../../../schema-catalog.js";
import { parseStrictJson } from "../../../strict-json.js";
import {
  pathMatchesFileIdentity,
  readBoundedRegularFile,
  type PortableFileIdentity
} from "./filesystem-file-identity.js";
import { MAX_SCAFFOLD_PLAN_BYTES } from "./node-scaffold-limits.js";

const maximumDirectoryEntries = 1024;
export const scaffoldQuarantinePrefix =
  `${FOUNDATION_TRANSACTION_FILE}.scaffold-quarantine.`;
export const scaffoldRetiredPrefix =
  `${FOUNDATION_TRANSACTION_FILE}.scaffold-retired.`;
let privateSequence = 0;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface ScaffoldJournalAuthority {
  readonly authorityDigest: string;
  readonly identity: PortableFileIdentity;
}

export interface StoredScaffoldJournal {
  readonly authority: ScaffoldJournalAuthority;
  readonly journal: AuthorityScaffoldJournal;
}

export type ScaffoldJournalSlotObservation =
  | {
      readonly outcome: "stable";
      readonly stored?: StoredScaffoldJournal;
    }
  | {
      readonly outcome: "committed" | "not-applied";
      readonly stored?: StoredScaffoldJournal;
    }
  | {
      readonly canonical?: StoredScaffoldJournal;
      readonly outcome: "recovery-required";
      readonly residueNames: readonly string[];
    };

export function scaffoldJournalErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

export function scaffoldJournalRecoveryRequired(
  message: string,
  cause?: unknown
): ScaffoldError {
  return new ScaffoldError(
    "SCAFFOLD_RECOVERY_REQUIRED",
    message,
    [],
    cause === undefined ? undefined : { cause }
  );
}

export async function serializeScaffoldJournal(
  journal: AuthorityScaffoldJournal
): Promise<Buffer> {
  try {
    await assertSchema(
      "scaffold-recovery-journal/v1",
      journal,
      "scaffold-recovery-journal"
    );
    await assertSchema(
      "scaffold-plan/v1",
      journal.plan,
      "scaffold-recovery-journal"
    );
    assertAuthorityScaffoldJournal(journal);
  } catch (error) {
    throw scaffoldJournalRecoveryRequired(
      "Scaffolding journal does not satisfy the released contract.",
      error
    );
  }
  const bytes = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_SCAFFOLD_PLAN_BYTES) {
    throw scaffoldJournalRecoveryRequired(
      "Scaffolding journal exceeds its bounded size limit."
    );
  }
  return bytes;
}

export function scaffoldJournalAuthority(
  identity: PortableFileIdentity,
  bytes: Uint8Array
): ScaffoldJournalAuthority {
  return { authorityDigest: sha256Bytes(bytes), identity };
}

export async function observeScaffoldJournalAuthority(
  path: string,
  expected: ScaffoldJournalAuthority
): Promise<"match" | "missing" | "other"> {
  try {
    const observed = await readBoundedRegularFile(path, MAX_SCAFFOLD_PLAN_BYTES);
    if (observed.outcome !== "read") {
      return "other";
    }
    return (await pathMatchesFileIdentity(path, expected.identity)) === "match" &&
        sha256Bytes(observed.bytes) === expected.authorityDigest
      ? "match"
      : "other";
  } catch (error) {
    if (scaffoldJournalErrorCode(error) === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

export async function readStoredScaffoldJournal(
  path: string
): Promise<StoredScaffoldJournal | undefined> {
  try {
    const observed = await readBoundedRegularFile(path, MAX_SCAFFOLD_PLAN_BYTES);
    if (observed.outcome !== "read") {
      throw scaffoldJournalRecoveryRequired(
        "Scaffolding journal is not a stable bounded regular file."
      );
    }
    let journal: AuthorityScaffoldJournal;
    try {
      const value = parseStrictJson(strictUtf8.decode(observed.bytes));
      await assertSchema(
        "scaffold-recovery-journal/v1",
        value,
        "scaffold-recovery-journal"
      );
      journal = value as AuthorityScaffoldJournal;
      await assertSchema(
        "scaffold-plan/v1",
        journal.plan,
        "scaffold-recovery-journal"
      );
      assertAuthorityScaffoldJournal(journal);
    } catch (error) {
      throw scaffoldJournalRecoveryRequired(
        "Scaffolding journal contains invalid strict JSON or contract data.",
        error
      );
    }
    if (!observed.bytes.equals(await serializeScaffoldJournal(journal))) {
      throw scaffoldJournalRecoveryRequired(
        "Scaffolding journal bytes are not in the historical canonical form."
      );
    }
    return {
      authority: scaffoldJournalAuthority(observed.identity, observed.bytes),
      journal
    };
  } catch (error) {
    if (scaffoldJournalErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function scaffoldJournalResidueNames(
  parent: string
): Promise<readonly string[]> {
  const directory = await opendir(parent);
  const residues: string[] = [];
  let entries = 0;
  try {
    for (;;) {
      const entry = await directory.read();
      if (entry === null) {
        break;
      }
      entries += 1;
      if (entries > maximumDirectoryEntries) {
        throw scaffoldJournalRecoveryRequired(
          "Scaffolding state contains too many entries to inspect safely."
        );
      }
      if (
        entry.name === FOUNDATION_TRANSACTION_TEMPORARY_FILE ||
        entry.name === `${FOUNDATION_TRANSACTION_FILE}.document-transition` ||
        entry.name.startsWith(
          `${FOUNDATION_TRANSACTION_FILE}.document-quarantine.`
        ) ||
        entry.name.startsWith(`${FOUNDATION_TRANSACTION_FILE}.document-retired.`) ||
        entry.name.startsWith(scaffoldQuarantinePrefix) ||
        entry.name.startsWith(scaffoldRetiredPrefix)
      ) {
        residues.push(entry.name);
      }
    }
  } finally {
    await directory.close();
  }
  return residues.toSorted();
}

export async function createPrivateScaffoldJournalEvidencePath(
  parent: string,
  prefix: string
): Promise<{ readonly directory: string; readonly path: string }> {
  for (;;) {
    privateSequence += 1;
    const directory = join(
      parent,
      `${prefix}${process.pid}.${Date.now()}.${privateSequence}`
    );
    try {
      await mkdir(directory, { mode: 0o700 });
      return { directory, path: join(directory, "evidence") };
    } catch (error) {
      if (scaffoldJournalErrorCode(error) !== "EEXIST") {
        throw error;
      }
    }
  }
}
