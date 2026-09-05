import { assertSchema } from "./schema-catalog.js";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { TextDecoder } from "node:util";

import {
  NodeJournalSlotStore,
  syncDirectoryStrictly,
  type JournalSlotAuthority,
  type JournalSlotFailure,
  type JournalSlotFailureContext,
  type JournalSlotFaultPoint,
  type JournalSlotSubject
} from "@agent-teams/repository-mutation/node";
import { canonicalJson, parseStrictJson, type PortablePathIdentity, type CanonicalJsonValue } from "@agent-teams/repository-mutation";

import { FOUNDATION_TRANSACTION_FILE } from "../../application/model/state-contract.js";

import type { DocumentTransactionEnvelope } from "../../application/model/document-transaction.js";
import { assertDocumentTransactionEnvelope } from "../../application/policies/document-transaction-envelope-policy.js";
import { untrustedDocumentEnvelopeReason } from "../../application/policies/project-document-transaction-inspection.js";
import type {
  DocumentJournalStore,
  JournalAuthority,
  JournalIdentity,
  StoredDocumentJournal
} from "../../application/ports/document-journal-store.js";
import type { NodeDocumentJournalFaultInjector } from "./node-document-journal-store-faults.js";

const maximumJournalBytes = 32 * 1024 * 1024;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type NodeDocumentJournalFaultPoint = Parameters<NodeDocumentJournalFaultInjector>[0];

export class NodeDocumentJournalStoreError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NodeDocumentJournalStoreError";
  }
}

interface NodeDocumentJournalOperations {
  readonly faultInjector?: NodeDocumentJournalFaultInjector;
}

