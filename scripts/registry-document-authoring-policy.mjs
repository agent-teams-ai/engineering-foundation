import assert from "node:assert/strict";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const profileArguments = [
  "--consumer", ".", "--profile", "architecture/foundation/docs-protocol.yaml"
];
const transitionName = "scaffolding-transaction.json.document-transition";
const permittedStateEntries = ["foundation-operation.lock", transitionName].toSorted();

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

function portableFileIdentity(stats) {
  assert.notEqual(stats.ino, 0n,
    "Windows Docs Protocol transition evidence has no portable file identity.");
  return { device: stats.dev, inode: stats.ino };
}

async function readTransitionEvidence(path) {
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    const lexical = await lstat(path, { bigint: true });
    assert.ok(opened.isFile() && lexical.isFile() && !lexical.isSymbolicLink(),
      "Windows Docs Protocol transition evidence is not a regular physical file.");
    const identity = portableFileIdentity(opened);
    assert.deepEqual(portableFileIdentity(lexical), identity,
      "Windows Docs Protocol transition evidence changed while binding its open handle.");
    return { bytes: await handle.readFile(), identity };
  } finally {
    await handle.close();
  }
}

async function captureMutationEvidence(input) {
  await assert.rejects(lstat(input.documentPath), { code: "ENOENT" });
  assert.deepEqual(await readFile(input.indexPath), input.indexBefore,
    "Windows Docs Protocol strict durability refusal changed catalog reachability.");
  const stateDirectory = join(input.consumerRoot, ".agent-teams-local");
  const stateEntries = (await readdir(stateDirectory)).toSorted();
  assert.deepEqual(stateEntries, permittedStateEntries,
    "Windows Docs Protocol recovery state contains an unexpected entry census.");
  return {
    stateEntries,
    transition: await readTransitionEvidence(join(stateDirectory, transitionName))
  };
}

async function assertMutationEvidenceUnchanged(input, expected) {
  const observed = await captureMutationEvidence(input);
  assert.deepEqual(observed.stateEntries, expected.stateEntries,
    "Windows Docs Protocol recovery state census changed during inspection.");
  assert.deepEqual(observed.transition.bytes, expected.transition.bytes,
    "Windows Docs Protocol transition evidence bytes changed during inspection.");
  assert.deepEqual(observed.transition.identity, expected.transition.identity,
    "Windows Docs Protocol transition evidence file identity changed during inspection.");
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
  const evidenceSnapshot = await captureMutationEvidence(evidence);
  const doctor = await input.runDocs(["doctor", ...profileArguments], 1);
  const recover = await input.runDocs(["recover", ...profileArguments], 1);
  assertWindowsDocsRecoveryInspection(doctor, recover);
  await assertMutationEvidenceUnchanged(evidence, evidenceSnapshot);
}
