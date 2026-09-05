import type { PortablePathIdentity } from "../../../path-identity.js";

interface MutationStateSnapshot {
  readonly fingerprint: string;
  readonly commonEvidence: boolean;
}

type MutationLeaseRelease = (
  options?: { readonly retainTransactionBarrier?: boolean }
) => Promise<void>;

/** Physical observations and exclusive ownership; no operation Plan policy. */
export interface MutationLeasePort {
  readonly canonicalRoot: (root: string) => Promise<string>;
  readonly physicalRootIdentity: (root: string) => Promise<PortablePathIdentity>;
  readonly acquire: (root: string) => Promise<MutationLeaseRelease>;
  readonly snapshot: (root: string) => Promise<MutationStateSnapshot>;
}
