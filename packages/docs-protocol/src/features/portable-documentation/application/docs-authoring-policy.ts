import type { DocumentJsonValue } from "../domain/metadata.js";
import type { AuthoringReceipt as DocumentReceiptContract } from "./authoring-observation.js";
import type {
  DocsCommandOutcome,
  DocsDiagnostic,
  DocsNewRequest,
  DocsCodeAnchor,
} from "./model.js";
import type { DocumentAuthoringPortV2, DocsBlockerPolicy } from "./model-v2.js";
import { DocsProfileError } from "./profile-policy.js";
import { assertDocumentMetadata } from "../domain/document-semantics.js";
import { validateDocumentRelations } from "../domain/blocker-policy.js";

const GOVERNED_METADATA = new Set([
  "id",
  "type",
  "status",
  "owner",
  "summary",
  "related",
  "title",
  "slug",
  "destination",
]);

export function withSignal(signal: AbortSignal | undefined): Readonly<{ signal?: AbortSignal }> {
  return signal === undefined ? Object.freeze({}) : Object.freeze({ signal });
}

export function typeOrThrow(
  types: Awaited<ReturnType<DocumentAuthoringPortV2["describe"]>>["types"],
  type: string,
) {
  const match = types.find((entry) => entry.type === type);
  if (match === undefined) {
    throw new DocsProfileError(`Document type ${type} is not declared by the protocol profile.`);
  }
  return match;
}

export function assertOwnerAllowed(type: ReturnType<typeof typeOrThrow>, owner: string): void {
  if (!type.allowedOwnerIds.includes(owner)) {
    throw new DocsProfileError(`Owner ${owner} is not allowed for ${type.type}.`);
  }
}

export function inspectNewAnchors(
  anchors: readonly DocsCodeAnchor[],
  matchedPatterns: readonly string[],
): readonly DocsDiagnostic[] {
  const required = anchors.filter(
    ({ enforcement, pattern }) => enforcement === "required" && !matchedPatterns.includes(pattern),
  );
  if (required.length > 0) {
    throw new DocsProfileError(
      `Required code anchor patterns must match current regular files: ${required.map(({ pattern }) => pattern).join(", ")}.`,
    );
  }
  return Object.freeze(
    anchors
      .filter(
        ({ enforcement, pattern }) =>
          enforcement === "advisory" && !matchedPatterns.includes(pattern),
      )
      .map(({ pattern }) => ({
        ruleId: "docs.code-anchor.advisory-unmatched",
        severity: "warning" as const,
        phase: "authority" as const,
        subject: pattern,
        message: `Advisory code anchor ${pattern} does not match a current regular file.`,
      })),
  );
}

const RECEIPT_OUTCOMES = {
  applied: "success",
  "already-applied": "success",
  "authority-stale": "authority-stale",
  cancelled: "cancelled",
  "recovery-required": "recovery-required",
  "manual-recovery-required": "recovery-required",
  "failed-before-publication": "execution-failure",
  rejected: "conflict",
} satisfies Readonly<Record<DocumentReceiptContract["outcome"], DocsCommandOutcome>>;

export function receiptOutcome(receipt: DocumentReceiptContract): DocsCommandOutcome {
  return RECEIPT_OUTCOMES[receipt.outcome];
}

export function receiptDiagnostics(receipt: DocumentReceiptContract): readonly DocsDiagnostic[] {
  return receipt.diagnostics.map((entry) => ({ ...entry }));
}

export function receiptEvidence(receipt: DocumentReceiptContract) {
  return Object.freeze({
    outcome: receipt.outcome,
    commit: Object.freeze({
      state: receipt.commit.state,
      publication: receipt.commit.publication,
      recoverability: receipt.commit.recoverability,
    }),
    ...(receipt.schemaVersion === 2
      ? { directoryMaterialization: receipt.directoryMaterialization }
      : {}),
  });
}

