import type { DocumentPlan } from "../model/document-planning.js";
import type { DocumentReceipt, DocumentReceiptBody } from "../model/document-receipt.js";
import type {
  DocumentOwnedTemporary,
  DocumentTransactionEnvelope,
  DocumentTransactionEnvelopeBody
} from "../model/document-transaction.js";
import type { DocumentAuthorityRecompiler } from "../ports/document-authority-recompiler.js";
import type { DocumentFileState } from "../ports/document-file-state.js";
import type {
  DocumentJournalStore,
  JournalAuthority
} from "../ports/document-journal-store.js";
import type { DocumentPublisher } from "../ports/document-publisher.js";
import type { DocumentTransactionCoordinator } from "../ports/document-transaction-coordinator.js";
import { assertNonzeroDocumentPhysicalIdentity } from "../model/document-physical-identity.js";
import { createDocumentReceipt } from "../policies/document-receipt-policy.js";
import { createDocumentTransactionEnvelope } from "../policies/document-transaction-envelope-policy.js";
import {
  createJournalReconciled,
  DocumentJournalReconciliationError,
  removeJournalReconciled,
  replaceJournalReconciled
} from "./document-journal-reconciliation.js";

export { DocumentJournalReconciliationError, removeJournalReconciled };

export interface DocumentTransactionRuntime {
  readonly authority: DocumentAuthorityRecompiler;
  readonly fileState: DocumentFileState;
  readonly faultInjector?: DocumentTransactionFaultInjector;
  readonly journal: DocumentJournalStore;
  readonly publisher: DocumentPublisher;
  readonly coordinator: DocumentTransactionCoordinator;
}

export type DocumentTransactionFaultPoint =
  | { readonly phase: "after-prepared-journal-durable" }
  | { readonly phase: "after-publishing-journal-durable" }
  | { readonly phase: "after-published-journal-durable" }
  | { readonly phase: "after-a1" }
  | { readonly phase: "after-c1" }
  | { readonly phase: "after-a2" }
  | { readonly phase: "after-c2" }
  | { readonly phase: "after-final-journal-removal-synced" };

export type DocumentTransactionFaultInjector = (
  point: DocumentTransactionFaultPoint
) => Promise<void> | void;

export interface DocumentTransactionRequest {
  readonly consumerRoot: string;
  readonly signal?: AbortSignal;
}

export interface ActiveDocumentJournal {
  readonly envelope: DocumentTransactionEnvelope;
  readonly authority: JournalAuthority;
}

function signalOption(signal: AbortSignal | undefined): {
  readonly signal?: AbortSignal;
} {
  return signal === undefined ? {} : { signal };
}

function diagnostic(
  phase: "apply" | "authority" | "recovery",
  ruleId: string,
  message: string
): DocumentReceiptBody["diagnostics"][number] {
  return Object.freeze({
    message: message.slice(0, 1000),
    phase,
    ruleId,
    severity: "error" as const,
    subject: "document-transaction"
  });
}

function receiptBase(plan: DocumentPlan) {
  return {
    adapter: Object.freeze({
      contractVersion: 1 as const,
      id: "foundation.filesystem/v1" as const
    }),
    destination: plan.destination,
    diagnostics: Object.freeze([]),
    planDigest: plan.planDigest,
    protocolVersion: 1 as const,
    schemaVersion: 1 as const
  };
}

async function successReceipt(
  plan: DocumentPlan,
  outcome: "already-applied" | "applied"
): Promise<DocumentReceipt> {
  if (outcome === "applied") {
    return createDocumentReceipt({
      ...receiptBase(plan),
      commit: Object.freeze({
        atomicity: "single-file-atomic-create" as const,
        publication: "published" as const,
        recoverability: "not-required" as const,
        state: "committed" as const
      }),
      outcome,
      resultDigest: plan.output.digest
    }, plan);
  }
  return createDocumentReceipt({
    ...receiptBase(plan),
    commit: Object.freeze({
        atomicity: "not-applicable" as const,
        publication: "preexisting-exact" as const,
        recoverability: "not-required" as const,
        state: "committed" as const
      }),
    outcome,
    resultDigest: plan.output.digest
  }, plan);
}

