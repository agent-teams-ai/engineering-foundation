import type { FileHandle, mkdir } from "node:fs/promises";
import type { PortablePathIdentity, PathIdentityMatch } from "../../../path-identity.js";
import type {
   MutationClaim, MutationIntent, MutationLease, MutationObservation,
  BoundedRegularFileRead, TerminalEvidenceDirectoryAuthority
} from "../../../transaction-coordination/application-api.js";

/** Exact physical capabilities selected by module composition for file operations. */
export interface KnownFileCoordination {
  readonly readBoundedRegularFile: (path: string, maximumBytes: number) => Promise<BoundedRegularFileRead>;
  readonly readBoundedRegularFileHandle: (handle: FileHandle, path: string, maximumBytes: number) => Promise<BoundedRegularFileRead>;
  readonly captureFileHandleIdentity: (handle: FileHandle) => Promise<PortablePathIdentity>;
  readonly pathMatchesRegularFileIdentity: (path: string, expected: PortablePathIdentity) => Promise<PathIdentityMatch>;
  readonly ensureTerminalEvidenceDirectory: (path: string, overrides?: { readonly mkdir?: typeof mkdir }) => Promise<TerminalEvidenceDirectoryAuthority>;
  readonly assertTerminalEvidenceDirectory: (authority: TerminalEvidenceDirectoryAuthority) => Promise<void>;
  readonly installedRepositoryMutationBuildIdentity: () => Promise<`sha256:${string}`>;
  readonly installedRepositoryMutationVersion: () => Promise<string>;
  readonly acquireMutationLease: (root: string) => Promise<MutationLease>;
  readonly observeMutationState: (lease: MutationLease) => Promise<MutationObservation>;
  readonly claimMutation: (lease: MutationLease, observation: MutationObservation, intent: MutationIntent) => Promise<MutationClaim>;
  readonly consumeMutationClaim: (claim: MutationClaim, expectedKind: MutationIntent["kind"]) => Promise<string>;
  readonly mutationClaimIntent: (claim: MutationClaim) => MutationIntent;
  readonly retainMutationClaimBarrierOnEvidence: (claim: MutationClaim) => Promise<void>;
  readonly retainMutationBarrierOnEvidence: (lease: MutationLease) => Promise<boolean>;
  readonly retainMutationBarrier: (lease: MutationLease) => void;
  readonly releaseMutationLease: (lease: MutationLease) => Promise<void>;
  readonly ensureMutationStateDirectory: (root: string) => Promise<string>;
  readonly pruneMutationStateDirectory: (root: string) => Promise<void>;
}

export type { BoundedRegularFileRead } from "../../../transaction-coordination/application-api.js";
