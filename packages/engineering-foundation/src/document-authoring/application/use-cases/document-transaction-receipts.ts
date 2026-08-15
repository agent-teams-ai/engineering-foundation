import type { DocumentPlanContract as DocumentPlan, DocumentPlanV2 } from "../model/document-planning.js";
import type { DocumentReceiptContract as DocumentReceipt, DocumentReceiptBody } from "../model/document-receipt.js";
import type { DocumentTransactionEnvelope } from "../model/document-transaction.js";
import { createDocumentReceipt } from "../policies/document-receipt-policy.js";

export interface DocumentDirectoryReceiptEvidence {
  readonly observedCreatedDirectories: readonly string[];
  readonly state: "none-created" | "created-and-retained" | "preserved-unknown";
}

export function directoryReceiptEvidence(
  envelope: DocumentTransactionEnvelope
): DocumentDirectoryReceiptEvidence | undefined {
  if (envelope.schemaVersion !== 4) {
    return undefined;
  }
  const materialization = envelope.journal.parentMaterialization;
  const observedCreatedDirectories = Object.freeze(
    materialization.createdDirectories.map(({ path }) => path)
  );
  const pendingUnbound = materialization.pendingDirectory !== undefined &&
    !observedCreatedDirectories.includes(materialization.pendingDirectory);
  return Object.freeze({
    observedCreatedDirectories,
    state: pendingUnbound
      ? "preserved-unknown" as const
      : observedCreatedDirectories.length === 0
        ? "none-created" as const
        : "created-and-retained" as const
  });
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

function receiptBaseV2(
  plan: DocumentPlanV2,
  state: "none-created" | "created-and-retained" | "preserved-unknown",
  observedCreatedDirectories: readonly string[]
) {
  if (state === "created-and-retained" && observedCreatedDirectories.length === 0) {
    throw new TypeError(
      "Created-and-retained directory evidence requires at least one observation."
    );
  }
  return {
    adapter: Object.freeze({
      contractVersion: 1 as const,
      id: "foundation.filesystem/v1" as const
    }),
    destination: plan.destination,
    diagnostics: Object.freeze([]),
    directoryMaterialization: Object.freeze({
      observedCreatedDirectories: Object.freeze([...observedCreatedDirectories]),
      plannedDirectories: plan.parentMaterialization.missingDirectories,
      state
    }),
    planDigest: plan.planDigest,
    protocolVersion: 2 as const,
    schemaVersion: 2 as const
  };
}

export async function successReceipt(
  plan: DocumentPlan,
  outcome: "already-applied" | "applied"
): Promise<DocumentReceipt> {
  if (plan.schemaVersion === 2) {
    const applied = outcome === "applied";
    const created = applied && plan.parentMaterialization.missingDirectories.length > 0;
    return createDocumentReceipt({
      ...receiptBaseV2(
        plan,
        created ? "created-and-retained" : "none-created",
        created ? plan.parentMaterialization.missingDirectories : []
      ),
      commit: Object.freeze({
        fileAtomicity: applied
          ? "single-file-atomic-create" as const
          : "not-applicable" as const,
        publication: applied ? "published" as const : "preexisting-exact" as const,
        recoverability: "not-required" as const,
        state: "committed" as const
      }),
      outcome,
      resultDigest: plan.output.digest
    }, plan);
  }
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
  options: {
    readonly directoryEvidence?: DocumentDirectoryReceiptEvidence;
    readonly phase?: "apply" | "authority";
  } = {}
): Promise<DocumentReceipt> {
  if (plan.schemaVersion === 2) {
    return createDocumentReceipt({
      ...receiptBaseV2(
        plan,
        options.directoryEvidence?.state ?? "none-created",
        options.directoryEvidence?.observedCreatedDirectories ?? []
      ),
      commit: Object.freeze({
        fileAtomicity: "not-applicable" as const,
        publication: "none" as const,
        recoverability: "not-required" as const,
        state: "not-published" as const
      }),
      diagnostics: Object.freeze([diagnostic(options.phase ?? "apply", ruleId, message)]),
      outcome
    }, plan);
  }
  return createDocumentReceipt({
    ...receiptBase(plan),
    commit: Object.freeze({
      atomicity: "not-applicable" as const,
      publication: "none" as const,
      recoverability: "not-required" as const,
      state: "not-published" as const
    }),
    diagnostics: Object.freeze([diagnostic(options.phase ?? "apply", ruleId, message)]),
    outcome
  }, plan);
}

export async function recoveryReceipt(
  plan: DocumentPlan,
  options: {
    readonly directoryEvidence?: DocumentDirectoryReceiptEvidence;
    readonly manual?: boolean;
    readonly message: string;
    readonly publication: "none" | "published" | "unknown";
    readonly ruleId: string;
  }
): Promise<DocumentReceipt> {
  if (plan.schemaVersion === 2) {
    const state = options.manual === true
      ? "manual-recovery-required" as const
      : "recovery-required" as const;
    return createDocumentReceipt({
      ...receiptBaseV2(
        plan,
        options.directoryEvidence?.state ?? "preserved-unknown",
        options.directoryEvidence?.observedCreatedDirectories ?? []
      ),
      commit: Object.freeze({
        fileAtomicity: options.publication === "published"
          ? "single-file-atomic-create" as const
          : "not-applicable" as const,
        publication: options.publication,
        recoverability: "preserved-for-recovery" as const,
        state
      }),
      diagnostics: Object.freeze([diagnostic("recovery", options.ruleId, options.message)]),
      outcome: state
    }, plan);
  }
  const common = {
    ...receiptBase(plan),
    diagnostics: Object.freeze([diagnostic("recovery", options.ruleId, options.message)])
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
