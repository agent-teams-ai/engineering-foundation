import { link, mkdir, open, readdir, rename, rm, rmdir, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { TextDecoder } from "node:util";

import {
  canonicalJson,
  type CanonicalJsonValue
} from "../../../canonical-json.js";
import { FOUNDATION_TRANSACTION_FILE } from "../../../foundation-state-contract.js";
import type {
  DocumentJournalStore,
  JournalIdentity,
  StoredDocumentJournal
} from "../../application/ports/document-journal-store.js";
import type { DocumentTransactionEnvelope } from "../../application/model/document-transaction.js";
import { assertDocumentTransactionEnvelope } from "../../application/policies/document-transaction-envelope-policy.js";
import type { PortablePathIdentity } from "../../../repository-mutation/application/model/path-identity.js";
import {
  captureFileHandleIdentity,
  pathMatchesRegularFileIdentity,
  readBoundedRegularFile
} from "../../../repository-mutation/adapters/node/node-bounded-regular-file.js";
import { syncDirectoryStrictly } from "../../../repository-mutation/adapters/node/node-directory-durability.js";
import { parseStrictJson } from "../../../strict-json.js";

const maximumJournalBytes = 32 * 1024 * 1024;
const maximumDirectoryEntries = 1024;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type NodeDocumentJournalFaultPoint =
  | { readonly phase: "after-candidate-synced" }
  | { readonly phase: "after-canonical-quarantined" }
  | { readonly phase: "after-canonical-published" }
  | { readonly phase: "after-quarantine-removed" }
  | {
      readonly operation: "create" | "remove" | "replace";
      readonly phase: "before-final-directory-sync";
    }
  | { readonly phase: "before-reconciliation-directory-sync" }
  | {
      readonly evidence: "candidate" | "quarantine";
      readonly operation: "create" | "remove" | "replace";
      readonly path: string;
      readonly phase: "before-private-cleanup";
    }
  | {
      readonly operation: "remove" | "replace";
      readonly path: string;
      readonly phase: "before-shared-quarantine";
    };

export type NodeDocumentJournalFaultInjector = (
  point: NodeDocumentJournalFaultPoint
) => Promise<void> | void;

export class NodeDocumentJournalStoreError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NodeDocumentJournalStoreError";
  }
}

interface NodeDocumentJournalOperations {
  readonly faultInjector?: NodeDocumentJournalFaultInjector;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function portableIdentity(identity: JournalIdentity): PortablePathIdentity {
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(identity.authorityDigest) ||
    !/^[1-9][0-9]{0,19}$/u.test(identity.dev) ||
    !/^[1-9][0-9]{0,19}$/u.test(identity.ino) ||
    !/^[1-9][0-9]{0,19}$/u.test(identity.birthtimeNs)
  ) {
    throw new NodeDocumentJournalStoreError(
      "Document journal identity is invalid or zero."
    );
  }
  return {
    birthtimeNs: BigInt(identity.birthtimeNs),
    dev: BigInt(identity.dev),
    ino: BigInt(identity.ino)
  };
}

function contentDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function journalIdentity(
  identity: PortablePathIdentity,
  authorityDigest: `sha256:${string}`
): JournalIdentity {
  const result: JournalIdentity = {
    adapter: "node-filesystem",
    version: 1,
    authorityDigest,
    birthtimeNs: identity.birthtimeNs.toString(),
    dev: identity.dev.toString(),
    ino: identity.ino.toString()
  };
  portableIdentity(result);
  return result;
}

async function canonicalEnvelopeBytes(
  envelope: DocumentTransactionEnvelope
): Promise<Buffer> {
  const validated = await assertDocumentTransactionEnvelope(envelope);
  const bytes = Buffer.from(
    `${canonicalJson(validated as unknown as CanonicalJsonValue)}\n`,
    "utf8"
  );
  if (bytes.byteLength > maximumJournalBytes) {
    throw new NodeDocumentJournalStoreError(
      "Document journal exceeds its strict size limit."
    );
  }
  return bytes;
}

function quarantineName(canonicalName: string, identity: JournalIdentity): string {
  portableIdentity(identity);
  return `${canonicalName}.document-quarantine.${identity.dev}.${identity.ino}.${identity.birthtimeNs}.${randomUUID()}`;
}

function retiredName(canonicalName: string): string {
  return `${canonicalName}.document-retired.${randomUUID()}`;
}

async function createPrivateEvidencePath(
  parent: string,
  directoryName: string
): Promise<{ readonly directory: string; readonly path: string }> {
  const directory = join(parent, directoryName);
  await mkdir(directory, { mode: 0o700 });
  return { directory, path: join(directory, "evidence") };
}

interface JournalAuthority {
  readonly identity: JournalIdentity;
  readonly digest: `sha256:${string}`;
}

async function proveAuthority(
  path: string,
  expected: JournalIdentity,
  description: string
): Promise<JournalAuthority> {
  const observed = await readBoundedRegularFile(path, maximumJournalBytes);
  if (
    observed.outcome !== "read" ||
    (await pathMatchesRegularFileIdentity(path, portableIdentity(expected))) !==
      "match" ||
    contentDigest(observed.bytes) !== expected.authorityDigest
  ) {
    throw new NodeDocumentJournalStoreError(
      `${description} identity or canonical bytes changed concurrently; all evidence was preserved.`
    );
  }
  return { digest: expected.authorityDigest, identity: expected };
}

