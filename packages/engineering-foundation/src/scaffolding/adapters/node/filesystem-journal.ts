import { link, mkdir, open, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { AuthorityScaffoldJournal } from "../../contract/types.js";
import { ScaffoldError } from "../../scaffold-error.js";
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
import {
  assertTerminalEvidenceDirectory,
  ensureTerminalEvidenceDirectory
} from "@agent-teams/repository-mutation";

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
  const terminalRoot = join(
    dirname(quarantine.directory),
    `${FOUNDATION_TRANSACTION_FILE}.completed-scaffold-evidence`
  );
  const terminalAuthority = await ensureTerminalEvidenceDirectory(terminalRoot);
  await syncDirectory(dirname(quarantine.directory));
  const terminalDirectory = join(terminalRoot, basename(quarantine.directory));
  await assertTerminalEvidenceDirectory(terminalAuthority);
  await rename(quarantine.directory, terminalDirectory);
  await syncDirectory(terminalRoot);
  await syncDirectory(dirname(quarantine.directory));
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
  const terminalRoot = join(
    dirname(quarantine.directory),
    `${FOUNDATION_TRANSACTION_FILE}.completed-scaffold-evidence`
  );
  const terminalAuthority = await ensureTerminalEvidenceDirectory(terminalRoot);
  await syncDirectory(dirname(quarantine.directory));
  const terminalDirectory = join(terminalRoot, basename(quarantine.directory));
  await assertTerminalEvidenceDirectory(terminalAuthority);
  await rename(quarantine.directory, terminalDirectory);
  await syncDirectory(terminalRoot);
  await syncDirectory(dirname(path));
  await faultInjector?.afterQuarantine?.();
}
