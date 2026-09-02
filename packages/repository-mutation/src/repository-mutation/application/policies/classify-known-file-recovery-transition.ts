import type { KnownFileDigest } from "../model/known-file-transaction.js";
import type { KnownFileTransactionEnvelopeV1 } from "../model/known-file-transaction-journal.js";

export interface InstalledKnownFileRecoveryBuild {
  readonly ownerArtifact: { readonly name: string; readonly buildIdentity: KnownFileDigest; readonly version: string };
  readonly kernelArtifact: { readonly name: string; readonly buildIdentity: KnownFileDigest; readonly version: string };
}

export type KnownFileRecoveryTransition =
  | {
      readonly action: "reject";
      readonly code: "KNOWN_FILE_EXACT_BUILD_REQUIRED";
      readonly message: "The exact owner and kernel artifacts that created this journal must recover it.";
    }
  | { readonly action: "resume-committed-cleanup" }
  | { readonly action: "rollback-applying" };

/**
 * Classifies the next top-level transition for an already parsed and validated
 * known-file v1 recovery envelope. Evidence parsing and all effects remain the
 * responsibility of the calling adapter.
 */
export function classifyKnownFileRecoveryTransition(input: {
  readonly envelope: KnownFileTransactionEnvelopeV1;
  readonly installedBuild: InstalledKnownFileRecoveryBuild;
}): KnownFileRecoveryTransition {
  if (["name", "version", "buildIdentity"].some((field) =>
    input.envelope.ownerArtifact[field as keyof typeof input.envelope.ownerArtifact] !==
      input.installedBuild.ownerArtifact[field as keyof typeof input.installedBuild.ownerArtifact] ||
    input.envelope.kernelArtifact[field as keyof typeof input.envelope.kernelArtifact] !==
      input.installedBuild.kernelArtifact[field as keyof typeof input.installedBuild.kernelArtifact])) {
    return {
      action: "reject",
      code: "KNOWN_FILE_EXACT_BUILD_REQUIRED",
      message: "The exact owner and kernel artifacts that created this journal must recover it."
    };
  }
  return input.envelope.state === "COMMITTED"
    ? { action: "resume-committed-cleanup" }
    : { action: "rollback-applying" };
}
