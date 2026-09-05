import {
  assertKnownFileTransactionEnvelope,
  assertRepositoryMutationArtifactBindings,
  canonicalJson,
  installedRepositoryMutationBuildIdentity,
  installedRepositoryMutationVersion,
  parseRepositoryMutationEnvelope,
  REPOSITORY_MUTATION_PACKAGE_NAME,
  type CanonicalJsonValue
} from "@agent-teams/repository-mutation";

import type { InternalFoundationTransactionStatus } from "../../application/model/internal-transaction-status.js";

function manual(message: string): InternalFoundationTransactionStatus {
  return {
    state: "manual-recovery-required",
    reason: "recovery-handler-unavailable",
    diagnostics: [{
      code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
      message
    }]
  };
}

export async function inspectSchema6TransactionStatus(value: Record<string, unknown>): Promise<InternalFoundationTransactionStatus> {
  const bytes = Buffer.from(
    canonicalJson(value as CanonicalJsonValue),
    "utf8"
  );
  const envelope = parseRepositoryMutationEnvelope(bytes);
  if (envelope.operationKind === "known-file-transaction") {
    const [version, buildIdentity] = await Promise.all([
      installedRepositoryMutationVersion(),
      installedRepositoryMutationBuildIdentity()
    ]);
    const artifact = { name: REPOSITORY_MUTATION_PACKAGE_NAME, version, buildIdentity };
    assertRepositoryMutationArtifactBindings(envelope, artifact, artifact);
    assertKnownFileTransactionEnvelope(envelope);
    return {
      state: "pending",
      operationKind: "known-file-transaction",
      format: "known-file-transaction-envelope-v1",
      recoveryArtifacts: {
        schemaVersion: 6,
        ownerArtifact: {
          name: envelope.ownerArtifact.name,
          version: envelope.ownerArtifact.version,
          buildIdentity: envelope.ownerArtifact.buildIdentity
        },
        kernelArtifact: {
          name: envelope.kernelArtifact.name,
          version: envelope.kernelArtifact.version,
          buildIdentity: envelope.kernelArtifact.buildIdentity
        }
      },
      // Retain the public display spelling; the recovery owner is Mutation.
      foundationVersion: version,
      foundationBuildIdentity: buildIdentity,
      recovery: {
        commandId: "replace-known-file-recover",
        exactFoundationVersion: version,
        exactFoundationBuildIdentity: buildIdentity
      },
      diagnostics: [{
        code: "FOUNDATION_TRANSACTION_ACTIVE",
        message: `A known-file transaction requires @agent-teams/repository-mutation ${version} (${buildIdentity}) as both owner and kernel before another Foundation mutation can start.`
      }]
    };
  }
  return manual(
    `The schema6 operation ${envelope.operationKind} has no closed Foundation recovery handler and was preserved.`
  );
}
