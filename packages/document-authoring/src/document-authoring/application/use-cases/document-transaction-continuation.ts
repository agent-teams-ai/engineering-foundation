import type { DocumentSchemaValidator } from "../ports/document-schema-validator.js";
import type { DocumentCompilerIdentity, DocumentPlanContract as DocumentPlan } from "../model/document-planning.js";
import type { DocumentReceiptContract as DocumentReceipt } from "../model/document-receipt.js";
import type { DocumentOwnedTemporary, DocumentTransactionEnvelope } from "../model/document-transaction.js";
import type { DocumentParentMaterializationJournalV2 } from "../model/document-parent-materialization.js";
import type { DocumentAuthorityRecompiler } from "../ports/document-authority-recompiler.js";
import type { DocumentFileState } from "../ports/document-file-state.js";
import type { DocumentJournalStore, JournalAuthority } from "../ports/document-journal-store.js";
import type { DocumentPublisher } from "../ports/document-publisher.js";
import type { DocumentParentMaterializerV2 } from "../ports/document-parent-materializer.js";
import type { DocumentTransactionCoordinator } from "../ports/document-transaction-coordinator.js";
import { assertNonzeroDocumentPhysicalIdentity } from "../model/document-physical-identity.js";
import { createDocumentTransactionEnvelope } from "../policies/document-transaction-envelope-policy.js";
import { envelopeBodyV3, envelopeBodyV4 } from "../policies/document-transaction-envelope-body.js";
import { createJournalReconciled, DocumentJournalReconciliationError, removeJournalReconciled, replaceJournalReconciled } from "./document-journal-reconciliation.js";
import { noPublicationReceipt, recoveryReceipt, successReceipt } from "./document-transaction-receipts.js";
import { recaptureDirectoryReceiptEvidence } from "./recapture-directory-receipt-evidence.js";

export { DocumentJournalReconciliationError, noPublicationReceipt, recoveryReceipt, removeJournalReconciled };
export { materializeDocumentParentDirectories } from "./document-parent-materialization-continuation.js";

export interface DocumentTransactionRuntime {
  readonly compiler: DocumentCompilerIdentity;
  readonly schema: DocumentSchemaValidator;
  readonly kernelArtifact: DocumentTransactionEnvelope["kernelArtifact"];
  readonly authority: DocumentAuthorityRecompiler;
  readonly fileState: DocumentFileState;
  readonly faultInjector?: DocumentTransactionFaultInjector;
  readonly journal: DocumentJournalStore;
  readonly parentMaterializer: DocumentParentMaterializerV2;
  readonly publisher: DocumentPublisher;
  readonly coordinator: DocumentTransactionCoordinator;
}

export type DocumentTransactionFaultPoint =
  | { readonly phase: "after-prepared-journal-durable" }
  | { readonly phase: "after-materializing-journal-durable" }
  | { readonly phase: "after-directory-created-before-journal" }
  | { readonly phase: "after-publishing-journal-durable" }
  | { readonly phase: "after-published-journal-durable" }
  | { readonly phase: "after-a1" }
  | { readonly phase: "after-c1" }
  | { readonly phase: "after-a2" }
  | { readonly phase: "after-c2" }
  | { readonly phase: "after-final-journal-removal-synced" };

export type DocumentTransactionFaultInjector = (point: DocumentTransactionFaultPoint) => Promise<void> | void;

export interface DocumentTransactionRequest {
  readonly consumerRoot: string;
  readonly signal?: AbortSignal;
}

export interface ActiveDocumentJournal {
  readonly envelope: DocumentTransactionEnvelope;
  readonly authority: JournalAuthority;
}

async function activeRecoveryReceipt(
  runtime: DocumentTransactionRuntime,
  request: DocumentTransactionRequest,
  active: ActiveDocumentJournal,
  options: Parameters<typeof recoveryReceipt>[2]
): Promise<DocumentReceipt> {
  const { evidence } = await recaptureDirectoryReceiptEvidence(
    runtime.parentMaterializer,
    request.consumerRoot,
    active
  );
  return recoveryReceipt(runtime.schema, active.envelope.journal.plan, {
    ...options,
    ...(evidence === undefined ? {} : { directoryEvidence: evidence })
  });
}

