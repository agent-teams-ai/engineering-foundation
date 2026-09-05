import assert from "node:assert/strict";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRoot, slotPath, writeJson, observeEvidence, buildDocumentEnvelope, coordinatorWith, installedBuildIdentity } from "./support/foundation-transaction-observation-fixtures.mjs";
import { FoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/transaction-coordination/application/foundation-transaction-coordinator.js";
import { FoundationTransactionError } from "../packages/engineering-foundation/dist/transaction-coordination/application/foundation-transaction-error.js";
import { createNodeFoundationTransactionSlot } from "../packages/engineering-foundation/dist/composition/node-foundation-transaction-slot.js";
import { createNodeFoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/composition/node-foundation-transaction-coordinator.js";
import { documentPlanDigest } from "../packages/document-authoring/dist/application/policies/document-contract-digests.js";
import { applyFilesystemScaffold, planScaffoldFromFile, recoverFilesystemScaffold } from "../packages/engineering-foundation/dist/scaffolding/index.js";
import { sha256Json } from "../packages/engineering-foundation/dist/scaffolding/kernel/canonical-json.js";
const scaffoldFixtureRoot = fileURLToPath(new URL("fixtures/scaffolding-authority-consumer/", import.meta.url));

// Historical artifacts are evidence only in the split Foundation observer.
const historicalFixtures = new URL("fixtures/foundation-historical-transactions/", import.meta.url);
const { NodeFoundationOperationLock } = await import("../packages/engineering-foundation/dist/transaction-coordination/adapters/node/node-foundation-operation-lock.js");
const { sha256Bytes, compileKnownFileTransactionPlan, compileRepositoryMutationEnvelope,
  installedRepositoryMutationVersion, installedRepositoryMutationBuildIdentity,
} = await import("../packages/repository-mutation/dist/index.js");
const { applyKnownFileTransaction, recoverKnownFileTransaction } = await import("../packages/repository-mutation/dist/qualification/index.js");
const { FoundationLocalModeService } = await import("../packages/engineering-foundation/dist/local-mode/index.js");

async function historicalFixture(name) {
  return readFile(new URL(name, historicalFixtures));
}

async function assertHistoricalBarrier(root, source, installed) {
  const path = slotPath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
  const slot = createNodeFoundationTransactionSlot({ consumerRoot: root, ...installed });
  const status = await slot.inspect();
  assert.equal(status.state, "manual-recovery-required");
  assert.equal(status.recovery, undefined);
  const coordinator = new FoundationTransactionCoordinator({
    slot, lock: new NodeFoundationOperationLock(root),
  });
  for (const requestedMutation of ["attach", "detach", "scaffolding", "document-authoring", "known-file-transaction"]) {
    await assert.rejects(coordinator.acquire({
      requestedMutation,
      allowRecoveryOf: requestedMutation === "detach" ? "local-mode" : requestedMutation,
    }), (error) => error instanceof FoundationTransactionError &&
      error.status.state === "manual-recovery-required");
  }
  assert.deepEqual(await readFile(path), source);
  return status;
}

function rehashEnvelope(value) {
  if (value.journal !== undefined) { value.payloadDigest = sha256Json(value.journal); }
  const { envelopeDigest: _digest, ...body } = value;
  return { ...body, envelopeDigest: sha256Json(body) };
}

test("split Foundation never grants v3/v4/v5 leases, even at the claimed exact build", async (context) => {
  const provenance = JSON.parse(await historicalFixture("provenance.json"));
  for (const [name, digest] of Object.entries(provenance.files)) {
    await context.test(name, async () => {
      const root = await createRoot();
      try {
        const source = await historicalFixture(name);
        assert.equal(sha256Bytes(source), `sha256:${digest}`);
        const envelope = JSON.parse(source);
        const status = await assertHistoricalBarrier(root, source, {
          installedVersion: envelope.foundation.version,
          installedBuildIdentity: envelope.foundation.buildIdentity,
        });
        const message = status.diagnostics[0].message;
        assert.match(message, /[Uu]ntrusted/u);
        {
          // The retained "mixed" fixture claims BOTH old literals with a new
          // artifact's coordinates. It is still only an untrusted old-owner claim.
          const newOwner = name.startsWith("current-document");
          assert.ok(message.includes(newOwner ? "@agent-teams/document-authoring" : "@agent-teams/engineering-foundation"));
          assert.ok(message.includes(envelope.foundation.version));
          assert.ok(message.includes(envelope.foundation.buildIdentity));
          if (newOwner) { assert.match(message, /inspectDocumentTransactionV2/u); }
        }
      } finally { await rm(root, { force: true, recursive: true }); }
    });
  }
});

test("historical schema5 malformed claims, payloads, digests and residues stay manual", async (context) => {
  const native = JSON.parse(await historicalFixture("native-v5-after-journal-created.json"));
  for (const [name, mutate] of [
    ["wrong handler", (value) => { value.recoveryHandler.id = "document-authoring"; }],
    ["wrong operation", (value) => { value.operationKind = "scaffolding"; }],
    ["wrong payload", (value) => { value.payloadKind = "unknown"; }],
    ["wrong journal", (value) => { value.journal.schemaVersion = 99; }],
    ["unknown field", (value) => { value.unexpected = true; }],
    ["absent journal", (value) => { delete value.journal; }],
    ["bad Plan digest", (value) => { value.journal.plan.planDigest = `sha256:${"0".repeat(64)}`; }],
    ["malformed identity", (value) => { value.foundation.buildIdentity = "untrusted\ncontrol"; }],
    ["unbounded version", (value) => { value.foundation.version = "1".repeat(1000); }],
  ]) {
    await context.test(name, async () => {
      const root = await createRoot();
      try {
        const value = structuredClone(native); mutate(value);
        const status = await assertHistoricalBarrier(root, Buffer.from(JSON.stringify(rehashEnvelope(value))), {
          installedVersion: native.foundation.version, installedBuildIdentity: native.foundation.buildIdentity,
        });
        assert.match(status.diagnostics[0].message, /[Uu]ntrusted/u);
        assert.ok(status.diagnostics[0].message.length < 1000);
      } finally { await rm(root, { force: true, recursive: true }); }
    });
  }
  for (const field of ["payloadDigest", "envelopeDigest"]) {
    const root = await createRoot();
    try {
      const value = structuredClone(native); value[field] = `sha256:${"f".repeat(64)}`;
      await assertHistoricalBarrier(root, Buffer.from(JSON.stringify(value)), {
        installedVersion: native.foundation.version, installedBuildIdentity: native.foundation.buildIdentity,
      });
    } finally { await rm(root, { force: true, recursive: true }); }
  }
  for (const suffix of [".tmp", ".known-file-transition", ".document-transition"]) {
    const root = await createRoot();
    try {
      await mkdir(dirname(slotPath(root)), { recursive: true });
      const residue = `${slotPath(root)}${suffix}`;
      await writeFile(residue, "independent evidence\n");
      await assertHistoricalBarrier(root, await historicalFixture("native-v5-after-journal-created.json"), {
        installedVersion: native.foundation.version, installedBuildIdentity: native.foundation.buildIdentity,
      });
      assert.equal(await readFile(residue, "utf8"), "independent evidence\n");
    } finally { await rm(root, { force: true, recursive: true }); }
  }
});

test("new and old document claims remain manual across rebuilt, newer and older Foundation identities", async () => {
  for (const name of ["old-document-envelope-v1.json", "old-document-envelope-v2.json", "current-document-envelope-v1.json", "current-document-envelope-v2.json"]) {
    const source = await historicalFixture(name);
    const value = JSON.parse(source);
    const statuses = [];
    for (const installedVersion of [value.foundation.version, "0.0.1", "99.0.0"]) {
      const root = await createRoot();
      try {
        statuses.push(await assertHistoricalBarrier(root, source, {
          installedVersion, installedBuildIdentity: `sha256:${"a".repeat(64)}`,
        }));
      } finally { await rm(root, { force: true, recursive: true }); }
    }
    assert.deepEqual(statuses[0], statuses[1]);
    assert.deepEqual(statuses[1], statuses[2]);
  }
});

test("Foundation v2 selects the exact frozen Plan closure and rejects the new compiler", async () => {
  const { assertSchema } = await import("../packages/engineering-foundation/dist/schema-catalog.js");
  const { readDocumentAuthoringSchema } = await import("../packages/document-authoring/dist/index.js");
  // Loading the independent current catalog first must not shadow historical IDs.
  await readDocumentAuthoringSchema("document-plan/v1");
  const frozen = await readFile(new URL("../packages/engineering-foundation/assets/transaction-coordination/historical/document-plan-v1.schema.json", import.meta.url));
  assert.equal(sha256Bytes(frozen), "sha256:ff7a9c57837454ea8807b0c7459ea3bb796bf0ea8cafdeee261fccaea3e00397");
  const old = buildDocumentEnvelope();
  await assertSchema("foundation-transaction-envelope/v2", old, "frozen-v2");
  old.journal.plan.compiler.id = "@agent-teams/document-authoring";
  await assert.rejects(assertSchema("foundation-transaction-envelope/v2", rehashEnvelope(old), "frozen-v2"), /constant/u);
  const manifest = JSON.parse(await readFile(new URL("../packages/engineering-foundation/package.json", import.meta.url)));
  assert.ok(manifest.files.includes("assets/transaction-coordination/historical/document-plan-v1.schema.json"));
  for (const removed of ["./mutation", "./mutation/qualification", "./document-authoring", "./document-authoring/qualification"]) {
    assert.equal(manifest.exports[removed], undefined);
  }
  assert.equal(manifest.files.some((path) => path.includes("foundation-transaction-envelope/v5")), false);
});

test("legacy pending strings cannot bypass coordinated known-file admission", async () => {
  const status = {
    state: "pending", operationKind: "known-file-transaction", format: "known-file-transaction-envelope-v1",
    foundationVersion: "0.21.0", foundationBuildIdentity: installedBuildIdentity,
    recovery: { commandId: "replace-known-file-recover", exactFoundationVersion: "0.21.0", exactFoundationBuildIdentity: installedBuildIdentity },
    diagnostics: [{ code: "FOUNDATION_TRANSACTION_ACTIVE", message: "unproven historical claim" }],
  };
  for (const recoveryArtifacts of [undefined, {
    schemaVersion: 5,
    ownerArtifact: { name: "@agent-teams/repository-mutation", version: status.foundationVersion, buildIdentity: installedBuildIdentity },
    kernelArtifact: { name: "@agent-teams/repository-mutation", version: status.foundationVersion, buildIdentity: installedBuildIdentity },
  }]) {
    await assert.rejects(coordinatorWith({ ...status, recoveryArtifacts }).coordinator.acquire({
      requestedMutation: "known-file-transaction", allowRecoveryOf: "known-file-transaction",
    }), (error) => error instanceof FoundationTransactionError);
  }
});

test("current wire6 known-file owner and kernel retain recovery under the actual Foundation lease", { skip: process.platform === "win32" }, async () => {
  const artifact = { name: "@agent-teams/repository-mutation", version: await installedRepositoryMutationVersion(), buildIdentity: await installedRepositoryMutationBuildIdentity() };
  for (const [phase, expected] of [["after-operation-published", "rolled-back"], ["after-journal-committed", "applied"]]) {
    const root = await createRoot();
    try {
      await writeFile(join(root, "existing.txt"), "old\n", { mode: 0o644 });
      const plan = compileKnownFileTransactionPlan({ operations: [{
        path: "existing.txt", precondition: { state: "known-file", acceptedPreimages: [{ bytes: Buffer.from("old\n"), mode: 0o644 }] },
        postimage: { bytes: Buffer.from("new\n"), mode: 0o644 },
      }] });
      await assert.rejects(applyKnownFileTransaction({ consumerRoot: root, plan,
        faultInjector(point) { if (point.phase === phase) { throw new Error("retained interrupt"); } },
      }), /retained interrupt/u);
      const coordinator = await createNodeFoundationTransactionCoordinator(root);
      const status = await coordinator.inspect();
      assert.equal(status.state, "pending");
      assert.equal(status.recoveryArtifacts.schemaVersion, 6);
      assert.deepEqual(status.recoveryArtifacts.ownerArtifact, artifact);
      assert.deepEqual(status.recoveryArtifacts.kernelArtifact, artifact);
      assert.match(status.diagnostics[0].message, /@agent-teams\/repository-mutation/u);
      const lease = await coordinator.acquire({ requestedMutation: "known-file-transaction", allowRecoveryOf: "known-file-transaction" });
      await lease.release({ retainTransactionBarrier: true });
      const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
      assert.equal(recovered.outcome, expected);
      assert.equal(await readFile(join(root, "existing.txt"), "utf8"), expected === "applied" ? "new\n" : "old\n");
    } finally { await rm(root, { force: true, recursive: true }); }
  }
});

test("schema6 known-file admission rejects each foreign or rebuilt owner and kernel", async (context) => {
  const artifact = { name: "@agent-teams/repository-mutation", version: await installedRepositoryMutationVersion(), buildIdentity: await installedRepositoryMutationBuildIdentity() };
  const plan = compileKnownFileTransactionPlan({ operations: [{ path: "result.txt", precondition: { state: "absent" }, postimage: { bytes: Buffer.from("ok\n") } }] });
  const input = { operationKind: "known-file-transaction", recoveryHandler: { id: "agent-teams.repository-mutation.known-file/v1", contractVersion: 1 },
    ownerArtifact: artifact, kernelArtifact: artifact, adapterContractVersion: 1, payloadKind: "agent-teams.repository-mutation.known-file-journal/v1", state: "APPLYING",
    payload: { schemaVersion: 1, plan, authorizedDirectories: [], createdDirectories: [], operations: [{ path: "result.txt", state: "pending" }] },
  };
  for (const key of ["ownerArtifact", "kernelArtifact"]) {
    for (const [field, value] of [["name", "@agent-teams/engineering-foundation"], ["version", "99.0.0"], ["version", "0.0.1"], ["buildIdentity", `sha256:${"b".repeat(64)}`]]) {
      await context.test(`${key}.${field}=${value}`, async () => {
        const root = await createRoot();
        try {
          const envelope = compileRepositoryMutationEnvelope({ ...input, [key]: { ...artifact, [field]: value } });
          await assertHistoricalBarrier(root, Buffer.from(JSON.stringify(envelope)), { installedVersion: artifact.version, installedBuildIdentity: artifact.buildIdentity });
        } finally { await rm(root, { force: true, recursive: true }); }
      });
    }
  }
});

test("public Foundation attach, detach, scaffold apply and recover preserve foreign slots", async () => {
  const service = new FoundationLocalModeService({ runner: { async run() { throw new Error("foreign evidence must block process execution"); } } });
  for (const name of ["fabricated-v5.json", "old-document-envelope-v1.json", "old-document-envelope-v2.json", "current-document-envelope-v1.json", "current-document-envelope-v2.json"]) {
    const root = await createRoot();
    try {
      await cp(scaffoldFixtureRoot, root, { recursive: true });
      const manifestPath = join(root, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.devDependencies = { ...manifest.devDependencies, "@agent-teams/engineering-foundation": "0.21.0" };
      await writeJson(manifestPath, manifest);
      const plan = await planScaffoldFromFile({ consumerRoot: root, intentPath: "intents/create-fixture.yaml" });
      const source = await historicalFixture(name); await mkdir(dirname(slotPath(root)), { recursive: true }); await writeFile(slotPath(root), source);
      await assert.rejects(service.attach(root, "unreached-target"), (error) => error instanceof FoundationTransactionError);
      await assert.rejects(service.detach(root), (error) => error instanceof FoundationTransactionError);
      await assert.rejects(applyFilesystemScaffold(root, plan), (error) => error?.code === "SCAFFOLD_RECOVERY_REQUIRED");
      await assert.rejects(recoverFilesystemScaffold(root), (error) => error?.code === "SCAFFOLD_RECOVERY_REQUIRED");
      assert.deepEqual(await readFile(slotPath(root)), source);
      for (const operation of plan.operations) { assert.deepEqual(await observeEvidence(join(root, operation.path)), { exists: false }); }
    } finally { await rm(root, { force: true, recursive: true }); }
  }
});

test("document mixed compiler/handler pairs and invalid payloads never select a recovery owner", async (context) => {
  for (const name of ["old-document-envelope-v1.json", "old-document-envelope-v2.json", "current-document-envelope-v1.json", "current-document-envelope-v2.json"]) {
    const native = JSON.parse(await historicalFixture(name));
    for (const field of ["compiler", "handler", "payload", "operation", "journal", "unknown", "kernel"]) {
      await context.test(`${name}: ${field}`, async () => {
        const root = await createRoot();
        try {
          const value = structuredClone(native);
          if (field === "compiler") { value.journal.plan.compiler.id = name.startsWith("old") ? "@agent-teams/document-authoring" : "@agent-teams/engineering-foundation"; value.journal.plan.planDigest = documentPlanDigest(value.journal.plan); }
          if (field === "handler") { value.recoveryHandler.id = name.startsWith("old") ? "document-authoring" : "foundation.document-authoring"; }
          if (field === "payload") { value.payloadKind = "unknown"; }
          if (field === "operation") { value.operationKind = "known-file-transaction"; }
          if (field === "journal") { value.journal.schemaVersion = 99; }
          if (field === "unknown") { value.unknown = true; }
          if (field === "kernel") { value.kernelArtifact = { name: "@agent-teams/repository-mutation", version: "0.0.0", buildIdentity: `sha256:${"c".repeat(64)}` }; }
          const status = await assertHistoricalBarrier(root, Buffer.from(JSON.stringify(rehashEnvelope(value))), {
            installedVersion: value.foundation.version, installedBuildIdentity: value.foundation.buildIdentity,
          });
          if (["compiler", "handler"].includes(field)) { assert.match(status.diagnostics[0].message, /mixed, missing, or unknown/u); }
          assert.equal(status.foundationVersion, undefined);
        } finally { await rm(root, { force: true, recursive: true }); }
      });
    }
  }
});

test("nonregular slot evidence blocks the real coordinator and survives every rejected lease", async () => {
  const root = await createRoot();
  try {
    await mkdir(slotPath(root), { recursive: true });
    const coordinator = await createNodeFoundationTransactionCoordinator(root);
    assert.equal((await coordinator.inspect()).state, "manual-recovery-required");
    for (const requestedMutation of ["attach", "detach", "scaffolding", "document-authoring", "known-file-transaction"]) {
      await assert.rejects(coordinator.acquire({ requestedMutation, allowRecoveryOf: requestedMutation }), (error) => error.status?.state === "manual-recovery-required");
    }
    assert.equal((await lstat(slotPath(root))).isDirectory(), true);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("a native old impossible Plan preserves journal bytes and both partial effects", async () => {
  const root = await createRoot();
  try {
    const source = await historicalFixture("native-impossible-partial.json");
    const native = JSON.parse(source);
    assert.deepEqual(native.journal.plan.operations.map(({ path }) => path), ["managed", "managed-other", "managed/child.txt"]);
    for (const path of ["managed", "managed-other"]) { await writeFile(join(root, path), "native old effect\n"); }
    await assertHistoricalBarrier(root, source, { installedVersion: native.foundation.version, installedBuildIdentity: native.foundation.buildIdentity });
    for (const path of ["managed", "managed-other"]) { assert.equal(await readFile(join(root, path), "utf8"), "native old effect\n"); }
  } finally { await rm(root, { force: true, recursive: true }); }
});
