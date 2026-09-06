export { acquireMutationLease } from "./node-mutation-lease.js";
export { claimMutation, consumeMutationClaim, mutationClaimIntent, observeMutationState,
  retainMutationBarrierOnEvidence, retainMutationClaimBarrierOnEvidence,
  retainMutationBarrier, releaseMutationLease } from "../application/mutation-lease.js";
export { installedRepositoryMutationBuildIdentity, computeInstalledArtifactBuildIdentity } from "../adapters/node/installed-artifact-identity.js";
export { installedRepositoryMutationVersion } from "../adapters/node/package-version.js";
export { ensureMutationStateDirectory, pruneMutationStateDirectory } from "../adapters/node/node-state-directory.js";
export { readBoundedRegularFile, readBoundedRegularFileHandle,
  captureFileHandleIdentity, pathMatchesRegularFileIdentity } from "../adapters/node/node-bounded-regular-file.js";
export { assertTerminalEvidenceDirectory, ensureTerminalEvidenceDirectory } from "../adapters/node/node-terminal-evidence-directory.js";
export type { InstalledArtifactClosure, InstalledArtifactDigest } from "../adapters/node/installed-artifact-identity.js";
