import type { PortablePathIdentity } from "./path-identity.js";
import type {
  KnownFileDigest,
  KnownFileTransactionPlanV1
} from "./known-file-transaction.js";

export interface KnownFileTransactionPortableIdentityV1 {
  readonly birthtimeNs: string;
  readonly dev: string;
  readonly ino: string;
}

export interface KnownFileTransactionRetirementV1 {
  readonly kind: "destination" | "rollback-temporary" | "temporary";
  readonly state: "ready" | "captured" | "unlink-authorized";
  readonly directoryIdentity: KnownFileTransactionPortableIdentityV1;
  readonly pathIdentity: KnownFileTransactionPortableIdentityV1;
}

export type KnownFileTransactionJournalOperationV1 =
  | {
      readonly path: string;
      readonly state: "already-satisfied" | "pending" | "temporary-authorized";
      readonly matchedPreimage?: number;
      readonly rollbackTemporaryIdentity?: never;
      readonly captureDirectoryIdentity?: never;
      readonly capturedPreimageIdentity?: never;
      readonly retirement?: never;
    }
  | {
      readonly path: string;
      readonly state:
        | "temporary-ready"
        | "capture-authorized"
        | "capture-ready"
        | "preimage-captured"
        | "destination-retired"
        | "publishing"
        | "published"
        | "rollback-restored";
      readonly matchedPreimage?: number;
      readonly rollbackTemporaryIdentity?: KnownFileTransactionPortableIdentityV1;
      readonly temporaryIdentity: KnownFileTransactionPortableIdentityV1;
      readonly captureDirectoryIdentity?: KnownFileTransactionPortableIdentityV1;
      readonly capturedPreimageIdentity?: KnownFileTransactionPortableIdentityV1;
      readonly retirement?: KnownFileTransactionRetirementV1;
    };

export interface KnownFileTransactionJournalV1 {
  readonly schemaVersion: 1;
  readonly plan: KnownFileTransactionPlanV1;
  readonly operations: readonly KnownFileTransactionJournalOperationV1[];
  readonly authorizedDirectories: readonly string[];
  readonly createdDirectories: readonly {
    readonly path: string;
    readonly identity: KnownFileTransactionPortableIdentityV1;
  }[];
}

export interface KnownFileTransactionEnvelopeV1 {
  readonly schemaVersion: 6;
  readonly format: "agent-teams.repository-mutation.transaction-envelope/v1";
  readonly operationKind: "known-file-transaction";
  readonly recoveryHandler: {
    readonly id: "agent-teams.repository-mutation.known-file/v1";
    readonly contractVersion: 1;
  };
  readonly ownerArtifact: {
    readonly name: string;
    readonly version: string;
    readonly buildIdentity: KnownFileDigest;
  };
  readonly kernelArtifact: {
    readonly name: string;
    readonly version: string;
    readonly buildIdentity: KnownFileDigest;
  };
  readonly adapterContractVersion: 1;
  readonly payloadKind: "agent-teams.repository-mutation.known-file-journal/v1";
  readonly state: "APPLYING" | "COMMITTED";
  readonly payload: KnownFileTransactionJournalV1;
  readonly payloadDigest: KnownFileDigest;
  readonly envelopeDigest: KnownFileDigest;
}

export function serializeKnownFileIdentity(
  identity: PortablePathIdentity
): KnownFileTransactionPortableIdentityV1 {
  return Object.freeze({
    birthtimeNs: identity.birthtimeNs.toString(),
    dev: identity.dev.toString(),
    ino: identity.ino.toString()
  });
}

export function deserializeKnownFileIdentity(
  identity: KnownFileTransactionPortableIdentityV1
): PortablePathIdentity {
  return {
    birthtimeNs: BigInt(identity.birthtimeNs),
    dev: BigInt(identity.dev),
    ino: BigInt(identity.ino)
  };
}
