import type { DocumentAuthorityDigest } from "./document-catalog.js";

export type DocumentReceiptOutcome =
  | "applied"
  | "already-applied"
  | "authority-stale"
  | "rejected"
  | "recovery-required"
  | "manual-recovery-required"
  | "failed-before-publication"
  | "cancelled";

export interface DocumentReceiptDiagnostic {
  readonly ruleId: string;
  readonly severity: "error" | "info" | "warning";
  readonly phase: "apply" | "authority" | "input" | "recovery";
  readonly subject: string;
  readonly message: string;
}

export interface DocumentCommitObservation {
  readonly state:
    | "committed"
    | "not-published"
    | "preserved"
    | "recovery-required"
    | "manual-recovery-required";
  readonly publication: "none" | "preexisting-exact" | "published" | "unknown";
  readonly atomicity: "not-applicable" | "single-file-atomic-create";
  readonly recoverability:
    | "not-required"
    | "journaled-recoverable"
    | "preserved-for-recovery";
}

interface DocumentReceiptBase {
  readonly schemaVersion: 1;
  readonly protocolVersion: 1;
  readonly planDigest: DocumentAuthorityDigest;
  readonly adapter: {
    readonly id: "foundation.filesystem/v1";
    readonly contractVersion: 1;
  };
  readonly destination: string;
  readonly diagnostics: readonly DocumentReceiptDiagnostic[];
  readonly receiptDigest: DocumentAuthorityDigest;
}

export type DocumentReceipt =
  | (DocumentReceiptBase & {
      readonly outcome: "applied";
      readonly resultDigest: DocumentAuthorityDigest;
      readonly commit: {
        readonly state: "committed";
        readonly publication: "published";
        readonly atomicity: "single-file-atomic-create";
        readonly recoverability: "not-required";
      };
    })
  | (DocumentReceiptBase & {
      readonly outcome: "already-applied";
      readonly resultDigest: DocumentAuthorityDigest;
      readonly commit: {
        readonly state: "committed";
        readonly publication: "preexisting-exact";
        readonly atomicity: "not-applicable";
        readonly recoverability: "not-required";
      };
    })
  | (DocumentReceiptBase & {
      readonly outcome:
        | "authority-stale"
        | "rejected"
        | "failed-before-publication"
        | "cancelled";
      readonly commit: {
        readonly state: "not-published";
        readonly publication: "none";
        readonly atomicity: "not-applicable";
        readonly recoverability: "not-required";
      };
    })
  | (DocumentReceiptBase & {
      readonly outcome: "recovery-required" | "manual-recovery-required";
      readonly commit: DocumentCommitObservation & {
        readonly state:
          | "preserved"
          | "recovery-required"
          | "manual-recovery-required";
        readonly publication: "none" | "published" | "unknown";
        readonly recoverability: "preserved-for-recovery";
      };
    });

type WithoutReceiptDigest<T> = T extends unknown
  ? Omit<T, "receiptDigest">
  : never;

export type DocumentReceiptBody = WithoutReceiptDigest<DocumentReceipt>;
