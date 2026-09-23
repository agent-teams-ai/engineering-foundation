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
import type { ScaffoldTransactionArtifacts } from "../../application/ports/transaction-observation.js";

const operationKind = "scaffolding";
const recoveryHandlerId = "agent-teams.engineering-foundation.scaffolding/v1";
const payloadKind = "agent-teams.engineering-foundation.scaffold-recovery-journal/v1";
let journalValidator: Promise<ValidateFunction<AuthorityScaffoldJournal>> | undefined;

function validateJournal(value: unknown): Promise<AuthorityScaffoldJournal> {
  journalValidator ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const plan = JSON.parse(await readFile(new URL("../../../../schemas/scaffold-plan/v1.schema.json", import.meta.url), "utf8")) as object;
    const journal = JSON.parse(await readFile(new URL("../../../../schemas/scaffold-recovery-journal/v1.schema.json", import.meta.url), "utf8")) as object;
    ajv.addSchema(plan);
    return ajv.compile<AuthorityScaffoldJournal>(journal);
  })();
  return journalValidator.then((validate) => {
    if (!validate(value)) {
      throw new Error("Foundation scaffolding journal does not satisfy the released contract.");
    }
    return value;
  });
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
  journal: AuthorityScaffoldJournal,
  observeArtifacts: ScaffoldTransactionArtifacts
): Promise<RepositoryMutationEnvelope> {
  // Foundation owns this finite tuple and validates its payload before the inert leaf sees it.
  assertAuthorityScaffoldJournal(journal);
  const artifacts = await observeArtifacts();
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
  bytes: Uint8Array,
  observeArtifacts: ScaffoldTransactionArtifacts
): Promise<{ readonly envelope: RepositoryMutationEnvelope; readonly journal: AuthorityScaffoldJournal }> {
  const envelope = parseRepositoryMutationEnvelope(bytes);
  const artifacts = await observeArtifacts();
  // Bind both installed artifacts before interpreting any owner payload fields.
  assertRepositoryMutationArtifactBindings(envelope, artifacts.owner, artifacts.kernel);
  assertClosedFoundationScaffoldTuple(envelope);
  const journal = await validateJournal(envelope.payload);
  assertAuthorityScaffoldJournal(journal);
  return {
    envelope,
    journal
  };
}
import { readFile } from "node:fs/promises";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
