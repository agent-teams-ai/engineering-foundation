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

export type KnownFileTransactionJournalOperationV1 =
  | {
      readonly path: string;
      readonly state: "already-satisfied" | "pending";
      readonly matchedPreimage?: number;
    }
  | {
      readonly path: string;
      readonly state: "temporary-ready" | "publishing" | "published";
      readonly matchedPreimage?: number;
      readonly temporaryIdentity: KnownFileTransactionPortableIdentityV1;
    };

export interface KnownFileTransactionJournalV1 {
  readonly schemaVersion: 1;
  readonly plan: KnownFileTransactionPlanV1;
  readonly operations: readonly KnownFileTransactionJournalOperationV1[];
  readonly createdDirectories: readonly {
    readonly path: string;
    readonly identity: KnownFileTransactionPortableIdentityV1;
  }[];
}

export interface KnownFileTransactionEnvelopeV1 {
  readonly schemaVersion: 5;
  readonly operationKind: "known-file-transaction";
  readonly recoveryHandler: {
    readonly id: "foundation.replace-known-file";
    readonly contractVersion: 1;
  };
  readonly foundation: {
    readonly version: string;
    readonly buildIdentity: KnownFileDigest;
  };
  readonly adapterContractVersion: 1;
  readonly payloadKind: "known-file-transaction-journal/v1";
  readonly state: "APPLYING" | "COMMITTED";
  readonly journal: KnownFileTransactionJournalV1;
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