export async function noPublicationReceipt(
  plan: DocumentPlan,
  outcome: "authority-stale" | "cancelled" | "failed-before-publication" | "rejected",
  ruleId: string,
  message: string,
  phase: "apply" | "authority" = "apply"
): Promise<DocumentReceipt> {
  return createDocumentReceipt({
    ...receiptBase(plan),
    commit: Object.freeze({
      atomicity: "not-applicable" as const,
      publication: "none" as const,
      recoverability: "not-required" as const,
      state: "not-published" as const
    }),
    diagnostics: Object.freeze([diagnostic(phase, ruleId, message)]),
    outcome
  }, plan);
}

export async function recoveryReceipt(
  plan: DocumentPlan,
  options: {
    readonly manual?: boolean;
    readonly message: string;
    readonly publication: "none" | "published" | "unknown";
    readonly ruleId: string;
  }
): Promise<DocumentReceipt> {
  const common = {
    ...receiptBase(plan),
    diagnostics: Object.freeze([
      diagnostic("recovery", options.ruleId, options.message)
    ])
  };
  const atomicity = options.publication === "published"
    ? "single-file-atomic-create" as const
    : "not-applicable" as const;
  if (options.manual === true) {
    return createDocumentReceipt({
      ...common,
      commit: Object.freeze({
        atomicity,
        publication: options.publication,
        recoverability: "preserved-for-recovery" as const,
        state: "manual-recovery-required" as const
      }),
      outcome: "manual-recovery-required"
    }, plan);
  }
  return createDocumentReceipt({
    ...common,
    commit: Object.freeze({
      atomicity,
      publication: options.publication,
      recoverability: "preserved-for-recovery" as const,
      state: "recovery-required" as const
    }),
    outcome: "recovery-required"
  }, plan);
}

function envelopeBody(
  plan: DocumentPlan,
  lifecycle:
    | { readonly state: "PREPARED"; readonly destination: "pending" | "preexisting" }
    | { readonly state: "PUBLISHING"; readonly temporary: DocumentOwnedTemporary }
    | {
        readonly state: "PUBLISHED";
        readonly publicationIdentity: import("../model/document-physical-identity.js").DocumentPhysicalIdentity;
      }
): DocumentTransactionEnvelopeBody {
  const base = {
    adapterContractVersion: 1 as const,
    foundation: Object.freeze({
      buildIdentity: plan.compiler.buildIdentity,
      version: plan.compiler.version
    }),
    operationKind: "document-authoring" as const,
    payloadKind: "document-authoring-journal/v2" as const,
    recoveryHandler: Object.freeze({
      contractVersion: 2 as const,
      id: "foundation.document-authoring" as const
    }),
    schemaVersion: 3 as const
  };
  if (lifecycle.state === "PREPARED") {
    const journal = lifecycle.destination === "pending"
      ? {
          destination: { path: plan.destination, state: "pending" as const },
          plan,
          schemaVersion: 2 as const
        }
      : {
          destination: { path: plan.destination, state: "preexisting" as const },
          plan,
          schemaVersion: 2 as const
        };
    return {
      ...base,
      journal,
      state: lifecycle.state
    };
  }
  if (lifecycle.state === "PUBLISHING") {
    return {
      ...base,
      journal: {
        destination: { path: plan.destination, state: "publishing" },
        ownedTemporary: lifecycle.temporary,
        plan,
        schemaVersion: 2
      },
      state: lifecycle.state
    };
  }
  return {
    ...base,
    journal: {
      destination: { path: plan.destination, state: "published" },
      plan,
      publicationIdentity: lifecycle.publicationIdentity,
      schemaVersion: 2
    },
    state: lifecycle.state
  };
}

export async function createPreparedJournal(
  runtime: DocumentTransactionRuntime,
  plan: DocumentPlan,
  destination: "pending" | "preexisting"
): Promise<ActiveDocumentJournal> {
  const envelope = await createDocumentTransactionEnvelope(
    envelopeBody(plan, { destination, state: "PREPARED" })
  );
  const active = {
    authority: await createJournalReconciled(runtime, envelope),
    envelope
  };
  await runtime.faultInjector?.({ phase: "after-prepared-journal-durable" });
  return active;
}

