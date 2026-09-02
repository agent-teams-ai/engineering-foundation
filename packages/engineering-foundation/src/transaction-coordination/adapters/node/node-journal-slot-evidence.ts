import { mkdir, open, opendir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import {
  captureFileHandleIdentity,
  pathMatchesRegularFileIdentity,
  readBoundedRegularFile
} from "@agent-teams/repository-mutation/node";
import { sha256Bytes, type PortablePathIdentity } from "@agent-teams/repository-mutation";
import type {
  JournalSlotAuthority,
  JournalSlotFailureFactory,
  JournalSlotResidueMatcher,
  StoredJournalSlot
} from "./node-journal-slot-profile.js";

const MAXIMUM_DIRECTORY_ENTRIES = 1024;

function journalSlotErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function journalSlotAuthority(
  identity: PortablePathIdentity,
  bytes: Uint8Array
): JournalSlotAuthority {
  return { authorityDigest: sha256Bytes(bytes), identity };
}

export async function observeJournalSlotAuthority(
  path: string,
  expected: JournalSlotAuthority,
  maximumBytes: number
): Promise<"match" | "missing" | "other"> {
  try {
    const observed = await readBoundedRegularFile(path, maximumBytes);
    if (observed.outcome !== "read") {
      return "other";
    }
    return (await pathMatchesRegularFileIdentity(path, expected.identity)) === "match" &&
        sha256Bytes(observed.bytes) === expected.authorityDigest
      ? "match"
      : "other";
  } catch (error) {
    if (journalSlotErrorCode(error) === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

export async function journalSlotPathExists(
  path: string,
  maximumBytes: number
): Promise<boolean> {
  try {
    await readBoundedRegularFile(path, maximumBytes);
    return true;
  } catch (error) {
    if (journalSlotErrorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readJournalSlot<TJournal>(options: {
  readonly failure: JournalSlotFailureFactory;
  readonly maximumBytes: number;
  readonly parse: (bytes: Buffer) => Promise<TJournal>;
  readonly path: string;
}): Promise<StoredJournalSlot<TJournal> | undefined> {
  let observed;
  try {
    observed = await readBoundedRegularFile(options.path, options.maximumBytes);
  } catch (error) {
    if (journalSlotErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (observed.outcome !== "read") {
    throw options.failure("not-regular-file", {});
  }
  return {
    authority: journalSlotAuthority(observed.identity, observed.bytes),
    journal: await options.parse(observed.bytes)
  };
}

function matchesResidue(entry: string, matcher: JournalSlotResidueMatcher): boolean {
  return "exact" in matcher
    ? entry === matcher.exact
    : entry.startsWith(matcher.prefix);
}

export async function journalSlotResidueNames(options: {
  readonly failure: JournalSlotFailureFactory;
  readonly matchers: readonly JournalSlotResidueMatcher[];
  readonly parent: string;
}): Promise<readonly string[]> {
  let directory;
  try {
    directory = await opendir(options.parent);
  } catch (error) {
    if (journalSlotErrorCode(error) === "ENOENT") {
      throw options.failure("state-directory-missing", { cause: error });
    }
    throw error;
  }
  const residues: string[] = [];
  let entries = 0;
  try {
    for (;;) {
      const entry = await directory.read();
      if (entry === null) {
        break;
      }
      entries += 1;
      if (entries > MAXIMUM_DIRECTORY_ENTRIES) {
        throw options.failure("too-many-entries", {});
      }
      if (options.matchers.some((matcher) => matchesResidue(entry.name, matcher))) {
        residues.push(entry.name);
      }
    }
  } finally {
    await directory.close();
  }
  return residues.toSorted();
}

/**
 * Creates one private evidence directory. Owners choose the naming; a name
 * collision retries with the next generated name so concurrent retirements
 * never share a directory.
 */
export async function createPrivateJournalSlotDirectory(
  parent: string,
  name: () => string
): Promise<{ readonly directory: string; readonly path: string }> {
  for (;;) {
    const directory = join(parent, name());
    try {
      await mkdir(directory, { mode: 0o700 });
      return { directory, path: join(directory, "evidence") };
    } catch (error) {
      if (journalSlotErrorCode(error) !== "EEXIST") {
        throw error;
      }
    }
  }
}

export async function prepareJournalSlotCandidate(options: {
  readonly bytes: Buffer;
  readonly candidatePath: string;
  readonly failure: JournalSlotFailureFactory;
}): Promise<JournalSlotAuthority> {
  let handle: FileHandle;
  try {
    handle = await open(options.candidatePath, "wx", 0o600);
  } catch (error) {
    throw options.failure(
      journalSlotErrorCode(error) === "EEXIST"
        ? "candidate-exists"
        : "candidate-unavailable",
      { cause: error }
    );
  }
  try {
    await handle.writeFile(options.bytes);
    await handle.sync();
    return journalSlotAuthority(
      await captureFileHandleIdentity(handle),
      options.bytes
    );
  } finally {
    await handle.close();
  }
}