function signalOption(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

export async function createPreparedJournal(
  runtime: DocumentTransactionRuntime,
  consumerRoot: string,
  plan: DocumentPlan,
  destination: "pending" | "preexisting"
): Promise<ActiveDocumentJournal> {
  if (plan.schemaVersion === 2) {
    const materialization = await runtime.parentMaterializer.begin({
      consumerRoot,
      plan: plan.parentMaterialization
    });
    const envelope = await createDocumentTransactionEnvelope(runtime.schema, 
      envelopeBodyV4(plan, runtime.kernelArtifact, materialization, { destination, state: "PREPARED" })
    );
    const active = {
      authority: await createJournalReconciled(runtime, envelope),
      envelope
    };
    await runtime.faultInjector?.({ phase: "after-prepared-journal-durable" });
    return active;
  }
  const envelope = await createDocumentTransactionEnvelope(runtime.schema, 
    envelopeBodyV3(plan, runtime.kernelArtifact, { destination, state: "PREPARED" })
  );
  const active = {
    authority: await createJournalReconciled(runtime, envelope),
    envelope
  };
  await runtime.faultInjector?.({ phase: "after-prepared-journal-durable" });
  return active;
}

function materializationJournal(
  active: ActiveDocumentJournal
): DocumentParentMaterializationJournalV2 {
  if (active.envelope.schemaVersion !== 4) {
    throw new Error("Document parent materialization requires envelope v4.");
  }
  return {
    anchorIdentity: active.envelope.journal.parentMaterialization.anchorIdentity,
    createdDirectories:
      active.envelope.journal.parentMaterialization.createdDirectories,
    plan: active.envelope.journal.plan.parentMaterialization,
    schemaVersion: 2
  };
}

async function replaceWithPublishing(
  runtime: DocumentTransactionRuntime,
  active: ActiveDocumentJournal,
  temporary: DocumentOwnedTemporary
): Promise<ActiveDocumentJournal> {
  assertNonzeroDocumentPhysicalIdentity(temporary.identity);
  if (active.envelope.schemaVersion === 4) {
    const envelope = await createDocumentTransactionEnvelope(runtime.schema, 
      envelopeBodyV4(
        active.envelope.journal.plan,
        active.envelope.kernelArtifact,
        materializationJournal(active),
        { state: "PUBLISHING", temporary }
      )
    );
    const result = {
      authority: await replaceJournalReconciled(runtime, active, envelope),
      envelope
    };
    await runtime.faultInjector?.({ phase: "after-publishing-journal-durable" });
    return result;
  }
  const envelope = await createDocumentTransactionEnvelope(runtime.schema, 
    envelopeBodyV3(active.envelope.journal.plan, active.envelope.kernelArtifact, {
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
  if (active.envelope.schemaVersion === 4) {
    const envelope = await createDocumentTransactionEnvelope(runtime.schema, 
      envelopeBodyV4(
        active.envelope.journal.plan,
        active.envelope.kernelArtifact,
        materializationJournal(active),
        { publicationIdentity, state: "PUBLISHED" }
      )
    );
    const result = {
      authority: await replaceJournalReconciled(runtime, active, envelope),
      envelope
    };
    await runtime.faultInjector?.({ phase: "after-published-journal-durable" });
    return result;
  }
  const envelope = await createDocumentTransactionEnvelope(runtime.schema, 
    envelopeBodyV3(active.envelope.journal.plan, active.envelope.kernelArtifact, {
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
  outcome: "already-applied" | "applied",
  options: { readonly authority?: "current-profile" | "persisted-plan" } = {}
): Promise<DocumentReceipt | undefined> {
  const plan = active.envelope.journal.plan;
  const expectedIdentity = active.envelope.state === "PUBLISHED"
    ? active.envelope.journal.publicationIdentity
    : undefined;
  const a1 = options.authority === "persisted-plan"
    ? { current: true as const }
    : await exactCurrentAuthority(runtime, request, plan);
  await runtime.faultInjector?.({ phase: "after-a1" });
  if (!a1.current) {
    return undefined;
  }
  const c1 = await exactDestination(runtime, request, plan, expectedIdentity);
  await runtime.faultInjector?.({ phase: "after-c1" });
  if (!c1.exact) {
    return undefined;
  }
  const a2 = options.authority === "persisted-plan"
    ? { current: true as const }
    : await exactCurrentAuthority(runtime, request, plan);
  await runtime.faultInjector?.({ phase: "after-a2" });
  if (!a2.current) {
    return undefined;
  }
  const c2 = await exactDestination(runtime, request, plan, expectedIdentity);
  await runtime.faultInjector?.({ phase: "after-c2" });
  if (!c2.exact) {
    return undefined;
  }
  if (outcome === "applied" && active.envelope.schemaVersion === 4) {
    const inspection = await runtime.parentMaterializer.inspect({
      consumerRoot: request.consumerRoot,
      journal: materializationJournal(active)
    });
    if (inspection.state !== "current" || inspection.nextDirectory !== undefined) {
      return undefined;
    }
  }
  await removeJournalReconciled(runtime, active);
  await runtime.faultInjector?.({
    phase: "after-final-journal-removal-synced"
  });
  return successReceipt(runtime.schema, plan, outcome);
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
  const finalState = await runtime.fileState.classifyTemporary({
    consumerRoot: request.consumerRoot,
    temporary
  });
  if (finalState.state !== "absent") {
    throw new Error("Owned temporary absence did not remain stable after cleanup.");
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
  if (current.envelope.state === "PREPARED" ||
    current.envelope.state === "MATERIALIZING") {
    current = await replaceWithPublishing(runtime, current, temporary);
  }
  onPublishingDurable?.();
  const authority = await exactCurrentAuthority(runtime, request, plan);
  if (!authority.current) {
    return activeRecoveryReceipt(runtime, request, current, {
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
    return activeRecoveryReceipt(runtime, request, current, {
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
    return activeRecoveryReceipt(runtime, request, current, {
      manual: true,
      message: "Destination became present during PUBLISHING; publication ownership is ambiguous.",
      publication: "unknown",
      ruleId: "document.transaction.concurrent-exact-publication"
    });
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
  return receipt ?? activeRecoveryReceipt(runtime, request, current, {
    message: "Post-publication A1-C1-A2-C2 verification did not remain stable.",
    publication: "published",
    ruleId: "document.transaction.final-verification"
  });
}