async function replaceWithPublishing(
  runtime: DocumentTransactionRuntime,
  active: ActiveDocumentJournal,
  temporary: DocumentOwnedTemporary
): Promise<ActiveDocumentJournal> {
  assertNonzeroDocumentPhysicalIdentity(temporary.identity);
  const envelope = await createDocumentTransactionEnvelope(
    envelopeBody(active.envelope.journal.plan, {
      state: "PUBLISHING",
      temporary
    })
  );
  const result = {
    authority: await replaceJournalReconciled(runtime, active, envelope),
    envelope
  };
  await runtime.faultInjector?.({ phase: "after-publishing-journal-durable" });
  return result;
}

async function replaceWithPublished(
  runtime: DocumentTransactionRuntime,
  active: ActiveDocumentJournal,
  publicationIdentity: import("../model/document-physical-identity.js").DocumentPhysicalIdentity
): Promise<ActiveDocumentJournal> {
  assertNonzeroDocumentPhysicalIdentity(publicationIdentity);
  const envelope = await createDocumentTransactionEnvelope(
    envelopeBody(active.envelope.journal.plan, {
      publicationIdentity,
      state: "PUBLISHED"
    })
  );
  const result = {
    authority: await replaceJournalReconciled(runtime, active, envelope),
    envelope
  };
  await runtime.faultInjector?.({ phase: "after-published-journal-durable" });
  return result;
}

async function exactCurrentAuthority(
  runtime: DocumentTransactionRuntime,
  request: DocumentTransactionRequest,
  plan: DocumentPlan
): Promise<{ readonly current: true } | { readonly current: false; readonly reason: string }> {
  const assessment = await runtime.authority.assess({
    consumerRoot: request.consumerRoot,
    plan,
    ...signalOption(request.signal)
  });
  return assessment.state === "current"
    ? { current: true }
    : { current: false, reason: assessment.reason };
}

async function exactDestination(
  runtime: DocumentTransactionRuntime,
  request: DocumentTransactionRequest,
  plan: DocumentPlan,
  expectedIdentity?: import("../model/document-physical-identity.js").DocumentPhysicalIdentity
): Promise<{ readonly exact: true } | { readonly exact: false; readonly reason: string }> {
  const state = await runtime.fileState.classifyDestination({
    consumerRoot: request.consumerRoot,
    plan,
    ...signalOption(request.signal)
  });
  if (state.state !== "exact") {
    return { exact: false, reason: `Destination is ${state.state}.` };
  }
  if (expectedIdentity !== undefined &&
    (state.identity.dev !== expectedIdentity.dev ||
      state.identity.ino !== expectedIdentity.ino ||
      state.identity.birthtimeNs !== expectedIdentity.birthtimeNs)) {
    return { exact: false, reason: "Destination physical identity changed." };
  }
  return { exact: true };
}

/** Final A1-C1-A2-C2 observation and identity-fenced journal commit. */
export async function finalizeDocumentTransaction(
  runtime: DocumentTransactionRuntime,
  request: DocumentTransactionRequest,
  active: ActiveDocumentJournal,
  outcome: "already-applied" | "applied"
): Promise<DocumentReceipt | undefined> {
  const plan = active.envelope.journal.plan;
  const expectedIdentity = active.envelope.state === "PUBLISHED"
    ? active.envelope.journal.publicationIdentity
    : undefined;
  const a1 = await exactCurrentAuthority(runtime, request, plan);
  await runtime.faultInjector?.({ phase: "after-a1" });
  if (!a1.current) {
    return undefined;
  }
  const c1 = await exactDestination(runtime, request, plan, expectedIdentity);
  await runtime.faultInjector?.({ phase: "after-c1" });
  if (!c1.exact) {
    return undefined;
  }
  const a2 = await exactCurrentAuthority(runtime, request, plan);
  await runtime.faultInjector?.({ phase: "after-a2" });
  if (!a2.current) {
    return undefined;
  }
  const c2 = await exactDestination(runtime, request, plan, expectedIdentity);
  await runtime.faultInjector?.({ phase: "after-c2" });
  if (!c2.exact) {
    return undefined;
  }
  await removeJournalReconciled(runtime, active);
  await runtime.faultInjector?.({
    phase: "after-final-journal-removal-synced"
  });
  return successReceipt(plan, outcome);
}

export function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1000)
    : "Document transaction failed with an invalid error value.";
}

