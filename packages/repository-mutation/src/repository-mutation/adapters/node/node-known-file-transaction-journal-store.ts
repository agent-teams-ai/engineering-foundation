import type { KnownFileCoordination } from "./known-file-coordination.js";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { knownFileStateNames } from "../../application/policies/known-file-state-names.js";

import type { KnownFileTransactionEnvelopeV1 } from "../../application/model/known-file-transaction-journal.js";
import { encodeKnownFileTransactionEnvelope, decodeKnownFileTransactionEnvelope, MAXIMUM_KNOWN_FILE_JOURNAL_BYTES } from "../../application/policies/known-file-transaction-envelope.js";

import { cleanupIdentityMatchingOwnedTemporary } from "./node-cleanup-owned-temporary.js";
import { syncDirectoryDurably, syncDirectoryStrictly } from "./node-directory-durability.js";

export interface KnownFileJournalAuthority {
  readonly digest: `sha256:${string}`;
  readonly identity: Awaited<ReturnType<KnownFileCoordination["captureFileHandleIdentity"]>>;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function readEnvelope(coordination: Pick<KnownFileCoordination, "readBoundedRegularFile">,
  path: string,
  expectedOwner: KnownFileTransactionEnvelopeV1["ownerArtifact"],
  expectedKernel: KnownFileTransactionEnvelopeV1["ownerArtifact"]
): Promise<{
  readonly authority: KnownFileJournalAuthority;
  readonly envelope: KnownFileTransactionEnvelopeV1;
} | undefined> {
  let observed;
  try {
    observed = await coordination.readBoundedRegularFile(path, MAXIMUM_KNOWN_FILE_JOURNAL_BYTES);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (observed.outcome !== "read") {
    throw new Error("Known-file transaction journal is not one stable regular file.");
  }
  const parsed = decodeKnownFileTransactionEnvelope(observed.bytes, expectedOwner, expectedKernel);
  return {
    envelope: parsed,
    authority: { digest: digest(observed.bytes), identity: observed.identity }
  };
}

async function prove(coordination: Pick<KnownFileCoordination, "pathMatchesRegularFileIdentity" | "readBoundedRegularFile">, path: string, authority: KnownFileJournalAuthority): Promise<void> {
  const observed = await coordination.readBoundedRegularFile(path, MAXIMUM_KNOWN_FILE_JOURNAL_BYTES);
  if (observed.outcome !== "read" || digest(observed.bytes) !== authority.digest ||
    await coordination.pathMatchesRegularFileIdentity(path, authority.identity) !== "match") {
    throw new Error("Known-file transaction journal authority changed concurrently.");
  }
}

async function proveMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {return;}
    throw error;
  }
  throw new Error("Known-file transaction journal pathname was recreated concurrently.");
}

export class NodeKnownFileTransactionJournalStore {
  readonly #journalPath: string;
  readonly #parent: string;
  readonly #temporaryPath: string;
  readonly #expectedOwner: KnownFileTransactionEnvelopeV1["ownerArtifact"];
  readonly #expectedKernel: KnownFileTransactionEnvelopeV1["ownerArtifact"];

  public constructor(private readonly coordination: Pick<KnownFileCoordination,
  "assertTerminalEvidenceDirectory"
  | "captureFileHandleIdentity"
  | "ensureTerminalEvidenceDirectory"
  | "pathMatchesRegularFileIdentity"
  | "readBoundedRegularFile"
>,
    stateDirectory: string,
    expectedOwner: KnownFileTransactionEnvelopeV1["ownerArtifact"],
    expectedKernel: KnownFileTransactionEnvelopeV1["ownerArtifact"]
  ) {
    this.#parent = stateDirectory;
    this.#journalPath = join(stateDirectory, knownFileStateNames.journal);
    this.#temporaryPath = join(stateDirectory, knownFileStateNames.candidate);
    this.#expectedOwner = expectedOwner;
    this.#expectedKernel = expectedKernel;
  }