function portableIdentity(identity: JournalIdentity): PortablePathIdentity {
  if (
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

function journalIdentity(identity: PortablePathIdentity): JournalIdentity {
  const result: JournalIdentity = {
    adapter: "node-filesystem",
    version: 1,
    birthtimeNs: identity.birthtimeNs.toString(),
    dev: identity.dev.toString(),
    ino: identity.ino.toString()
  };
  portableIdentity(result);
  return result;
}

function wireAuthority(authority: JournalSlotAuthority): JournalAuthority {
  return {
    authorityDigest: authority.authorityDigest,
    identity: journalIdentity(authority.identity)
  };
}

function slotAuthority(authority: JournalAuthority): JournalSlotAuthority {
  return {
    authorityDigest: authority.authorityDigest,
    identity: portableIdentity(authority.identity)
  };
}

async function canonicalEnvelopeBytes(
  envelope: DocumentTransactionEnvelope
): Promise<Buffer> {
  const validated = await assertDocumentTransactionEnvelope({ assertSchema }, envelope);
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

async function parseEnvelope(bytes: Buffer): Promise<DocumentTransactionEnvelope> {
  let envelope: DocumentTransactionEnvelope;
  let candidate: unknown;
  try {
    candidate = parseStrictJson(strictUtf8.decode(bytes));
    envelope = await assertDocumentTransactionEnvelope({ assertSchema }, candidate);
  } catch (error) {
    throw new NodeDocumentJournalStoreError(
      untrustedDocumentEnvelopeReason(candidate),
      { cause: error }
    );
  }
  if (!bytes.equals(await canonicalEnvelopeBytes(envelope))) {
    throw new NodeDocumentJournalStoreError(
      "Document journal JSON is not in canonical byte form."
    );
  }
  return envelope;
}

function evidenceDescription(context: JournalSlotFailureContext): string {
  return context.evidence === "candidate"
    ? "Document journal transition candidate"
    : "Quarantined document journal";
}

function subjectDescription(context: JournalSlotFailureContext): string {
  const evidence = evidenceDescription(context);
  const descriptions: Record<JournalSlotSubject, string> = {
    candidate: "Document journal transition candidate",
    canonical: "Canonical document journal",
    evidence,
    quarantine: "Quarantined document journal",
    replacement: "Replacement document journal",
    "retired-evidence": `Retired ${evidence}`
  };
  return descriptions[context.subject ?? "canonical"];
}

function failed(message: string, context: JournalSlotFailureContext): Error {
  return new NodeDocumentJournalStoreError(
    message,
    context.cause === undefined ? undefined : { cause: context.cause }
  );
}

const failures: Record<
  JournalSlotFailure,
  (context: JournalSlotFailureContext) => Error
> = {
  "candidate-exists": (context) => failed(
    "Document journal transition candidate already exists and was preserved.",
    context
  ),
  "candidate-unavailable": (context) => context.cause instanceof Error
    ? context.cause
    : failed("Document journal transition candidate could not be created safely.", context),
  "canonical-recreated": (context) => failed(
    "Canonical document journal was recreated concurrently; all evidence was preserved.",
    context
  ),
  changed: (context) => failed(
    `${subjectDescription(context)} identity or canonical bytes changed concurrently; all evidence was preserved.`,
    context
  ),
  "must-be-stabilized": (context) => failed(
    "Document journal mutation must be stabilized before another operation.",
    context
  ),
  "not-regular-file": (context) => failed(
    "Document journal is not a stable bounded regular file.",
    context
  ),
  "publication-conflict": (context) => failed(
    context.mutation === "replace"
      ? "Canonical document journal slot changed during transition; all evidence was preserved."
      : "Canonical document journal slot is occupied; transition evidence was preserved.",
    context
  ),
  "quarantine-unavailable": (context) => failed(
    context.mutation === "remove"
      ? "Document journal could not enter its verified removal quarantine."
      : "Document journal could not enter its verified quarantine transition; evidence was preserved.",
    context
  ),
  "slot-occupied": (context) => failed(
    "Canonical document journal slot is occupied; it was preserved.",
    context
  ),
  "state-directory-missing": (context) => failed(
    "Foundation state directory must exist before journal access.",
    context
  ),
  "too-many-entries": (context) => failed(
    "Document journal directory contains too many entries to inspect safely.",
    context
  ),
  "transition-residue": (context) => failed(
    "Incomplete document journal transition evidence was preserved and requires recovery.",
    context
  )
};

function documentJournalFailure(
  failure: JournalSlotFailure,
  context: JournalSlotFailureContext
): Error {
  return failures[failure](context);
}

function retirementEvidence(
  evidence: "candidate" | "previous"
): "candidate" | "quarantine" {
  return evidence === "candidate" ? "candidate" : "quarantine";
}

function mapFaultPoint(
  point: JournalSlotFaultPoint
): NodeDocumentJournalFaultPoint | undefined {
  switch (point.phase) {
    case "after-candidate-synced":
      return { phase: "after-candidate-synced" };
    case "before-reconciliation-directory-sync":
      return { phase: "before-reconciliation-directory-sync" };
    case "after-canonical-synced":
      return { phase: "after-canonical-published" };
    case "after-shared-quarantine-synced":
      return { phase: "after-canonical-quarantined" };
    case "after-final-directory-sync":
      return point.mutation === "create"
        ? undefined
        : { phase: "after-quarantine-removed" };
    case "before-final-directory-sync":
      return { operation: point.mutation, phase: "before-final-directory-sync" };
    case "before-shared-quarantine":
      return { operation: point.mutation, path: point.path, phase: "before-shared-quarantine" };
    case "before-retirement-directory":
      return {
        evidence: retirementEvidence(point.evidence),
        operation: point.mutation,
        path: point.path,
        phase: "before-private-cleanup"
      };
    case "before-logical-retirement":
      return {
        evidence: retirementEvidence(point.evidence),
        operation: point.mutation,
        path: point.path,
        phase: "before-logical-retirement"
      };
    case "before-directory-sync":
      return {
        operation: point.mutation,
        path: point.path,
        phase: "before-directory-sync",
        role: point.role
      };
    case "before-canonical-link":
    case "after-canonical-linked":
    case "before-private-retirement":
    case "before-private-retirement-rename":
    case "before-quarantine-directory":
      return undefined;
  }
}

function storedDocumentJournal(stored: {
  readonly authority: JournalSlotAuthority;
  readonly journal: DocumentTransactionEnvelope;
}): StoredDocumentJournal {
  return { authority: wireAuthority(stored.authority), envelope: stored.journal };
}

export class NodeDocumentJournalStore implements DocumentJournalStore {
  readonly #store: NodeJournalSlotStore<DocumentTransactionEnvelope>;

  public constructor(
    readonly journalPath: string,
    readonly operations: NodeDocumentJournalOperations = {}
  ) {
    const parent = dirname(journalPath);
    const canonicalName = basename(journalPath);
    if (canonicalName !== FOUNDATION_TRANSACTION_FILE) {
      throw new NodeDocumentJournalStoreError(
        "Document journal store must use the historical Foundation transaction slot."
      );
    }
    const { faultInjector } = operations;
    this.#store = new NodeJournalSlotStore<DocumentTransactionEnvelope>({
      canonicalPath: journalPath,
      codec: { parse: parseEnvelope, serialize: canonicalEnvelopeBytes },
      failure: documentJournalFailure,
      ...(faultInjector === undefined
        ? {}
        : {
            faultInjector: (point: JournalSlotFaultPoint) => {
              const mapped = mapFaultPoint(point);
              return mapped === undefined ? undefined : faultInjector(mapped);
            }
          }),
      maximumBytes: maximumJournalBytes,
      naming: {
        candidatePath: join(parent, `${canonicalName}.document-transition`),
        quarantineDirectoryName: (previous) =>
          `${canonicalName}.document-quarantine.${previous.identity.dev}.${previous.identity.ino}.${previous.identity.birthtimeNs}.${randomUUID()}`,
        residues: [
          { exact: `${canonicalName}.document-transition` },
          { prefix: `${canonicalName}.document-quarantine.` },
          { prefix: `${canonicalName}.document-retired.` }
        ],
        retiredDirectoryName: () => `${canonicalName}.document-retired.${randomUUID()}`,
        terminalRootName: `${canonicalName}.completed-document-evidence`
      },
      canonicalInspection: "authority",
      observableSyncStages: ["transition"],
      reconciliation: "residue-only",
      syncDirectory: syncDirectoryStrictly
    });
  }

  async read(): Promise<StoredDocumentJournal | undefined> {
    const stored = await this.#store.read();
    return stored === undefined ? undefined : storedDocumentJournal(stored);
  }

  public async stabilizeForReconciliation(): Promise<StoredDocumentJournal | undefined> {
    const observation = await this.#store.stabilizeForReconciliation();
    if (observation.outcome === "recovery-required") {
      throw documentJournalFailure("transition-residue", { mutation: "stabilize" });
    }
    return observation.stored === undefined
      ? undefined
      : storedDocumentJournal(observation.stored);
  }

  async create(envelope: DocumentTransactionEnvelope): Promise<JournalAuthority> {
    return wireAuthority(await this.#store.create(envelope));
  }

  async replace(request: {
    readonly expectedAuthority: JournalAuthority;
    readonly envelope: DocumentTransactionEnvelope;
  }): Promise<JournalAuthority> {
    return wireAuthority(
      await this.#store.replace(slotAuthority(request.expectedAuthority), request.envelope)
    );
  }

  async remove(expectedAuthority: JournalAuthority): Promise<void> {
    await this.#store.remove(slotAuthority(expectedAuthority));
  }
}
