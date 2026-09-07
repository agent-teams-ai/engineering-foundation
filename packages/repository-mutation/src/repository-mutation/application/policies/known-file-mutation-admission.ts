import { REPOSITORY_MUTATION_PACKAGE_NAME } from "../../../transaction-coordination/application-api.js";
import type { MutationClaim, MutationLease } from "../../../transaction-coordination/application-api.js";
import { KnownFileTransactionError } from "../model/known-file-transaction-error.js";
import type { KnownFileTransactionEnvelopeV1 } from "../model/known-file-transaction-journal.js";
import type { KnownFileMutationPort } from "../ports/known-file-mutation.js";

export async function installedMutationArtifact(coordination: Pick<KnownFileMutationPort, "installedRepositoryMutationBuildIdentity" | "installedRepositoryMutationVersion">): Promise<KnownFileTransactionEnvelopeV1["ownerArtifact"]> {
  const [version, buildIdentity] = await Promise.all([
    coordination.installedRepositoryMutationVersion(),
    coordination.installedRepositoryMutationBuildIdentity()
  ]);
  return { name: REPOSITORY_MUTATION_PACKAGE_NAME, version, buildIdentity };
}

export async function ensureApplyClaim(coordination: Pick<KnownFileMutationPort, "claimMutation" | "observeMutationState">, options: {
  readonly artifact: KnownFileTransactionEnvelopeV1["ownerArtifact"];
  readonly claim: MutationClaim | undefined;
  readonly lease: MutationLease | undefined;
  readonly planDigest: `sha256:${string}`;
}): Promise<MutationClaim> {
  if (options.claim !== undefined) {return options.claim;}
  if (options.lease === undefined) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_PLAN_INVALID",
      "Known-file apply did not acquire its mutation lease."
    );
  }
  return coordination.claimMutation(
    options.lease,
    await coordination.observeMutationState(options.lease),
    {
      kind: "apply-known-file",
      planDigest: options.planDigest,
      ownerArtifact: options.artifact,
      kernelArtifact: options.artifact
    }
  );
}

function sameArtifact(
  candidate: KnownFileTransactionEnvelopeV1["ownerArtifact"],
  expected: KnownFileTransactionEnvelopeV1["ownerArtifact"]
): boolean {
  return candidate.name === expected.name &&
    candidate.version === expected.version &&
    candidate.buildIdentity === expected.buildIdentity;
}

export async function assertApplyClaim(coordination: Pick<KnownFileMutationPort, "consumeMutationClaim" | "mutationClaimIntent">, options: {
  readonly artifact: KnownFileTransactionEnvelopeV1["ownerArtifact"];
  readonly claim: MutationClaim;
  readonly planDigest: `sha256:${string}`;
  readonly root: string;
}): Promise<void> {
  const intent = coordination.mutationClaimIntent(options.claim);
  if (intent.kind !== "apply-known-file" ||
    intent.planDigest !== options.planDigest ||
    !sameArtifact(intent.ownerArtifact, options.artifact) ||
    !sameArtifact(intent.kernelArtifact, options.artifact) ||
    await coordination.consumeMutationClaim(options.claim, "apply-known-file") !== options.root) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_PLAN_INVALID",
      "Mutation claim belongs to another repository root, plan, owner, or kernel identity."
    );
  }
}

export async function ensureRecoveryClaim(coordination: Pick<KnownFileMutationPort,
  "claimMutation" | "observeMutationState"
>, options: {
  readonly artifact: KnownFileTransactionEnvelopeV1["ownerArtifact"];
  readonly claim: MutationClaim | undefined;
  readonly lease: MutationLease | undefined;
}): Promise<MutationClaim> {
  if (options.claim !== undefined) {return options.claim;}
  const lease = options.lease!;
  return coordination.claimMutation(lease, await coordination.observeMutationState(lease), {
    kind: "recover-known-file", ownerArtifact: options.artifact, kernelArtifact: options.artifact
  });
}

export async function assertRecoveryClaim(coordination: Pick<KnownFileMutationPort,
  "consumeMutationClaim" | "mutationClaimIntent"
>, options: {
  readonly artifact: KnownFileTransactionEnvelopeV1["ownerArtifact"];
  readonly claim: MutationClaim;
  readonly root: string;
}): Promise<void> {
  const claimedIntent = coordination.mutationClaimIntent(options.claim);
  if (claimedIntent.kind !== "recover-known-file" ||
    !sameArtifact(claimedIntent.ownerArtifact, options.artifact) ||
    !sameArtifact(claimedIntent.kernelArtifact, options.artifact) ||
    await coordination.consumeMutationClaim(options.claim, "recover-known-file") !== options.root) {
    throw new KnownFileTransactionError("KNOWN_FILE_RECOVERY_CONFLICT", "Mutation claim has the wrong root, owner, or kernel identity.");
  }
}
