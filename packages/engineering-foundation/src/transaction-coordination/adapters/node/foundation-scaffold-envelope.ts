import {
  assertRepositoryMutationArtifactBindings,
  compileRepositoryMutationEnvelope,
  installedRepositoryMutationBuildIdentity,
  installedRepositoryMutationVersion,
  parseRepositoryMutationEnvelope,
  REPOSITORY_MUTATION_PACKAGE_NAME,
  type CanonicalJsonValue,
  type RepositoryMutationArtifactIdentity,
  type RepositoryMutationEnvelope
} from "@agent-teams/repository-mutation";

import { installedFoundationVersion } from "../../../local-mode/adapters/node/installed-package-version.js";
import type { AuthorityScaffoldJournal } from "../../../scaffolding/contract/types.js";
import { assertAuthorityScaffoldJournal } from "../../../scaffolding/kernel/authority-journal-validation.js";
import { installedFoundationBuildIdentity } from "./installed-foundation-build-identity.js";

const FOUNDATION_PACKAGE_NAME = "@agent-teams/engineering-foundation";
const operationKind = "scaffolding";
const recoveryHandlerId = "agent-teams.engineering-foundation.scaffolding/v1";
const payloadKind = "agent-teams.engineering-foundation.scaffold-recovery-journal/v1";

interface InstalledEnvelopeArtifacts {
  readonly owner: RepositoryMutationArtifactIdentity;
  readonly kernel: RepositoryMutationArtifactIdentity;
}

let installedArtifacts: Promise<InstalledEnvelopeArtifacts> | undefined;

async function resolveInstalledArtifacts(): Promise<InstalledEnvelopeArtifacts> {
  installedArtifacts ??= (async () => {
    const [ownerVersion, ownerBuildIdentity, kernelVersion, kernelBuildIdentity] =
      await Promise.all([
        installedFoundationVersion(),
        installedFoundationBuildIdentity(),
        installedRepositoryMutationVersion(),
        installedRepositoryMutationBuildIdentity()
      ]);
    return {
      owner: {
        name: FOUNDATION_PACKAGE_NAME,
        version: ownerVersion,
        buildIdentity: ownerBuildIdentity
      },
      kernel: {
        name: REPOSITORY_MUTATION_PACKAGE_NAME,
        version: kernelVersion,
        buildIdentity: kernelBuildIdentity
      }
    };
  })();
  return installedArtifacts;
}

function assertClosedFoundationScaffoldTuple(envelope: RepositoryMutationEnvelope): void {
  if (envelope.operationKind !== operationKind ||
    envelope.recoveryHandler.id !== recoveryHandlerId ||
    envelope.recoveryHandler.contractVersion !== 1 ||
    envelope.adapterContractVersion !== 1 ||
    envelope.payloadKind !== payloadKind ||
    envelope.state !== "PREPARED") {
    throw new Error("Foundation scaffolding envelope handler, payload, or state is unsupported.");
  }
}

export async function compileFoundationScaffoldEnvelope(
  journal: AuthorityScaffoldJournal
): Promise<RepositoryMutationEnvelope> {
  // Foundation owns this finite tuple and validates its payload before the inert leaf sees it.
  assertAuthorityScaffoldJournal(journal);
  const artifacts = await resolveInstalledArtifacts();
  return compileRepositoryMutationEnvelope({
    operationKind,
    recoveryHandler: { id: recoveryHandlerId, contractVersion: 1 },
    ownerArtifact: artifacts.owner,
    kernelArtifact: artifacts.kernel,
    adapterContractVersion: 1,
    payloadKind,
    state: "PREPARED",
    payload: journal as unknown as CanonicalJsonValue
  });
}

export async function parseFoundationScaffoldEnvelope(
  bytes: Uint8Array
): Promise<{ readonly envelope: RepositoryMutationEnvelope; readonly journal: AuthorityScaffoldJournal }> {
  const envelope = parseRepositoryMutationEnvelope(bytes);
  const artifacts = await resolveInstalledArtifacts();
  // Bind both installed artifacts before interpreting any owner payload fields.
  assertRepositoryMutationArtifactBindings(envelope, artifacts.owner, artifacts.kernel);
  assertClosedFoundationScaffoldTuple(envelope);
  assertAuthorityScaffoldJournal(envelope.payload as unknown as AuthorityScaffoldJournal);
  return {
    envelope,
    journal: envelope.payload as unknown as AuthorityScaffoldJournal
  };
}