export class NodeDocumentJournalStore implements DocumentJournalStore {
  readonly #candidatePath: string;
  readonly #canonicalName: string;
  readonly #parent: string;

  public constructor(
    readonly journalPath: string,
    readonly operations: NodeDocumentJournalOperations = {}
  ) {
    this.#parent = dirname(journalPath);
    this.#canonicalName = basename(journalPath);
    if (this.#canonicalName !== FOUNDATION_TRANSACTION_FILE) {
      throw new NodeDocumentJournalStoreError(
        "Document journal store must use the historical Foundation transaction slot."
      );
    }
    this.#candidatePath = join(
      this.#parent,
      `${this.#canonicalName}.document-transition`
    );
  }

  async #assertNoTransitionEvidence(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.#parent);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new NodeDocumentJournalStoreError(
          "Foundation state directory must exist before journal access.",
          { cause: error }
        );
      }
      throw error;
    }
    if (entries.length > maximumDirectoryEntries) {
      throw new NodeDocumentJournalStoreError(
        "Document journal directory contains too many entries to inspect safely."
      );
    }
    const quarantinePrefix = `${this.#canonicalName}.document-quarantine.`;
    const retiredPrefix = `${this.#canonicalName}.document-retired.`;
    if (
      entries.includes(basename(this.#candidatePath)) ||
      entries.some(
        (entry) =>
          entry.startsWith(quarantinePrefix) ||
          entry.startsWith(retiredPrefix)
      )
    ) {
      throw new NodeDocumentJournalStoreError(
        "Incomplete document journal transition evidence was preserved and requires recovery."
      );
    }
  }

  async #retireOwnedEvidence(
    path: string,
    expected: JournalIdentity,
    operation: "create" | "remove" | "replace",
    evidence: "candidate" | "quarantine",
    description: string
  ): Promise<void> {
    await proveAuthority(path, expected, description);
    await this.operations.faultInjector?.({
      evidence,
      operation,
      path,
      phase: "before-private-cleanup"
    });
    await proveAuthority(path, expected, description);
    const retired = await createPrivateEvidencePath(
      this.#parent,
      retiredName(this.#canonicalName)
    );
    const sourceDirectory = dirname(path);
    await rename(path, retired.path);
    await proveAuthority(retired.path, expected, `Retired ${description}`);
    // `retired.path` lives in a fresh 0700 operation-private directory and is
    // never exposed as mutation authority. Pure Node has no unlink-by-handle
    // primitive; the
    // operation lease and same-UID threat boundary bound the cleanup window.
    await rm(retired.path);
    await rmdir(retired.directory);
    if (sourceDirectory !== this.#parent) {
      await rmdir(sourceDirectory);
    }
  }

  async #prepareCandidate(
    envelope: DocumentTransactionEnvelope
  ): Promise<JournalIdentity> {
    const bytes = await canonicalEnvelopeBytes(envelope);
    let handle: FileHandle;
    try {
      handle = await open(this.#candidatePath, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new NodeDocumentJournalStoreError(
          "Document journal transition candidate already exists and was preserved.",
          { cause: error }
        );
      }
      throw error;
    }
    let identity: JournalIdentity;
    try {
      identity = journalIdentity(
        await captureFileHandleIdentity(handle),
        contentDigest(bytes)
      );
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await proveAuthority(
      this.#candidatePath,
      identity,
      "Document journal transition candidate"
    );
    await syncDirectoryStrictly(this.#parent);
    await this.operations.faultInjector?.({ phase: "after-candidate-synced" });
    return identity;
  }

  async read(): Promise<StoredDocumentJournal | undefined> {
    await this.#assertNoTransitionEvidence();
    let record;
    try {
      record = await readBoundedRegularFile(
        this.journalPath,
        maximumJournalBytes
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    if (record.outcome !== "read") {
      throw new NodeDocumentJournalStoreError(
        "Document journal is not a stable bounded regular file."
      );
    }
    let envelope: DocumentTransactionEnvelope;
    try {
      envelope = await assertDocumentTransactionEnvelope(
        parseStrictJson(strictUtf8.decode(record.bytes))
      );
    } catch (error) {
      throw new NodeDocumentJournalStoreError(
        "Document journal contains invalid strict canonical JSON.",
        { cause: error }
      );
    }
    if (!record.bytes.equals(await canonicalEnvelopeBytes(envelope))) {
      throw new NodeDocumentJournalStoreError(
        "Document journal JSON is not in canonical byte form."
      );
    }
    return {
      envelope,
      identity: journalIdentity(record.identity, contentDigest(record.bytes))
    };
  }

  public async stabilizeForReconciliation(): Promise<StoredDocumentJournal | undefined> {
    await this.operations.faultInjector?.({
      phase: "before-reconciliation-directory-sync"
    });
    await syncDirectoryStrictly(this.#parent);
    await this.#assertNoTransitionEvidence();
    return this.read();
  }

  async create(envelope: DocumentTransactionEnvelope): Promise<JournalIdentity> {
    await this.#assertNoTransitionEvidence();
    const identity = await this.#prepareCandidate(envelope);
    try {
      await link(this.#candidatePath, this.journalPath);
    } catch (error) {
      throw new NodeDocumentJournalStoreError(
        "Canonical document journal slot is occupied; transition evidence was preserved.",
        { cause: error }
      );
    }
    await proveAuthority(this.journalPath, identity, "Canonical document journal");
    await syncDirectoryStrictly(this.#parent);
    await this.operations.faultInjector?.({ phase: "after-canonical-published" });
    await this.#retireOwnedEvidence(
      this.#candidatePath,
      identity,
      "create",
      "candidate",
      "Document journal transition candidate"
    );
    await proveAuthority(
      this.journalPath,
      identity,
      "Canonical document journal"
    );
    await this.operations.faultInjector?.({
      operation: "create",
      phase: "before-final-directory-sync"
    });
    await syncDirectoryStrictly(this.#parent);
    return identity;
  }

  async replace(request: {
    readonly expectedIdentity: JournalIdentity;
    readonly envelope: DocumentTransactionEnvelope;
  }): Promise<JournalIdentity> {
    await this.#assertNoTransitionEvidence();
    const expected = request.expectedIdentity;
    await proveAuthority(this.journalPath, expected, "Canonical document journal");
    const candidateIdentity = await this.#prepareCandidate(request.envelope);
    await proveAuthority(
      this.journalPath,
      expected,
      "Canonical document journal"
    );
    const quarantine = await createPrivateEvidencePath(
      this.#parent,
      quarantineName(this.#canonicalName, expected)
    );
    await this.operations.faultInjector?.({
      operation: "replace",
      path: this.journalPath,
      phase: "before-shared-quarantine"
    });
    try {
      await rename(this.journalPath, quarantine.path);
    } catch (error) {
      throw new NodeDocumentJournalStoreError(
        "Document journal could not enter its verified quarantine transition; evidence was preserved.",
        { cause: error }
      );
    }
    await proveAuthority(quarantine.path, expected, "Quarantined document journal");
    await syncDirectoryStrictly(this.#parent);
    await this.operations.faultInjector?.({
      phase: "after-canonical-quarantined"
    });
    try {
      await link(this.#candidatePath, this.journalPath);
    } catch (error) {
      throw new NodeDocumentJournalStoreError(
        "Canonical document journal slot changed during transition; all evidence was preserved.",
        { cause: error }
      );
    }
    await proveAuthority(
      this.journalPath,
      candidateIdentity,
      "Replacement document journal"
    );
    await syncDirectoryStrictly(this.#parent);
    await this.operations.faultInjector?.({ phase: "after-canonical-published" });
    await this.#retireOwnedEvidence(
      this.#candidatePath,
      candidateIdentity,
      "replace",
      "candidate",
      "Document journal transition candidate"
    );
    await this.#retireOwnedEvidence(
      quarantine.path,
      expected,
      "replace",
      "quarantine",
      "Quarantined document journal"
    );
    await proveAuthority(
      this.journalPath,
      candidateIdentity,
      "Replacement document journal"
    );
    await this.operations.faultInjector?.({
      operation: "replace",
      phase: "before-final-directory-sync"
    });
    await syncDirectoryStrictly(this.#parent);
    await this.operations.faultInjector?.({ phase: "after-quarantine-removed" });
    return candidateIdentity;
  }

  async remove(expectedIdentity: JournalIdentity): Promise<void> {
    await this.#assertNoTransitionEvidence();
    await proveAuthority(
      this.journalPath,
      expectedIdentity,
      "Canonical document journal"
    );
    const quarantine = await createPrivateEvidencePath(
      this.#parent,
      quarantineName(this.#canonicalName, expectedIdentity)
    );
    await proveAuthority(
      this.journalPath,
      expectedIdentity,
      "Canonical document journal"
    );
    await this.operations.faultInjector?.({
      operation: "remove",
      path: this.journalPath,
      phase: "before-shared-quarantine"
    });
    try {
      await rename(this.journalPath, quarantine.path);
    } catch (error) {
      throw new NodeDocumentJournalStoreError(
        "Document journal could not enter its verified removal quarantine.",
        { cause: error }
      );
    }
    await proveAuthority(
      quarantine.path,
      expectedIdentity,
      "Quarantined document journal"
    );
    await syncDirectoryStrictly(this.#parent);
    await this.operations.faultInjector?.({
      phase: "after-canonical-quarantined"
    });
    await this.#retireOwnedEvidence(
      quarantine.path,
      expectedIdentity,
      "remove",
      "quarantine",
      "Quarantined document journal"
    );
    await this.operations.faultInjector?.({
      operation: "remove",
      phase: "before-final-directory-sync"
    });
    await syncDirectoryStrictly(this.#parent);
    await this.operations.faultInjector?.({ phase: "after-quarantine-removed" });
  }
}
