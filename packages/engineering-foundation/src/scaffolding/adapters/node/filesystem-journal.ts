import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type { AuthorityScaffoldJournal } from "../../contract/types.js";
import { assertAuthorityScaffoldPlanDigest } from "../../kernel/plan-validation.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { assertSchema } from "../../../schema-catalog.js";
import { parseStrictYamlSource } from "../../../strict-yaml.js";
import { syncDirectory } from "./filesystem-path-guard.js";
import {
  captureFileHandleIdentity,
  pathMatchesFileIdentity,
  readBoundedRegularFile,
  type PortableFileIdentity
} from "./filesystem-file-identity.js";
import { MAX_SCAFFOLD_PLAN_BYTES } from "./node-scaffold-limits.js";

export const SCAFFOLD_JOURNAL_FILE = "scaffolding-transaction.json";

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function writeAuthorityJournalFile(
  path: string,
  journal: AuthorityScaffoldJournal,
  faultInjector?: () => Promise<void> | void
): Promise<PortableFileIdentity> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = `${path}.tmp`;
  let renamed = false;
  let temporaryIdentity: PortableFileIdentity | undefined;
  try {
    const handle = await open(temporary, "wx", 0o600).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        throw new ScaffoldError(
          "SCAFFOLD_RECOVERY_REQUIRED",
          "Scaffolding journal temporary path already exists.",
          [],
          { cause: error }
        );
      }
      throw error;
    });
    try {
      await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
      await handle.sync();
      temporaryIdentity = await captureFileHandleIdentity(handle);
    } finally {
      await handle.close();
    }
    await faultInjector?.();
    if (
      (await pathMatchesFileIdentity(temporary, temporaryIdentity)) !== "match"
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        "Scaffolding journal temporary path was replaced concurrently."
      );
    }
    await rename(temporary, path);
    renamed = true;
    await syncDirectory(parent);
    return temporaryIdentity;
  } finally {
    if (!renamed && temporaryIdentity !== undefined) {
      const ownership = await pathMatchesFileIdentity(
        temporary,
        temporaryIdentity
      );
      if (ownership === "match") {
        await rm(temporary);
        await syncDirectory(parent);
      }
    }
  }
}

export async function writeAuthorityScaffoldJournal(
  path: string,
  journal: AuthorityScaffoldJournal,
  faultInjector?: () => Promise<void> | void
): Promise<PortableFileIdentity> {
  return writeAuthorityJournalFile(path, journal, faultInjector);
}

interface ScaffoldJournalRecord {
  readonly identity: PortableFileIdentity;
  readonly journal: AuthorityScaffoldJournal;
}

async function readJournalSource(path: string): Promise<{
  readonly identity: PortableFileIdentity;
  readonly source: string;
} | undefined> {
  try {
    const result = await readBoundedRegularFile(path, MAX_SCAFFOLD_PLAN_BYTES);
    if (result.outcome === "invalid") {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        "Scaffolding recovery journal is not a bounded regular file."
      );
    }
    if (result.outcome === "changed") {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        "Scaffolding recovery journal changed while it was being read."
      );
    }
    return {
      identity: result.identity,
      source: result.bytes.toString("utf8")
    };
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

function assertAuthorityJournalOperationBindings(journal: AuthorityScaffoldJournal): void {
  if (journal.operations.length !== journal.plan.operations.length) {
    throw new ScaffoldError(
      "SCAFFOLD_RECOVERY_REQUIRED",
      "Scaffolding recovery journal operation evidence does not match its Plan."
    );
  }
  const planOperations = new Map(
    journal.plan.operations.map((operation) => [operation.id, operation])
  );
  const seen = new Set<string>();
  for (const operation of journal.operations) {
    const planned = planOperations.get(operation.operationId);
    if (
      planned === undefined ||
      planned.path !== operation.path ||
      seen.has(operation.operationId)
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        "Scaffolding recovery journal operation evidence is invalid."
      );
    }
    seen.add(operation.operationId);
  }
}

async function readScaffoldJournalRecord(
  path: string
): Promise<ScaffoldJournalRecord | undefined> {
  const record = await readJournalSource(path);
  if (record === undefined) {
    return undefined;
  }
  const value = parseStrictYamlSource(
    record.source,
    "scaffold-recovery-journal"
  );
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("schemaVersion" in value)
  ) {
    throw new ScaffoldError(
      "SCAFFOLD_RECOVERY_REQUIRED",
      "Scaffolding recovery journal is invalid."
    );
  }
  if (value.schemaVersion !== 1) {
    throw new ScaffoldError(
      "SCAFFOLD_RECOVERY_REQUIRED",
      "A released 0.5 scaffolding journal must be recovered before upgrading."
    );
  }
  await assertSchema(
    "scaffold-recovery-journal",
    value,
    "scaffold-recovery-journal"
  );
  const journal = value as AuthorityScaffoldJournal;
  await assertSchema(
    "scaffold-plan",
    journal.plan,
    "scaffold-recovery-journal"
  );
  assertAuthorityScaffoldPlanDigest(journal.plan);
  assertAuthorityJournalOperationBindings(journal);
  return { identity: record.identity, journal };
}

export async function readScaffoldJournalEnvelope(
  path: string
): Promise<AuthorityScaffoldJournal | undefined> {
  return (await readScaffoldJournalRecord(path))?.journal;
}

export async function captureExpectedAuthorityScaffoldJournal(
  path: string,
  expected: AuthorityScaffoldJournal
): Promise<PortableFileIdentity> {
  const record = await readScaffoldJournalRecord(path);
  if (
    record === undefined ||
    JSON.stringify(record.journal) !== JSON.stringify(expected)
  ) {
    throw new ScaffoldError(
      "SCAFFOLD_RECOVERY_REQUIRED",
      "Scaffolding recovery journal changed before finalization."
    );
  }
  return record.identity;
}

export async function assertAuthorityScaffoldJournalTemporaryAbsent(
  path: string
): Promise<void> {
  const temporary = `${path}.tmp`;
  try {
    await lstat(temporary);
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }
  // Creator-handle identity does not survive a crash, so restart recovery has
  // no evidence that authorizes promotion or deletion of this path.
  throw new ScaffoldError(
    "SCAFFOLD_RECOVERY_REQUIRED",
    "Scaffolding journal temporary cannot be proven transaction-owned; it was preserved and requires manual recovery."
  );
}

export async function removeExpectedAuthorityScaffoldJournal(
  path: string,
  expectedIdentity: PortableFileIdentity,
  faultInjector?: () => Promise<void> | void
): Promise<void> {
  if ((await pathMatchesFileIdentity(path, expectedIdentity)) !== "match") {
    throw new ScaffoldError(
      "SCAFFOLD_RECOVERY_REQUIRED",
      "Scaffolding journal changed before it could be removed."
    );
  }
  await rm(path);
  await faultInjector?.();
  await syncDirectory(dirname(path));
}
