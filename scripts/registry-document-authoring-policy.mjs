import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const profileArguments = [
  "--consumer", ".", "--profile", "architecture/foundation/docs-protocol.yaml"
];

function transactionProjection(envelope) {
  return {
    state: envelope.result?.transaction?.state,
    reason: envelope.result?.transaction?.reason
  };
}

export function assertWindowsDocsApplyRecovery(applied, expectedDocumentPath) {
  assert.deepEqual({
    command: applied.command,
    outcome: applied.outcome,
    kind: applied.result?.kind,
    reservation: applied.result?.reservation,
    writeState: applied.result?.writeState,
    documentPath: applied.result?.documentPath,
    receiptOutcome: applied.result?.receiptOutcome,
    outcomeReceipt: applied.result?.receipt?.outcome,
    commit: applied.result?.receipt?.commit,
    directoryState: applied.result?.receipt?.directoryMaterialization?.state
  }, {
    command: "docs.new",
    outcome: "recovery-required",
    kind: "new",
    reservation: "none",
    writeState: "unchanged",
    documentPath: expectedDocumentPath,
    receiptOutcome: "manual-recovery-required",
    outcomeReceipt: "manual-recovery-required",
    commit: {
      state: "manual-recovery-required",
      publication: "none",
      recoverability: "preserved-for-recovery"
    },
    directoryState: "preserved-unknown"
  }, "Windows Docs Protocol apply did not preserve the strict durability recovery contract.");
  assert.match(applied.result?.planDigest ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.match(applied.result?.receiptDigest ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.ok(applied.diagnostics?.some(({ ruleId }) =>
    ruleId === "document.transaction.journal-reconciliation"));
}

export function assertWindowsDocsRecoveryInspection(doctor, recover) {
  assert.deepEqual({
    command: doctor.command,
    outcome: doctor.outcome,
    durability: doctor.result?.environment?.filesystem?.strictDirectoryDurability,
    transaction: transactionProjection(doctor)
  }, {
    command: "docs.doctor",
    outcome: "recovery-required",
    durability: "platform-unsupported",
    transaction: { state: "manual-recovery-required", reason: "journal-transition-residue" }
  }, "Windows Docs Protocol doctor did not classify the preserved journal transition residue.");
  assert.deepEqual({
    command: recover.command,
    outcome: recover.outcome,
    transactionState: recover.result?.transactionState,
    writeState: recover.result?.writeState,
    transaction: transactionProjection(recover)
  }, {
    command: "docs.recover",
    outcome: "recovery-required",
    transactionState: "manual-required",
    writeState: "unknown",
    transaction: { state: "manual-recovery-required", reason: "journal-transition-residue" }
  }, "Windows Docs Protocol recover did not preserve the manual recovery classification.");
}

async function assertMutationEvidence(input) {
  await assert.rejects(lstat(input.documentPath), { code: "ENOENT" });
  assert.deepEqual(await readFile(input.indexPath), input.indexBefore,
    "Windows Docs Protocol strict durability refusal changed catalog reachability.");
  const stateDirectory = join(input.consumerRoot, ".agent-teams-local");
  const transitionName = "scaffolding-transaction.json.document-transition";
  assert.ok((await readdir(stateDirectory)).includes(transitionName));
  assert.ok((await lstat(join(stateDirectory, transitionName))).isFile(),
    "Windows Docs Protocol strict durability refusal did not preserve transition evidence.");
}

export async function verifyWindowsDocsRecoveryQualification(input) {
  const evidence = {
    consumerRoot: input.consumerRoot,
    documentPath: join(input.consumerRoot, input.expectedDocumentPath),
    indexPath: join(input.consumerRoot, "docs", "catalog", "README.md")
  };
  evidence.indexBefore = await readFile(evidence.indexPath);
  const applied = await input.runDocs(input.applyArguments, 1);
  assertWindowsDocsApplyRecovery(applied, input.expectedDocumentPath);
  await assertMutationEvidence(evidence);
  const doctor = await input.runDocs(["doctor", ...profileArguments], 1);
  const recover = await input.runDocs(["recover", ...profileArguments], 1);
  assertWindowsDocsRecoveryInspection(doctor, recover);
  await assertMutationEvidence(evidence);
}
