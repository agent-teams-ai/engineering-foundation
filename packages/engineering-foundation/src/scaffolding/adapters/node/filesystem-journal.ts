import { lstat, link, mkdir, open, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AuthorityScaffoldJournal } from "../../contract/types.js";
import { assertAuthorityScaffoldJournal } from "../../kernel/authority-journal-validation.js";
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
import { FOUNDATION_TRANSACTION_FILE } from "../../../foundation-state-contract.js";
import { sha256Bytes } from "../../kernel/canonical-json.js";

export const SCAFFOLD_JOURNAL_FILE = FOUNDATION_TRANSACTION_FILE;
export const SCAFFOLD_JOURNAL_QUARANTINE_PREFIX =
  `${FOUNDATION_TRANSACTION_FILE}.document-quarantine.`;
let quarantineSequence = 0;

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
  options: {
    readonly expectedAuthority?: ScaffoldJournalAuthority;
    readonly faultInjector?: (() => Promise<void> | void) | undefined;
  }
): Promise<ScaffoldJournalAuthority> {
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
    await options.faultInjector?.();
    const temporaryAuthority = {
      identity: temporaryIdentity,
      authorityDigest: contentDigest(Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8"))
    };
    if (!(await authorityMatches(temporary, temporaryAuthority))) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        "Scaffolding journal temporary path was replaced concurrently."
      );
    }
    const existing = options.expectedAuthority;
    let quarantine: { readonly directory: string; readonly path: string } | undefined;
    if (existing !== undefined) {
      quarantine = await createPrivateQuarantine(path, existing.identity);
      await rename(path, quarantine.path);
      await syncRenameBoundary(quarantine.directory, parent);
      if (!(await authorityMatches(quarantine.path, existing))) {
        throw recoveryRequired("Quarantined scaffolding journal changed concurrently.");
      }
    }
    try {
      await link(temporary, path);
    } catch (error) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        "Scaffolding journal slot changed during publication; all evidence was preserved.",
        [],
        { cause: error }
      );
    }
    if (!(await authorityMatches(path, temporaryAuthority))) {
      throw recoveryRequired("Published scaffolding journal changed concurrently.");
    }
    await syncDirectory(parent);
    await retirePrivateEvidence(temporary, temporaryAuthority, parent);
    renamed = true;
    if (quarantine !== undefined) {
      await retirePrivateEvidence(quarantine.path, existing!, quarantine.directory);
      await rmdir(quarantine.directory);
      await syncDirectory(parent);
    }
    return temporaryAuthority;
  } finally {
    if (!renamed && temporaryIdentity !== undefined) {
      const expected = {
        identity: temporaryIdentity,
        authorityDigest: contentDigest(Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8"))
      };
      if (await authorityMatches(temporary, expected)) {
        await retirePrivateEvidence(temporary, expected, parent);
      }
    }
  }
}

export async function writeAuthorityScaffoldJournal(
  path: string,
  journal: AuthorityScaffoldJournal,
  options: {
    readonly expectedAuthority?: ScaffoldJournalAuthority;
    readonly faultInjector?: (() => Promise<void> | void) | undefined;
  } = {}
): Promise<ScaffoldJournalAuthority> {
  return writeAuthorityJournalFile(path, journal, options);
}

export interface ScaffoldJournalRecord {
  readonly authorityDigest: string;
  readonly identity: PortableFileIdentity;
  readonly journal: AuthorityScaffoldJournal;
}

export interface ScaffoldJournalAuthority {
  readonly identity: PortableFileIdentity;
  readonly authorityDigest: string;
}

function contentDigest(bytes: Uint8Array): string {
  return sha256Bytes(bytes);
}

function recoveryRequired(message: string): ScaffoldError {
  return new ScaffoldError("SCAFFOLD_RECOVERY_REQUIRED", message);
}

