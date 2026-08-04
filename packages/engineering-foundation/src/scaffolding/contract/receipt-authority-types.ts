import type {
  ScaffoldDiagnosticV1,
  AuthorityScaffoldOperationReceipt,
  Sha256Digest
} from "./types.js";

export interface AuthorityScaffoldReceiptCommon {
  readonly schemaVersion: 2;
  readonly protocolVersion: 2;
  readonly planDigest: Sha256Digest;
  readonly adapter: {
    readonly id: "foundation.filesystem/v1";
    readonly contractVersion: 1;
  };
  readonly diagnostics: readonly ScaffoldDiagnosticV1[];
  readonly receiptDigest: Sha256Digest;
}

type AuthorityAppliedOperationReceipt = AuthorityScaffoldOperationReceipt & {
  readonly outcome: "applied";
  readonly resultDigest: Sha256Digest;
};

type AuthoritySatisfiedOperationReceipt = AuthorityScaffoldOperationReceipt & {
  readonly outcome: "already-satisfied" | "applied";
  readonly resultDigest: Sha256Digest;
};

export type AuthorityScaffoldReceipt =
  | (AuthorityScaffoldReceiptCommon & {
      readonly outcome: "applied";
      readonly commit: {
        readonly state: "committed";
        readonly atomicity: "journaled-recoverable";
      };
      readonly operations: readonly [
        AuthorityAppliedOperationReceipt,
        ...AuthoritySatisfiedOperationReceipt[]
      ];
    })
  | (AuthorityScaffoldReceiptCommon & {
      readonly outcome: "already-applied";
      readonly commit: {
        readonly state: "committed";
        readonly atomicity: "journaled-recoverable";
      };
      readonly operations: readonly [
        AuthorityScaffoldOperationReceipt & {
          readonly outcome: "already-satisfied";
          readonly resultDigest: Sha256Digest;
        },
        ...(AuthorityScaffoldOperationReceipt & {
          readonly outcome: "already-satisfied";
          readonly resultDigest: Sha256Digest;
        })[]
      ];
    })
  | (AuthorityScaffoldReceiptCommon & {
      readonly outcome: "failed-recovered";
      readonly commit: {
        readonly state: "recovered";
        readonly atomicity: "journaled-recoverable";
      };
      readonly operations: readonly [
        AuthorityScaffoldOperationReceipt & {
          readonly outcome: "already-satisfied" | "recovered";
          readonly resultDigest: Sha256Digest;
        },
        ...(AuthorityScaffoldOperationReceipt & {
          readonly outcome: "already-satisfied" | "recovered";
          readonly resultDigest: Sha256Digest;
        })[]
      ];
    })
  | (AuthorityScaffoldReceiptCommon & {
      readonly outcome: "recovery-required";
      readonly commit: {
        readonly state: "recovery-required";
        readonly atomicity: "journaled-recoverable";
      };
      readonly operations: readonly [
        | (AuthorityScaffoldOperationReceipt & {
            readonly outcome: "already-satisfied";
            readonly resultDigest: Sha256Digest;
          })
        | (AuthorityScaffoldOperationReceipt & {
            readonly outcome: "conflict" | "not-applied" | "unobserved";
            readonly resultDigest?: never;
          }),
        ...(
          | (AuthorityScaffoldOperationReceipt & {
              readonly outcome: "already-satisfied";
              readonly resultDigest: Sha256Digest;
            })
          | (AuthorityScaffoldOperationReceipt & {
              readonly outcome: "conflict" | "not-applied" | "unobserved";
              readonly resultDigest?: never;
            })
        )[]
      ];
    })
  | (AuthorityScaffoldReceiptCommon & {
      readonly outcome: "rejected";
      readonly commit: {
        readonly state: "rejected";
        readonly atomicity: "journaled-recoverable";
      };
      readonly operations: readonly (
        | (AuthorityScaffoldOperationReceipt & {
            readonly outcome: "already-satisfied";
            readonly resultDigest: Sha256Digest;
          })
        | (AuthorityScaffoldOperationReceipt & {
            readonly outcome: "conflict" | "not-applied";
            readonly resultDigest?: never;
          })
      )[];
    })
  | (AuthorityScaffoldReceiptCommon & {
      readonly outcome: "authority-stale";
      readonly commit: {
        readonly state: "rolled-back";
        readonly atomicity: "journaled-recoverable";
      };
      readonly operations: readonly [
        AuthorityScaffoldOperationReceipt & {
          readonly outcome: "not-applied";
          readonly resultDigest?: never;
        },
        ...(AuthorityScaffoldOperationReceipt & {
          readonly outcome: "not-applied";
          readonly resultDigest?: never;
        })[]
      ];
    });