async function removeTemporaryIfPresent(
  runtime: DocumentTransactionRuntime,
  request: DocumentTransactionRequest,
  temporary: DocumentOwnedTemporary
): Promise<void> {
  const state = await runtime.fileState.classifyTemporary({
    consumerRoot: request.consumerRoot,
    temporary
  });
  if (state.state === "owned-exact") {
    await runtime.publisher.removeOwnedTemporary({
      consumerRoot: request.consumerRoot,
      temporary
    });
  } else if (state.state !== "absent") {
    throw new Error("Owned temporary cannot be cleaned safely.");
  }
}

export async function continuePendingPublication(
  runtime: DocumentTransactionRuntime,
  request: DocumentTransactionRequest,
  active: ActiveDocumentJournal,
  existingTemporary?: DocumentOwnedTemporary,
  onPublishingDurable?: () => void
): Promise<DocumentReceipt> {
  const plan = active.envelope.journal.plan;
  let current = active;
  let temporary = existingTemporary;
  if (temporary === undefined) {
    temporary = await runtime.publisher.prepare({
      consumerRoot: request.consumerRoot,
      plan,
      ...signalOption(request.signal)
    });
  }
  if (current.envelope.state === "PREPARED") {
    current = await replaceWithPublishing(runtime, current, temporary);
  }
  onPublishingDurable?.();
  const authority = await exactCurrentAuthority(runtime, request, plan);
  if (!authority.current) {
    return recoveryReceipt(plan, {
      message: authority.reason,
      publication: "none",
      ruleId: "document.transaction.authority-stale"
    });
  }
  const before = await runtime.fileState.classifyDestination({
    consumerRoot: request.consumerRoot,
    plan,
    ...signalOption(request.signal)
  });
  if (before.state !== "absent") {
    return recoveryReceipt(plan, {
      manual: true,
      message: `Publication precondition changed to ${before.state}.`,
      publication: before.state === "exact" ? "unknown" : "none",
      ruleId: "document.transaction.publication-precondition"
    });
  }
  const publication = await runtime.publisher.publishPrepared({
    consumerRoot: request.consumerRoot,
    plan,
    temporary,
    ...signalOption(request.signal)
  });
  if (publication.outcome === "already-satisfied") {
    const owned = publication.publicationIdentity.dev === temporary.identity.dev &&
      publication.publicationIdentity.ino === temporary.identity.ino &&
      publication.publicationIdentity.birthtimeNs === temporary.identity.birthtimeNs;
    if (!owned) {
      return recoveryReceipt(plan, {
        manual: true,
        message: "Destination became exact with a different physical identity.",
        publication: "unknown",
        ruleId: "document.transaction.concurrent-exact-publication"
      });
    }
    return completePublishedTransaction(runtime, request, current, temporary);
  }
  // The publication boundary has been crossed. Cancellation is deliberately
  // not forwarded to cleanup, verification, journaling, or final checks.
  await removeTemporaryIfPresent(runtime, request, temporary);
  current = await replaceWithPublished(
    runtime,
    current,
    publication.publicationIdentity
  );
  const receipt = await finalizeDocumentTransaction(
    runtime,
    { consumerRoot: request.consumerRoot },
    current,
    "applied"
  );
  return receipt ?? recoveryReceipt(plan, {
    message: "Post-publication A1-C1-A2-C2 verification did not remain stable.",
    publication: "published",
    ruleId: "document.transaction.final-verification"
  });
}

export async function completePublishedTransaction(
  runtime: DocumentTransactionRuntime,
  request: DocumentTransactionRequest,
  active: ActiveDocumentJournal,
  temporary: DocumentOwnedTemporary
): Promise<DocumentReceipt> {
  const plan = active.envelope.journal.plan;
  const completed = await runtime.publisher.completePublication({
    consumerRoot: request.consumerRoot,
    plan,
    temporary
  });
  await removeTemporaryIfPresent(runtime, request, temporary);
  const published = await replaceWithPublished(
    runtime,
    active,
    completed.publicationIdentity
  );
  const receipt = await finalizeDocumentTransaction(
    runtime,
    { consumerRoot: request.consumerRoot },
    published,
    "applied"
  );
  return receipt ?? recoveryReceipt(plan, {
    message: "Recovered publication failed stable final verification.",
    publication: "published",
    ruleId: "document.transaction.final-verification"
  });
}