export function documentWriteState(receipt: DocumentReceiptContract) {
  if (receipt.commit.state === "committed") {
    return receipt.commit.publication === "preexisting-exact"
      ? ("already-applied" as const)
      : ("applied" as const);
  }
  if (receipt.commit.publication === "published") {
    return "published-recovery-required" as const;
  }
  if (receipt.commit.publication === "unknown") {
    return "unknown" as const;
  }
  return "unchanged" as const;
}

export function recoveryWriteState(receipt: DocumentReceiptContract) {
  if (receipt.commit.state === "committed") {
    return "committed" as const;
  }
  if (receipt.commit.publication === "published") {
    return "published-recovery-required" as const;
  }
  if (receipt.commit.publication === "unknown") {
    return "unknown" as const;
  }
  return "unchanged" as const;
}

export function relationMetadata(
  request: Omit<DocsNewRequest, "codeAnchors"> & {
    readonly codeAnchors?: readonly DocsCodeAnchor[];
  },
  blockedByKey: string,
  codeAnchorsKey: string,
): Readonly<Record<string, DocumentJsonValue>> | undefined {
  assertDocumentMetadata(request.additionalMetadata ?? {});
  const metadata: Record<string, DocumentJsonValue> = { ...request.additionalMetadata };
  for (const key of Object.keys(metadata)) {
    if (GOVERNED_METADATA.has(key) || key === blockedByKey || key === codeAnchorsKey) {
      throw new DocsProfileError(`Additional metadata cannot replace governed key ${key}.`);
    }
  }
  if (request.blockedBy !== undefined && request.blockedBy.length > 0) {
    metadata[blockedByKey] = request.blockedBy;
  }
  if (request.codeAnchors !== undefined && request.codeAnchors.length > 0) {
    metadata[codeAnchorsKey] = request.codeAnchors.map(({ enforcement, pattern }) => ({
      enforcement,
      pattern,
    }));
  }
  return Object.keys(metadata).length === 0 ? undefined : Object.freeze(metadata);
}

export function authoringIntent(
  request: DocsNewRequest,
  related: readonly string[],
  additionalMetadata: Readonly<Record<string, DocumentJsonValue>> | undefined,
) {
  return {
    schemaVersion: 1 as const,
    ...request.intent,
    ...(related.length === 0 ? {} : { related }),
    ...(additionalMetadata === undefined ? {} : { additionalMetadata }),
  };
}

export function validateNewRelations(input: {
  readonly blockedBy: readonly string[];
  readonly catalog: Awaited<ReturnType<DocumentAuthoringPortV2["buildCatalog"]>>;
  readonly documentId: string;
  readonly initialStatus: string;
  readonly policy: DocsBlockerPolicy;
  readonly related: readonly string[];
}) {
  if (input.catalog.status !== "complete") {
    throw new DocsProfileError("A complete Foundation v2 catalog is required before authoring.");
  }
  return validateDocumentRelations({
    ...input,
    documents: new Map(input.catalog.documents.map((document) => [document.id, document])),
    subjectStatus: input.initialStatus,
  });
}

export function projectTransaction(
  inspection: Awaited<ReturnType<DocumentAuthoringPortV2["inspect"]>>,
) {
  if (inspection.state === "idle") {
    return Object.freeze({ state: "idle" as const });
  }
  if (inspection.state === "recoverable") {
    return Object.freeze({
      state: "recoverable" as const,
      transactionKind: "document" as const,
      recovery: Object.freeze({
        commandId: "docs.recover" as const,
        args: Object.freeze({
          exactFoundationBuildIdentity: inspection.recovery.exactFoundationBuildIdentity,
          exactFoundationVersion: inspection.recovery.exactFoundationVersion,
        }),
      }),
    });
  }
  return Object.freeze({
    state: "manual-recovery-required" as const,
    ...(inspection.transactionKind === undefined
      ? {}
      : { transactionKind: inspection.transactionKind }),
    reason: inspection.reason,
    ...(inspection.recovery === undefined ? {} : { recovery: inspection.recovery }),
  });
}
