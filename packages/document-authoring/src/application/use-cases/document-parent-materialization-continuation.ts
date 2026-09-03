import type { DocumentParentMaterializationJournalV2 } from "../model/document-parent-materialization.js";
import { createDocumentTransactionEnvelope } from "../policies/document-transaction-envelope-policy.js";
import { envelopeBodyV4 } from "../policies/document-transaction-envelope-body.js";
import type {
  ActiveDocumentJournal,
  DocumentTransactionRequest,
  DocumentTransactionRuntime
} from "./document-transaction-continuation.js";
import { replaceJournalReconciled } from "./document-journal-reconciliation.js";

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

async function replaceV4Materializing(
  runtime: DocumentTransactionRuntime,
  active: ActiveDocumentJournal,
  materialization: DocumentParentMaterializationJournalV2,
  pendingDirectory?: string,
  onDurable?: (active: ActiveDocumentJournal) => void
): Promise<ActiveDocumentJournal> {
  if (active.envelope.schemaVersion !== 4) {
    throw new Error("Document parent materialization requires envelope v4.");
  }
  const envelope = await createDocumentTransactionEnvelope(
    envelopeBodyV4(active.envelope.journal.plan, materialization, {
      ...(pendingDirectory === undefined ? {} : { pendingDirectory }),
      state: "MATERIALIZING"
    })
  );
  const result = {
    authority: await replaceJournalReconciled(runtime, active, envelope),
    envelope
  };
  onDurable?.(result);
  await runtime.faultInjector?.({ phase: "after-materializing-journal-durable" });
  return result;
}

export async function materializeDocumentParentDirectories(
  runtime: DocumentTransactionRuntime,
  request: DocumentTransactionRequest,
  initial: ActiveDocumentJournal,
  onDurable?: (active: ActiveDocumentJournal) => void
): Promise<ActiveDocumentJournal> {
  if (initial.envelope.schemaVersion !== 4) {
    return initial;
  }
  let active = initial;
  for (;;) {
    // Cancellation is observed only between directory steps. Once mkdir starts,
    // createAndBindOne completes durable binding without signal observation.
    request.signal?.throwIfAborted();
    const journal = materializationJournal(active);
    const inspection = await runtime.parentMaterializer.inspect({
      consumerRoot: request.consumerRoot,
      journal
    });
    if (inspection.state !== "current") {
      throw new Error(
        `Document parent materialization requires manual recovery: ${inspection.reason}.`
      );
    }
    if (inspection.nextDirectory === undefined) {
      return active;
    }
    active = await replaceV4Materializing(
      runtime, active, journal, inspection.nextDirectory, onDurable
    );
    // The durable pending-directory journal is a safe pre-mkdir boundary.
    request.signal?.throwIfAborted();
    const beforeCreate = materializationJournal(active);
    const parentIdentity = beforeCreate.createdDirectories.at(-1)?.identity ??
      beforeCreate.anchorIdentity;
    await runtime.parentMaterializer.createAndBindOne({
      async bindCreatedDirectory(created) {
        await runtime.faultInjector?.({
          phase: "after-directory-created-before-journal"
        });
        if (created.path !== inspection.nextDirectory) {
          throw new Error("Directory kernel returned an unexpected repository path.");
        }
        active = await replaceV4Materializing(runtime, active, {
          ...materializationJournal(active),
          createdDirectories: Object.freeze([
            ...materializationJournal(active).createdDirectories,
            created
          ])
        }, undefined, onDurable);
      },
      consumerRoot: request.consumerRoot,
      expectedParentIdentity: parentIdentity,
      path: inspection.nextDirectory
    });
  }
}