  public async read(): Promise<Awaited<ReturnType<typeof readEnvelope>>> {
    const canonical = await readEnvelope(this.coordination, this.#journalPath, this.#expectedOwner, this.#expectedKernel);
    if (canonical !== undefined) {
      return canonical;
    }
    return readEnvelope(this.coordination, this.#temporaryPath, this.#expectedOwner, this.#expectedKernel);
  }

  async #writeTemporary(envelope: KnownFileTransactionEnvelopeV1): Promise<KnownFileJournalAuthority> {
    const content = encodeKnownFileTransactionEnvelope(envelope);
    let handle: FileHandle;
    try {
      handle = await open(this.#temporaryPath, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        const stale = await readEnvelope(this.coordination, this.#temporaryPath, this.#expectedOwner, this.#expectedKernel);
        if (stale === undefined) {
          throw error;
        }
        await prove(this.coordination, this.#temporaryPath, stale.authority);
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
      return { digest: digest(content), identity: await this.coordination.captureFileHandleIdentity(handle) };
    } finally {
      await handle.close();
    }
  }

  async #retireCanonical(expected: KnownFileJournalAuthority): Promise<void> {
    await prove(this.coordination, this.#journalPath, expected);
    const token = randomUUID();
    const quarantine = join(
      this.#parent,
      `${knownFileStateNames.quarantinePrefix}${token}`
    );
    const captured = join(quarantine, "evidence");
    const terminalRoot = await this.coordination.ensureTerminalEvidenceDirectory(join(
      this.#parent,
      knownFileStateNames.terminalEvidence
    ));
    const terminal = join(terminalRoot.path, token);
    await mkdir(quarantine, { mode: 0o700 });
    await prove(this.coordination, this.#journalPath, expected);
    await rename(this.#journalPath, captured);
    await syncDirectoryStrictly(quarantine);
    await syncDirectoryStrictly(this.#parent);
    try {
      await prove(this.coordination, captured, expected);
    } catch (error) {
      // Restore a blocking name without deleting the atomically captured
      // replacement. EEXIST means another foreign barrier already occupies it.
      try {
        await link(captured, this.#journalPath);
        await syncDirectoryStrictly(this.#parent);
      } catch (restoreError) {
        if (errorCode(restoreError) !== "EEXIST") {throw restoreError;}
      }
      throw error;
    }
    await proveMissing(this.#journalPath);
    await this.coordination.assertTerminalEvidenceDirectory(terminalRoot);
    await rename(quarantine, terminal);
    await syncDirectoryStrictly(terminalRoot.path);
    await syncDirectoryStrictly(this.#parent);
    await prove(this.coordination, join(terminal, "evidence"), expected);
    await proveMissing(this.#journalPath);
  }

  async #publishTemporary(authority: KnownFileJournalAuthority): Promise<void> {
    await prove(this.coordination, this.#temporaryPath, authority);
    await link(this.#temporaryPath, this.#journalPath);
    await prove(this.coordination, this.#journalPath, authority);
    await syncDirectoryStrictly(this.#parent);
    await prove(this.coordination, this.#journalPath, authority);
    const retired = await cleanupIdentityMatchingOwnedTemporary(this.coordination, {
      allowUnsupportedDirectoryDurability: false,
      displayPath: knownFileStateNames.candidate,
      expectedIdentity: authority.identity,
      parent: this.#parent,
      rm: async () => {},
      syncDirectory: syncDirectoryDurably,
      temporaryPath: this.#temporaryPath
    });
    if (retired !== "removed") {
      throw new Error("Known-file transaction candidate changed during retirement.");
    }
    await prove(this.coordination, this.#journalPath, authority);
  }

  public async create(envelope: KnownFileTransactionEnvelopeV1): Promise<KnownFileJournalAuthority> {
    if (await readEnvelope(this.coordination, this.#journalPath, this.#expectedOwner, this.#expectedKernel) !== undefined) {
      throw new Error("Foundation transaction slot is already occupied.");
    }
    const authority = await this.#writeTemporary(envelope);
    await this.#publishTemporary(authority);
    return authority;
  }

  public async replace(
    expected: KnownFileJournalAuthority,
    envelope: KnownFileTransactionEnvelopeV1
  ): Promise<KnownFileJournalAuthority> {
    await prove(this.coordination, this.#journalPath, expected);
    const authority = await this.#writeTemporary(envelope);
    await prove(this.coordination, this.#journalPath, expected);
    await prove(this.coordination, this.#temporaryPath, authority);
    await this.#retireCanonical(expected);
    await this.#publishTemporary(authority);
    return authority;
  }

  public async remove(expected: KnownFileJournalAuthority): Promise<void> {
    await this.#retireCanonical(expected);
  }

  public async canonicalizeTemporary(): Promise<void> {
    const canonical = await readEnvelope(this.coordination, this.#journalPath, this.#expectedOwner, this.#expectedKernel);
    if (canonical !== undefined) {
      // The canonical envelope remains authoritative during replacement. A
      // crash can leave an unbound candidate torn or foreign; recovery must
      // neither parse nor mutate that pathname. It remains preserved evidence
      // and must not be parsed as authority. Capture a stable regular
      // candidate by identity and retire it into terminal evidence so neither
      // a torn write nor a concurrent pathname replacement can block replay.
      let candidate;
      try {
        candidate = await this.coordination.readBoundedRegularFile(
          this.#temporaryPath,
          MAXIMUM_KNOWN_FILE_JOURNAL_BYTES
        );
      } catch (error) {
        if (errorCode(error) === "ENOENT") {return;}
        throw error;
      }
      if (candidate.outcome !== "read") {
        throw new Error("Known-file transaction candidate cannot be retired safely.");
      }
      const retired = await cleanupIdentityMatchingOwnedTemporary(this.coordination, {
        allowUnsupportedDirectoryDurability: false,
        displayPath: knownFileStateNames.candidate,
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
    const temporary = await readEnvelope(this.coordination, this.#temporaryPath, this.#expectedOwner, this.#expectedKernel);
    if (temporary === undefined) {
      throw new Error("Known-file recovery journal is absent.");
    }
    await prove(this.coordination, this.#temporaryPath, temporary.authority);
    await this.#publishTemporary(temporary.authority);
  }
}
