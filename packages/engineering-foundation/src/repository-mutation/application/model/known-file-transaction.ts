export type KnownFileDigest = `sha256:${string}`;

export interface KnownFileImageV1 {
  readonly contentBase64: string;
  readonly digest: KnownFileDigest;
  readonly mode: number;
  readonly size: number;
}

export type KnownFilePreconditionV1 =
  | { readonly state: "absent" }
  | {
      readonly state: "known-file";
      readonly acceptedPreimages: readonly KnownFileImageV1[];
    };

export interface KnownFileTransactionOperationV1 {
  readonly path: string;
  readonly precondition: KnownFilePreconditionV1;
  readonly postimage: KnownFileImageV1;
}

export interface KnownFileTransactionPlanV1 {
  readonly schemaVersion: 1;
  readonly protocol: "foundation.replace-known-file/v1";
  readonly operations: readonly KnownFileTransactionOperationV1[];
  readonly planDigest: KnownFileDigest;
}

export type KnownFileTransactionOperationOutcome =
  | "already-satisfied"
  | "created"
  | "replaced"
  | "rolled-back-to-absent"
  | "rolled-back-to-preimage";

export interface KnownFileTransactionReceiptV1 {
  readonly schemaVersion: 1;
  readonly protocol: "foundation.replace-known-file/v1";
  readonly planDigest: KnownFileDigest;
  readonly outcome: "already-satisfied" | "applied" | "rolled-back";
  readonly operations: readonly {
    readonly path: string;
    readonly outcome: KnownFileTransactionOperationOutcome;
    readonly resultDigest?: KnownFileDigest;
  }[];
  readonly receiptDigest: KnownFileDigest;
}

export type KnownFileTransactionOperationInput =
  | {
      readonly path: string;
      readonly precondition: { readonly state: "absent" };
      readonly postimage: {
        readonly bytes: Uint8Array;
        readonly mode?: number;
      };
    }
  | {
      readonly path: string;
      readonly precondition: {
        readonly state: "known-file";
        readonly acceptedPreimages: readonly {
          readonly bytes: Uint8Array;
          readonly mode: number;
        }[];
      };
      readonly postimage: {
        readonly bytes: Uint8Array;
        readonly mode: number;
      };
    };

export interface CompileKnownFileTransactionPlanInput {
  readonly operations: readonly KnownFileTransactionOperationInput[];
}
