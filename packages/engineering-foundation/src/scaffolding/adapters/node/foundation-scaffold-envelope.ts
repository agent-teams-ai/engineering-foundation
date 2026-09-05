import {
  assertRepositoryMutationArtifactBindings,
  compileRepositoryMutationEnvelope,
  parseRepositoryMutationEnvelope,
  type CanonicalJsonValue,
  type RepositoryMutationEnvelope
} from "@agent-teams/repository-mutation";

import type {
  AuthorityScaffoldJournal
} from "../../contract/types.js";
import { assertAuthorityScaffoldJournal } from "../inbound/assert-authority-scaffold-journal.js";
import { resolveInstalledFoundationTransactionArtifacts } from "../../../transaction-coordination/adapters/node/installed-foundation-transaction-artifacts.js";

const operationKind = "scaffolding";
const recoveryHandlerId = "agent-teams.engineering-foundation.scaffolding/v1";
const payloadKind = "agent-teams.engineering-foundation.scaffold-recovery-journal/v1";

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
  const artifacts = await resolveInstalledFoundationTransactionArtifacts();
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
  const artifacts = await resolveInstalledFoundationTransactionArtifacts();
  // Bind both installed artifacts before interpreting any owner payload fields.
  assertRepositoryMutationArtifactBindings(envelope, artifacts.owner, artifacts.kernel);
  assertClosedFoundationScaffoldTuple(envelope);
  assertAuthorityScaffoldJournal(envelope.payload as unknown as AuthorityScaffoldJournal);
  return {
    envelope,
    journal: envelope.payload as unknown as AuthorityScaffoldJournal
  };
}
