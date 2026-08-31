import { createHash } from "node:crypto";
import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import { canonicalJson, type CanonicalJsonValue } from "../../../canonical-json.js";
import {
  FOUNDATION_TRANSACTION_FILE,
  KNOWN_FILE_TRANSACTION_TEMPORARY_FILE
} from "../../../state-contract.js";
import { parseStrictJson } from "../../../strict-json.js";
import type { KnownFileTransactionEnvelopeV1 } from "../../application/model/known-file-transaction-journal.js";
import { assertKnownFileTransactionEnvelope } from "../../application/policies/known-file-transaction-envelope.js";
import {
  captureFileHandleIdentity,
  pathMatchesRegularFileIdentity,
  readBoundedRegularFile
} from "./node-bounded-regular-file.js";
import { cleanupIdentityMatchingOwnedTemporary } from "./node-cleanup-owned-temporary.js";
import { syncDirectoryDurably, syncDirectoryStrictly } from "./node-directory-durability.js";

const MAXIMUM_JOURNAL_BYTES = 32 * 1024 * 1024;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface KnownFileJournalAuthority {
  readonly digest: `sha256:${string}`;
  readonly identity: Awaited<ReturnType<typeof captureFileHandleIdentity>>;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function bytes(envelope: KnownFileTransactionEnvelopeV1): Buffer {
  assertKnownFileTransactionEnvelope(envelope);
  const result = Buffer.from(
    `${canonicalJson(envelope as unknown as CanonicalJsonValue)}\n`,
    "utf8"
  );
  if (result.byteLength > MAXIMUM_JOURNAL_BYTES) {
    throw new Error("Known-file transaction journal exceeds its byte limit.");
  }
  return result;
}

async function readEnvelope(path: string): Promise<{
  readonly authority: KnownFileJournalAuthority;
  readonly envelope: KnownFileTransactionEnvelopeV1;
} | undefined> {
  let observed;
  try {
    observed = await readBoundedRegularFile(path, MAXIMUM_JOURNAL_BYTES);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (observed.outcome !== "read") {
    throw new Error("Known-file transaction journal is not one stable regular file.");
  }
  const parsed = parseStrictJson(strictUtf8.decode(observed.bytes));
  assertKnownFileTransactionEnvelope(parsed);
  if (!observed.bytes.equals(bytes(parsed))) {
    throw new Error("Known-file transaction journal bytes are not canonical.");
  }
  return {
    envelope: parsed,
    authority: { digest: digest(observed.bytes), identity: observed.identity }
  };
}

async function prove(path: string, authority: KnownFileJournalAuthority): Promise<void> {
  const observed = await readBoundedRegularFile(path, MAXIMUM_JOURNAL_BYTES);
  if (observed.outcome !== "read" || digest(observed.bytes) !== authority.digest ||
    await pathMatchesRegularFileIdentity(path, authority.identity) !== "match") {
    throw new Error("Known-file transaction journal authority changed concurrently.");
  }
}

export class NodeKnownFileTransactionJournalStore {
  readonly #journalPath: string;
  readonly #parent: string;
  readonly #temporaryPath: string;

  public constructor(stateDirectory: string) {
    this.#parent = stateDirectory;
    this.#journalPath = join(stateDirectory, FOUNDATION_TRANSACTION_FILE);
    this.#temporaryPath = join(stateDirectory, KNOWN_FILE_TRANSACTION_TEMPORARY_FILE);
  }

  public async read(): Promise<Awaited<ReturnType<typeof readEnvelope>>> {
    const canonical = await readEnvelope(this.#journalPath);
    if (canonical !== undefined) {
      return canonical;
    }
    return readEnvelope(this.#temporaryPath);
  }

  async #writeTemporary(envelope: KnownFileTransactionEnvelopeV1): Promise<KnownFileJournalAuthority> {
    const content = bytes(envelope);
    let handle: FileHandle;
    try {
      handle = await open(this.#temporaryPath, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        const stale = await readEnvelope(this.#temporaryPath);
        if (stale === undefined) {
          throw error;
        }
        await prove(this.#temporaryPath, stale.authority);
        await unlink(this.#temporaryPath);
        await syncDirectoryStrictly(this.#parent);
        handle = await open(this.#temporaryPath, "wx", 0o600);
      } else {
        throw error;
      }
    }
    try {
      await handle.writeFile(content);
      await handle.sync();
      return { digest: digest(content), identity: await captureFileHandleIdentity(handle) };
    } finally {
      await handle.close();
    }
  }

  public async create(envelope: KnownFileTransactionEnvelopeV1): Promise<KnownFileJournalAuthority> {
    if (await readEnvelope(this.#journalPath) !== undefined) {
      throw new Error("Foundation transaction slot is already occupied.");
    }
    const authority = await this.#writeTemporary(envelope);
    await prove(this.#temporaryPath, authority);
    await rename(this.#temporaryPath, this.#journalPath);
    await syncDirectoryStrictly(this.#parent);
    await prove(this.#journalPath, authority);
    return authority;
  }

  public async replace(
    expected: KnownFileJournalAuthority,
    envelope: KnownFileTransactionEnvelopeV1
  ): Promise<KnownFileJournalAuthority> {
    await prove(this.#journalPath, expected);
    const authority = await this.#writeTemporary(envelope);
    await prove(this.#journalPath, expected);
    await prove(this.#temporaryPath, authority);
    await rename(this.#temporaryPath, this.#journalPath);
    await syncDirectoryStrictly(this.#parent);
    await prove(this.#journalPath, authority);
    return authority;
  }

  public async remove(expected: KnownFileJournalAuthority): Promise<void> {
    await prove(this.#journalPath, expected);
    await unlink(this.#journalPath);
    await syncDirectoryStrictly(this.#parent);
  }

  public async canonicalizeTemporary(): Promise<void> {
    const canonical = await readEnvelope(this.#journalPath);
    if (canonical !== undefined) {
      // The canonical envelope remains authoritative during replacement. A
      // crash can leave an unbound candidate torn or foreign; recovery must
      // neither parse nor mutate that pathname. It remains preserved evidence
      // and must not be parsed as authority. Capture a stable regular
      // candidate by identity and retire it into terminal evidence so neither
      // a torn write nor a concurrent pathname replacement can block replay.
      let candidate;
      try {
        candidate = await readBoundedRegularFile(
          this.#temporaryPath,
          MAXIMUM_JOURNAL_BYTES
        );
      } catch (error) {
        if (errorCode(error) === "ENOENT") {return;}
        throw error;
      }
      if (candidate.outcome !== "read") {
        throw new Error("Known-file transaction candidate cannot be retired safely.");
      }
      const retired = await cleanupIdentityMatchingOwnedTemporary({
        allowUnsupportedDirectoryDurability: false,
        displayPath: KNOWN_FILE_TRANSACTION_TEMPORARY_FILE,
        expectedIdentity: candidate.identity,
        parent: this.#parent,
        rm: async () => {},
        syncDirectory: syncDirectoryDurably,
        temporaryPath: this.#temporaryPath
      });
      if (retired === "different") {
        throw new Error("Known-file transaction candidate changed during retirement.");
      }
      return;
    }
    const temporary = await readEnvelope(this.#temporaryPath);
    if (temporary === undefined) {
      throw new Error("Known-file recovery journal is absent.");
    }
    await prove(this.#temporaryPath, temporary.authority);
    await rename(this.#temporaryPath, this.#journalPath);
    await syncDirectoryStrictly(this.#parent);
  }
}
