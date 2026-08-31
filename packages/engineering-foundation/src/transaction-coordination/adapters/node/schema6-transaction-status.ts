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
import { parseFoundationScaffoldEnvelope } from "./foundation-scaffold-envelope.js";
import { inspectKnownFileTransactionStatus } from "./known-file-transaction-status.js";

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

export async function inspectSchema6TransactionStatus(options: {
  readonly value: Record<string, unknown>;
  readonly installedFoundationVersion: string;
  readonly installedFoundationBuildIdentity: string;
}): Promise<InternalFoundationTransactionStatus> {
  const bytes = Buffer.from(
    canonicalJson(options.value as CanonicalJsonValue),
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
    return inspectKnownFileTransactionStatus({
      value: options.value,
      schemaVersion: 6,
      installedVersion: version,
      installedBuildIdentity: buildIdentity
    }) ?? manual(
      "The Repository Mutation known-file schema6 envelope was preserved but could not be classified."
    );
  }
  if (envelope.operationKind !== "scaffolding") {
    return manual(
      `The schema6 operation ${envelope.operationKind} has no closed Foundation recovery handler and was preserved.`
    );
  }
  await parseFoundationScaffoldEnvelope(bytes);
  return {
    state: "pending",
    operationKind: "scaffolding",
    format: "foundation-scaffolding-envelope-v6",
    foundationVersion: options.installedFoundationVersion,
    recovery: {
      commandId: "scaffold-recover",
      exactFoundationVersion: options.installedFoundationVersion
    },
    diagnostics: [{
      code: "FOUNDATION_TRANSACTION_ACTIVE",
      message: "A pending scaffolding transaction must be recovered before another Foundation mutation can start."
    }]
  };
}