async function authorityMatches(path: string, expected: ScaffoldJournalAuthority): Promise<boolean> {
  try {
    const observed = await readBoundedRegularFile(path, MAX_SCAFFOLD_PLAN_BYTES);
    return observed.outcome === "read" &&
      (await pathMatchesFileIdentity(path, expected.identity)) === "match" &&
      contentDigest(observed.bytes) === expected.authorityDigest;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

async function createPrivateQuarantine(path: string, identity: PortableFileIdentity) {
  const parent = dirname(path);
  for (;;) {
    quarantineSequence += 1;
    const directory = join(
      parent,
      `${SCAFFOLD_JOURNAL_QUARANTINE_PREFIX}${identity.dev}.${identity.ino}.${identity.birthtimeNs}.${process.pid}.${quarantineSequence}`
    );
    try {
      await mkdir(directory, { mode: 0o700 });
      return { directory, path: join(directory, "evidence") };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "EEXIST"
      ) {
        throw error;
      }
    }
  }
}

async function syncRenameBoundary(destination: string, source: string): Promise<void> {
  await syncDirectory(destination);
  if (destination !== source) {
    await syncDirectory(source);
  }
}

async function retirePrivateEvidence(
  path: string,
  expected: ScaffoldJournalAuthority,
  sourceDirectory: string
): Promise<void> {
  if (!(await authorityMatches(path, expected))) {
    throw recoveryRequired("Scaffolding journal evidence changed before retirement; it was preserved.");
  }
  const quarantine = await createPrivateQuarantine(path, expected.identity);
  await rename(path, quarantine.path);
  await syncRenameBoundary(quarantine.directory, sourceDirectory);
  if (!(await authorityMatches(quarantine.path, expected))) {
    throw recoveryRequired("Quarantined scaffolding journal evidence changed concurrently.");
  }
  await rm(quarantine.path);
  await syncDirectory(quarantine.directory);
  await rmdir(quarantine.directory);
  await syncDirectory(dirname(quarantine.directory));
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

export async function readScaffoldJournalRecord(
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
    "scaffold-recovery-journal/v1",
    value,
    "scaffold-recovery-journal"
  );
  const journal = value as AuthorityScaffoldJournal;
  await assertSchema(
    "scaffold-plan/v1",
    journal.plan,
    "scaffold-recovery-journal"
  );
  assertAuthorityScaffoldJournal(journal);
  return {
    authorityDigest: contentDigest(Buffer.from(record.source, "utf8")),
    identity: record.identity,
    journal
  };
}

export async function readScaffoldJournalEnvelope(
  path: string
): Promise<AuthorityScaffoldJournal | undefined> {
  return (await readScaffoldJournalRecord(path))?.journal;
}

export async function captureExpectedAuthorityScaffoldJournal(
  path: string,
  expected: AuthorityScaffoldJournal
): Promise<ScaffoldJournalAuthority> {
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
  return {
    identity: record.identity,
    authorityDigest: record.authorityDigest
  };
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
  expectedAuthority: ScaffoldJournalAuthority,
  faultInjector?: {
    readonly beforeQuarantine?: () => Promise<void> | void;
    readonly afterQuarantine?: () => Promise<void> | void;
  }
): Promise<void> {
  if (!(await authorityMatches(path, expectedAuthority))) {
    throw new ScaffoldError(
      "SCAFFOLD_RECOVERY_REQUIRED",
      "Scaffolding journal changed before it could be removed."
    );
  }
  const quarantine = await createPrivateQuarantine(path, expectedAuthority.identity);
  await faultInjector?.beforeQuarantine?.();
  await rename(path, quarantine.path);
  await syncRenameBoundary(quarantine.directory, dirname(path));
  if (!(await authorityMatches(quarantine.path, expectedAuthority))) {
    throw recoveryRequired("Quarantined scaffolding journal changed concurrently.");
  }
  await rm(quarantine.path);
  await syncDirectory(quarantine.directory);
  await rmdir(quarantine.directory);
  await syncDirectory(dirname(path));
  await faultInjector?.afterQuarantine?.();
}
