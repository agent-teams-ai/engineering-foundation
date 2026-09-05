import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  assertKnownFileTransactionEnvelope, canonicalJson, compileKnownFileTransactionPlan,
  compileRepositoryMutationEnvelope, inspectKnownFileTransactionBarrier,
  installedRepositoryMutationBuildIdentity, installedRepositoryMutationVersion
} from "../packages/repository-mutation/dist/index.js";
import { applyKnownFileTransaction, recoverKnownFileTransaction } from "../packages/repository-mutation/dist/qualification/index.js";
import { compileKnownFileTransactionEnvelope } from "../packages/repository-mutation/dist/repository-mutation/application/policies/known-file-transaction-envelope.js";
import { fixture, killAtCheckpoint, plan, posixTest, replacementPlan, temporaryDirectory } from "./support/known-file-transaction-node-fixtures.mjs";
import { assertKnownFileSchemaIdentity, readHistoricalKnownFileFixture } from "./support/known-file-transaction-schema-fixtures.mjs";

async function persistedTree(root, ignoreOperationLock = true) {
  const entries = [];
  for (const path of (await readdir(root, { recursive: true })).toSorted()) {
    // A refused recovery may retain/update its cooperative lock barrier. All
    // journal, temporary, destination and directory identities must survive.
    if (ignoreOperationLock && path === join(".agent-teams-local", "foundation-operation.lock")) {continue;}
    const full = join(root, path);
    const metadata = await stat(full, { bigint: true });
    entries.push({ path, dev: metadata.dev, ino: metadata.ino, birthtimeNs: metadata.birthtimeNs,
      mode: metadata.mode,
      // APFS counts the intentionally retained lock file in its parent's links.
      // Keep every journal/file link count and every directory identity exact.
      nlink: ignoreOperationLock && path === ".agent-teams-local" ? undefined : metadata.nlink,
      bytes: metadata.isFile() ? await readFile(full) : undefined });
  }
  return entries;
}

async function assertManualOnly(root, expectedError) {
  const before = await persistedTree(root);
  const inspection = await inspectKnownFileTransactionBarrier({ consumerRoot: root });
  assert.equal(inspection.state, "recovery-required");
  assert.equal(inspection.recoverableByInstalledBuild, false);
  await assert.rejects(recoverKnownFileTransaction({ consumerRoot: root }), expectedError);
  await assert.rejects(applyKnownFileTransaction({ consumerRoot: root, plan: replacementPlan() }), /recover/u);
  assert.deepEqual(await persistedTree(root), before);
  const after = await inspectKnownFileTransactionBarrier({ consumerRoot: root });
  assert.equal(after.state, "recovery-required");
  assert.equal(after.recoverableByInstalledBuild, false);
}

for (const state of ["APPLYING", "COMMITTED"]) {
  posixTest(`current ${state} create/replace recovery emits only current schema receipts`, async (context) => {
    const root = await fixture(context);
    await assert.rejects(applyKnownFileTransaction({ consumerRoot: root, plan: plan(),
      faultInjector(point) {
        if (state === "APPLYING"
          ? point.phase === "after-operation-published" && point.operationIndex === 1
          : point.phase === "after-journal-committed") {throw new Error("schema-recovery-stop");}
      }
    }), /schema-recovery-stop/u);
    const envelope = JSON.parse(await readFile(join(root, ".agent-teams-local", "scaffolding-transaction.json")));
    assert.equal(envelope.schemaVersion, 6);
    assert.equal(envelope.format, "agent-teams.repository-mutation.transaction-envelope/v1");
    assert.equal(envelope.state, state);
    assertKnownFileTransactionEnvelope(envelope);
    await assertKnownFileSchemaIdentity("plan", envelope.payload.plan);
    const installed = { name: "@agent-teams/repository-mutation",
      version: await installedRepositoryMutationVersion(),
      buildIdentity: await installedRepositoryMutationBuildIdentity() };
    assert.deepEqual(envelope.ownerArtifact, installed);
    assert.deepEqual(envelope.kernelArtifact, installed);
    const receipt = await recoverKnownFileTransaction({ consumerRoot: root });
    await assertKnownFileSchemaIdentity("receipt", receipt);
    assert.deepEqual(receipt.operations.map((operation) => operation.outcome), state === "APPLYING"
      ? ["rolled-back-to-preimage", "rolled-back-to-absent"] : ["replaced", "created"]);
    assert.equal((await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state, "idle");
    await assert.rejects(readFile(join(root, ".agent-teams-local", "scaffolding-transaction.json")), /ENOENT/u);
    const replay = await applyKnownFileTransaction({ consumerRoot: root, plan: plan() });
    await assertKnownFileSchemaIdentity("receipt", replay);
    assert.equal(replay.outcome, state === "APPLYING" ? "applied" : "already-satisfied");
  });
}

for (const [checkpoint, expectedOutcome] of [
  ["after-rollback-temporary-ready", "rolled-back"],
  ["after-preimage-captured", "rolled-back"],
  ["after-postimage-linked", "rolled-back"],
  ["after-committed-capture-unlinked", "applied"]
]) {
  posixTest(`SIGKILL recovery is exact at ${checkpoint}`, async (context) => {
    const root = await fixture(context);
    await killAtCheckpoint(root, checkpoint);
    const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
    await assertKnownFileSchemaIdentity("receipt", recovered);
    assert.equal(recovered.outcome, expectedOutcome);
    assert.equal(
      await readFile(join(root, "managed", "existing.txt"), "utf8"),
      expectedOutcome === "applied" ? "new\n" : "old\n"
    );
    assert.equal((await stat(join(root, "managed", "existing.txt"))).nlink, 1);
    assert.equal((await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state, "idle");
    const replay = { consumerRoot: root, plan: replacementPlan() };
    assert.equal((await applyKnownFileTransaction(replay)).outcome,
      expectedOutcome === "applied" ? "already-satisfied" : "applied");
    assert.equal((await applyKnownFileTransaction(replay)).outcome, "already-satisfied");
  });
}
for (const [checkpoint, expectedContent, expectedOutcome] of [
  ["after-barrier-acquired", "old\n", "applied"],
  ["after-journal-retired", "new\n", "already-satisfied"]
]) {
  posixTest(`dead lock residue is safely taken over after SIGKILL at ${checkpoint}`, async (context) => {
    const root = await fixture(context);
    await killAtCheckpoint(root, checkpoint);
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), expectedContent);
    const result = await applyKnownFileTransaction({
      consumerRoot: root,
      plan: replacementPlan()
    });
    assert.equal(result.outcome, expectedOutcome);
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "new\n");
    assert.equal((await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state, "idle");
  });
}

posixTest("recovery preserves ordered provenance when recovery and release both fail", async (context) => {
  const root = await fixture(context);
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: replacementPlan(),
    faultInjector(point) {
      if (point.phase === "after-operation-published") {throw new Error("apply crash");}
    },
  }), /apply crash/u);
  const primaryFailure = new Error("recovery primary failure");
  await assert.rejects(recoverKnownFileTransaction({
    consumerRoot: root,
    async faultInjector(point) {
      if (point.phase !== "after-destination-retired") {return;}
      await writeFile(
        join(root, ".agent-teams-local", "foundation-operation.lock"),
        "invalid release evidence\n",
        "utf8",
      );
      throw primaryFailure;
    },
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "Known-file recovery and transaction lease release both failed.");
    assert.equal(error.errors[0], primaryFailure);
    assert.equal(error.errors[1]?.code, "MUTATION_LEASE_INVALID");
    assert.equal(error.cause, primaryFailure);
    return true;
  });
  assert.ok(await stat(join(
    root,
    ".agent-teams-local",
    "scaffolding-transaction.json",
  )));
});

posixTest("failed recovery release surfaces without pruning recovery state", async (context) => {
  const root = await fixture(context);
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: replacementPlan(),
    faultInjector(point) {
      if (point.phase === "after-operation-published") {throw new Error("apply crash");}
    },
  }), /apply crash/u);
  const state = join(root, ".agent-teams-local");
  await assert.rejects(recoverKnownFileTransaction({
    consumerRoot: root,
    async faultInjector(point) {
      if (point.phase === "after-rollback-linked") {
        await writeFile(
          join(state, "foundation-operation.lock"),
          "invalid release evidence\n",
          "utf8",
        );
      }
    },
  }), (error) => error?.code === "MUTATION_LEASE_INVALID");
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
  await assert.rejects(
    stat(join(state, "scaffolding-transaction.json")),
    (error) => error?.code === "ENOENT",
  );
  assert.equal(
    await readFile(join(state, "foundation-operation.lock"), "utf8"),
    "invalid release evidence\n",
  );
});

posixTest("rollback verifies already-satisfied guards before returning a receipt", async (context) => {
  const root = await fixture(context);
  await writeFile(join(root, "managed", "new.txt"), "created\n", { mode: 0o644 });
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: plan(),
    faultInjector(point) {
      if (point.phase === "after-operation-published" && point.operationIndex === 0) {
        throw new Error("apply-crash");
      }
    }
  }), /apply-crash/u);
  await writeFile(join(root, "managed", "new.txt"), "guard-drift\n", { mode: 0o644 });
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT"
  );
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
  assert.equal(await readFile(join(root, "managed", "new.txt"), "utf8"), "guard-drift\n");
});

posixTest("journal policy rejects created and authorized paths outside operation parents", async (context) => {
  const root = await fixture(context);
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: replacementPlan(),
    faultInjector(point) {
      if (point.phase === "after-journal-created") {throw new Error("journal-crash");}
    }
  }), /journal-crash/u);
  const envelope = JSON.parse(await readFile(
    join(root, ".agent-teams-local", "scaffolding-transaction.json"),
    "utf8"
  ));
  for (const journal of [
    {
      ...envelope.payload,
      createdDirectories: [{
        path: "../outside",
        identity: { birthtimeNs: "1", dev: "1", ino: "1" }
      }]
    },
    { ...envelope.payload, authorizedDirectories: ["unrelated"] }
  ]) {
    assert.throws(() => compileKnownFileTransactionEnvelope({
      ownerArtifact: envelope.ownerArtifact,
      kernelArtifact: envelope.kernelArtifact,
      journal,
      state: "APPLYING"
    }), /created directory|authorized-directory/u);
  }
});

for (const state of ["APPLYING", "COMMITTED"]) {
for (const artifact of ["ownerArtifact", "kernelArtifact"]) {
for (const [field, foreign] of [
  ["name", "@example/foreign-owner"],
  ["version", "99.0.0"],
  ["buildIdentity", `sha256:${"0".repeat(64)}`]
]) {
posixTest(`${state} recovery refuses mismatched ${artifact}.${field} and preserves partial effects`, async (context) => {
  const root = await fixture(context);
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: replacementPlan(),
    faultInjector(point) {
      if (point.phase === (state === "APPLYING" ? "after-operation-published" : "after-journal-committed")) {
        throw new Error("apply-crash");
      }
    }
  }), /apply-crash/u);
  const journalPath = join(root, ".agent-teams-local", "scaffolding-transaction.json");
  const envelope = JSON.parse(await readFile(journalPath, "utf8"));
  await assertKnownFileSchemaIdentity("plan", envelope.payload.plan);
  const foreignBuild = compileKnownFileTransactionEnvelope({
    ownerArtifact: envelope.ownerArtifact,
    kernelArtifact: envelope.kernelArtifact,
    [artifact]: { ...envelope[artifact], [field]: foreign },
    journal: envelope.payload,
    state: envelope.state
  });
  await writeFile(journalPath, `${canonicalJson(foreignBuild)}\n`, "utf8");
  await assertManualOnly(root, /exact owner and kernel artifacts/u);
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "new\n");
});
}
}
}

for (const [name, destination] of [
  ["after-operation-published", "managed/result.txt"],
  ["after-journal-committed", "managed/result.txt"],
  ["impossible-applying-envelope", "managed"]
]) {
  posixTest(`preserves native Foundation 0.21.0 ${name} bytes and partial output`, async (context) => {
    const root = await temporaryDirectory(context, "mutation-frozen-foundation-");
    const historical = await readHistoricalKnownFileFixture(name);
    assert.equal(historical.value.schemaVersion, 5);
    await assertKnownFileSchemaIdentity("plan", historical.value.journal.plan, "historical");
    assert.throws(() => assertKnownFileTransactionEnvelope(historical.value), /envelope/u);
    await mkdir(join(root, ".agent-teams-local"));
    if (destination.includes("/")) {await mkdir(join(root, "managed"));}
    await writeFile(join(root, destination), "created\n", { mode: 0o644 });
    const journalPath = join(root, ".agent-teams-local", "scaffolding-transaction.json");
    await writeFile(journalPath, historical.bytes);
    // Recreated physical identities confer no recovery authority. Only the
    // native exact artifact can assess a historical journal; impossible Plans
    // remain manual even when partial published output is present.
    await assertManualOnly(root, /envelope/u);
    assert.deepEqual(await readFile(journalPath), historical.bytes);
    assert.equal(await readFile(join(root, destination), "utf8"), "created\n");
    assert.deepEqual((await readHistoricalKnownFileFixture(name)).bytes, historical.bytes);
  });
}

posixTest("rejects a base impossible Plan before journal or filesystem effects", async (context) => {
  const root = await fixture(context);
  const envelope = JSON.parse(await readFile(new URL(
    "./fixtures/repository-mutation-known-file/base-impossible-applying-envelope.json",
    import.meta.url
  ), "utf8"));
  const before = await persistedTree(root, false);
  const operations = envelope.payload.plan.operations;
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    for (const ancestor of ["managed", "MANAGED"]) {
      await assert.rejects(applyKnownFileTransaction({ consumerRoot: root, plan: {
        ...envelope.payload.plan,
        operations: order.map((index) => index === 0 ? { ...operations[index], path: ancestor } : operations[index])
      } }), /ancestor and descendant/u);
      assert.deepEqual(await persistedTree(root, false), before);
    }
  }
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
});

for (const [label, fixtureName] of [
  ["impossible historical", "base-impossible-applying-envelope.json"],
  ["foreign exact-version", "base-valid-applying-envelope.json"]
]) {
  posixTest(`preserves ${label} journal bytes as manual-only evidence`, async (context) => {
    const root = await fixture(context);
    const state = join(root, ".agent-teams-local");
    const path = join(state, "scaffolding-transaction.json");
    const source = await readFile(new URL(
      `./fixtures/repository-mutation-known-file/${fixtureName}`,
      import.meta.url
    ));
    await mkdir(state);
    await writeFile(path, source);
    const inspection = await inspectKnownFileTransactionBarrier({ consumerRoot: root });
    assert.deepEqual(inspection, {
      state: "recovery-required",
      code: "KNOWN_FILE_RECOVERY_REQUIRED",
      recoverableByInstalledBuild: false,
      message: "Unknown, legacy, corrupt, or ambiguous common transaction evidence must be recovered by its exact owner artifact."
    });
    assert.deepEqual(await readFile(path), source);
    await assertManualOnly(root, /exact owner and kernel/u);
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
  });
}

posixTest("preserves unknown journal bytes as manual-only evidence", async (context) => {
  const root = await fixture(context);
  const state = join(root, ".agent-teams-local");
  const path = join(state, "scaffolding-transaction.json");
  const source = Buffer.from('{"schemaVersion":999,"unknown":true}\n');
  await mkdir(state);
  await writeFile(path, source);
  const inspection = await inspectKnownFileTransactionBarrier({ consumerRoot: root });
  assert.equal(inspection.state, "recovery-required");
  assert.equal(inspection.recoverableByInstalledBuild, false);
  assert.deepEqual(await readFile(path), source);
  await assertManualOnly(root, /envelope|schemaVersion/u);
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
});

posixTest("an exact installed identity cannot authorize an impossible historical payload", async (context) => {
  const root = await fixture(context);
  const original = JSON.parse(await readFile(new URL(
    "./fixtures/repository-mutation-known-file/base-impossible-applying-envelope.json", import.meta.url
  ), "utf8"));
  const artifact = { name: "@agent-teams/repository-mutation",
    version: await installedRepositoryMutationVersion(),
    buildIdentity: await installedRepositoryMutationBuildIdentity() };
  // Bind the immutable old payload through the generic envelope compiler, so
  // the test reaches Plan admission instead of stopping at artifact mismatch.
  const envelope = compileRepositoryMutationEnvelope({
    operationKind: original.operationKind, recoveryHandler: original.recoveryHandler,
    ownerArtifact: artifact, kernelArtifact: artifact,
    adapterContractVersion: original.adapterContractVersion, payloadKind: original.payloadKind,
    state: original.state, payload: original.payload
  });
  assert.throws(() => assertKnownFileTransactionEnvelope(envelope), /ancestor and descendant/u);
  await mkdir(join(root, ".agent-teams-local"));
  await writeFile(join(root, ".agent-teams-local", "scaffolding-transaction.json"), `${canonicalJson(envelope)}\n`);
  await assertManualOnly(root, /ancestor and descendant/u);
});

for (const kind of ["unknown-handler", "unknown-payload", "impossible-lifecycle", "corrupt-digest", "legacy-v2", "unknown-envelope-field", "unknown-plan-field", "unknown-plan-version"]) {
  posixTest(`preserves ${kind} journal and published bytes when recovery is attempted`, async (context) => {
    const root = await fixture(context);
    await assert.rejects(applyKnownFileTransaction({ consumerRoot: root, plan: replacementPlan(),
      faultInjector(point) {
        if (point.phase === "after-operation-published") {throw new Error("seed-evidence");}
      }
    }), /seed-evidence/u);
    const journalPath = join(root, ".agent-teams-local", "scaffolding-transaction.json");
    const envelope = JSON.parse(await readFile(journalPath, "utf8"));
    const body = {
      operationKind: envelope.operationKind, recoveryHandler: envelope.recoveryHandler,
      ownerArtifact: envelope.ownerArtifact, kernelArtifact: envelope.kernelArtifact,
      adapterContractVersion: envelope.adapterContractVersion, payloadKind: envelope.payloadKind,
      state: envelope.state, payload: envelope.payload
    };
    if (kind === "unknown-handler") {body.recoveryHandler = { id: "future-handler", contractVersion: 99 };}
    if (kind === "unknown-payload") {body.payloadKind = "future-journal/v2";}
    if (kind === "impossible-lifecycle") {body.payload.operations[0].state = "pending";}
    if (kind === "unknown-plan-field") {body.payload.plan.unknown = true;}
    if (kind === "unknown-plan-version") {body.payload.plan.schemaVersion = 2;}
    const altered = { ...compileRepositoryMutationEnvelope(body) };
    if (kind === "corrupt-digest") {altered.envelopeDigest = `sha256:${"0".repeat(64)}`;}
    if (kind === "legacy-v2") {altered.schemaVersion = 2;}
    if (kind === "unknown-envelope-field") {altered.unknown = true;}
    await writeFile(journalPath, `${canonicalJson(altered)}\n`);
    await assertManualOnly(root, /envelope|journal|schemaVersion|Plan/u);
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "new\n");
  });
}

test("Windows refusal precedes root observation for both public and qualification APIs (branch emulation)", async (context) => {
  const root = await fixture(context);
  const before = await persistedTree(root, false);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import * as api from ${JSON.stringify(new URL("../packages/repository-mutation/dist/index.js", import.meta.url).href)};
    import * as qualification from ${JSON.stringify(new URL("../packages/repository-mutation/dist/qualification/index.js", import.meta.url).href)};
    Object.defineProperty(process, "platform", { value: "win32" });
    const plan = api.compileKnownFileTransactionPlan({ operations: [{ path: "new.txt",
      precondition: { state: "absent" }, postimage: { bytes: Buffer.from("new") } }] });
    for (const caller of [api, qualification]) {
      for (const consumerRoot of [process.argv[1], process.argv[1] + "/missing"]) {
        for (const action of ["applyKnownFileTransaction", "recoverKnownFileTransaction"]) {
          const options = action === "applyKnownFileTransaction" ? { consumerRoot, plan } : { consumerRoot };
          await assert.rejects(caller[action](options), error =>
            error.code === "KNOWN_FILE_APPLY_UNSUPPORTED" && /not qualified on Windows/.test(error.message));
        }
      }
    }
  `, root], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stdout, "");
  assert.deepEqual(await persistedTree(root, false), before);
});

for (const phase of ["after-operation-publishing", "after-operation-published"]) {
  posixTest(`recovers an interrupted replacement at ${phase}`, async (context) => {
    const root = await fixture(context);
    await assert.rejects(
      applyKnownFileTransaction({
        consumerRoot: root,
        plan: compileKnownFileTransactionPlan({ operations: [plan().operations[0]].map((operation) => ({
          path: operation.path,
          precondition: {
            state: "known-file",
            acceptedPreimages: operation.precondition.acceptedPreimages.map((image) => ({
              bytes: Buffer.from(image.contentBase64, "base64"),
              mode: image.mode
            }))
          },
          postimage: {
            bytes: Buffer.from(operation.postimage.contentBase64, "base64"),
            mode: operation.postimage.mode
          }
        })) }),
        faultInjector(point) {
          if (point.phase === phase) {throw new Error("simulated crash");}
        }
      }),
      /simulated crash/u
    );
    const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
    assert.equal(recovered.outcome, "rolled-back");
    assert.equal(recovered.operations[0].outcome, "rolled-back-to-preimage");
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
  });
}

posixTest("preserves an unbound rollback temporary after its creation window", async (context) => {
  const root = await fixture(context);
  const single = compileKnownFileTransactionPlan({ operations: [{
    path: "managed/existing.txt",
    precondition: {
      state: "known-file",
      acceptedPreimages: [{ bytes: Buffer.from("old\n"), mode: 0o640 }]
    },
    postimage: { bytes: Buffer.from("new\n"), mode: 0o640 }
  }] });
  await assert.rejects(
    applyKnownFileTransaction({
      consumerRoot: root,
      plan: single,
      faultInjector(point) {
        if (point.phase === "after-rollback-temporary-created-unbound") {
          throw new Error("simulated crash");
        }
      }
    }),
    /simulated crash/u
  );
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT"
  );
  assert.equal(
    await readFile(join(root, "managed", ".existing.txt.agent-teams.rollback.0.tmp"), "utf8"),
    "old\n"
  );
});

for (const phase of [
  "after-destination-retired",
  "after-rollback-linked",
  "after-rollback-capture-unlinked"
]) {
  posixTest(`resumes rollback after a crash at ${phase}`, async (context) => {
    const root = await fixture(context);
    const single = compileKnownFileTransactionPlan({ operations: [{
      path: "managed/existing.txt",
      precondition: {
        state: "known-file",
        acceptedPreimages: [{ bytes: Buffer.from("old\n"), mode: 0o640 }]
      },
      postimage: { bytes: Buffer.from("new\n"), mode: 0o640 }
    }] });
    await assert.rejects(applyKnownFileTransaction({
      consumerRoot: root,
      plan: single,
      faultInjector(point) {
        if (point.phase === "after-operation-published") {throw new Error("apply crash");}
      }
    }), /apply crash/u);
    await assert.rejects(recoverKnownFileTransaction({
      consumerRoot: root,
      faultInjector(point) {
        if (point.phase === phase) {throw new Error("recovery crash");}
      }
    }), /recovery crash/u);
    const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
    assert.equal(recovered.outcome, "rolled-back");
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
    assert.equal((await stat(join(root, "managed", "existing.txt"))).nlink, 1);
    assert.equal(
      (await applyKnownFileTransaction({ consumerRoot: root, plan: single })).outcome,
      "applied"
    );
  });
}

posixTest("preserves a destination that appears before rollback publication", async (context) => {
  const root = await fixture(context);
  const single = compileKnownFileTransactionPlan({ operations: [plan().operations[0]].map((operation) => ({
    path: operation.path,
    precondition: {
      state: "known-file",
      acceptedPreimages: operation.precondition.acceptedPreimages.map((image) => ({
        bytes: Buffer.from(image.contentBase64, "base64"), mode: image.mode
      }))
    },
    postimage: { bytes: Buffer.from(operation.postimage.contentBase64, "base64"), mode: operation.postimage.mode }
  })) });
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: single,
    faultInjector(point) {
      if (point.phase === "after-operation-published") {throw new Error("apply crash");}
    }
  }), /apply crash/u);
  await assert.rejects(
    recoverKnownFileTransaction({
      consumerRoot: root,
      async faultInjector(point) {
        if (point.phase === "after-destination-retired") {
          await writeFile(join(root, "managed", "existing.txt"), "foreign\n", { mode: 0o640 });
        }
      }
    }),
    (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT"
  );
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "foreign\n");
});

posixTest("preserves an exact-content foreign temporary when its identity changed", async (context) => {
  const root = await fixture(context);
  const single = compileKnownFileTransactionPlan({ operations: [plan().operations[0]].map((operation) => ({
    path: operation.path,
    precondition: {
      state: "known-file",
      acceptedPreimages: operation.precondition.acceptedPreimages.map((image) => ({
        bytes: Buffer.from(image.contentBase64, "base64"),
        mode: image.mode
      }))
    },
    postimage: {
      bytes: Buffer.from(operation.postimage.contentBase64, "base64"),
      mode: operation.postimage.mode
    }
  })) });
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: single,
    faultInjector(point) {
      if (point.phase === "after-temporary-synced") {throw new Error("simulated crash");}
    }
  }), /simulated crash/u);
  const files = await readdir(join(root, "managed"));
  const temporary = files.find((name) =>
    name.startsWith(".existing.txt.agent-teams.") && name.endsWith(".tmp")
  );
  assert.ok(temporary);
  const temporaryPath = join(root, "managed", temporary);
  await rename(temporaryPath, `${temporaryPath}.original`);
  await writeFile(temporaryPath, "new\n", { mode: 0o640 });
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT"
  );
  assert.equal(await readFile(temporaryPath, "utf8"), "new\n");
});

posixTest("rejects hard-linked destinations before mutation", async (context) => {
  const root = await fixture(context);
  await link(
    join(root, "managed", "existing.txt"),
    join(root, "managed", "existing-hardlink.txt")
  );
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: root, plan: plan() }),
    (error) => error?.code === "KNOWN_FILE_HARDLINK"
  );
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
});

posixTest("finishes retirement of a committed transaction without rolling it back", async (context) => {
  const root = await fixture(context);
  await assert.rejects(
    applyKnownFileTransaction({
      consumerRoot: root,
      plan: plan(),
      faultInjector(point) {
        if (point.phase === "after-journal-committed") {throw new Error("simulated crash");}
      }
    }),
    /simulated crash/u
  );
  const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
  assert.equal(recovered.outcome, "applied");
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "new\n");
  assert.equal(await readFile(join(root, "managed", "new.txt"), "utf8"), "created\n");
});

posixTest("committed recovery verifies unchanged guard operations too", async (context) => {
  const root = await fixture(context);
  await writeFile(join(root, "managed", "new.txt"), "created\n", { mode: 0o644 });
  await assert.rejects(
    applyKnownFileTransaction({
      consumerRoot: root,
      plan: plan(),
      faultInjector(point) {
        if (point.phase === "after-journal-committed") {throw new Error("commit crash");}
      }
    }),
    /commit crash/u
  );
  await writeFile(join(root, "managed", "new.txt"), "guard drift\n", { mode: 0o644 });
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_COMMITTED_DRIFT"
  );
  assert.ok(await stat(join(root, ".agent-teams-local", "scaffolding-transaction.json")));
});

posixTest("never rolls back an exact third-party postimage replacement", async (context) => {
  const root = await fixture(context);
  const single = compileKnownFileTransactionPlan({ operations: [{
    path: "managed/existing.txt",
    precondition: {
      state: "known-file",
      acceptedPreimages: [{ bytes: Buffer.from("old\n"), mode: 0o640 }]
    },
    postimage: { bytes: Buffer.from("new\n"), mode: 0o640 }
  }] });
  await assert.rejects(
    applyKnownFileTransaction({
      consumerRoot: root,
      plan: single,
      faultInjector(point) {
        if (point.phase === "after-operation-published") {throw new Error("simulated crash");}
      }
    }),
    /simulated crash/u
  );
  const replacement = join(root, "managed", "replacement.tmp");
  await writeFile(replacement, "new\n", { mode: 0o640 });
  await rename(replacement, join(root, "managed", "existing.txt"));
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT"
  );
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "new\n");
  assert.ok(await stat(join(root, ".agent-teams-local", "scaffolding-transaction.json")));
});

posixTest("recovers from the canonical journal while preserving a torn transition candidate", async (context) => {
  const root = await fixture(context);
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: plan(),
    faultInjector(point) {
      if (point.phase === "after-operation-published" && point.operationIndex === 0) {
        throw new Error("apply crash");
      }
    }
  }), /apply crash/u);
  const torn = join(
    root,
    ".agent-teams-local",
    "scaffolding-transaction.json.known-file.tmp"
  );
  await writeFile(torn, "{\"schemaVersion\":5", "utf8");
  const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
  assert.equal(recovered.outcome, "rolled-back");
  await assert.rejects(readFile(torn, "utf8"), (error) => error?.code === "ENOENT");
  assert.equal((await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state, "idle");
  assert.equal(
    (await applyKnownFileTransaction({ consumerRoot: root, plan: plan() })).outcome,
    "applied"
  );
});

posixTest("canonical-absent torn journal candidate remains manual evidence", async (context) => {
  const root = await fixture(context);
  const state = join(root, ".agent-teams-local");
  await mkdir(state);
  const torn = join(state, "scaffolding-transaction.json.known-file.tmp");
  await writeFile(torn, "{\"schemaVersion\":5", "utf8");
  const barrier = await inspectKnownFileTransactionBarrier({ consumerRoot: root });
  assert.equal(barrier.state, "recovery-required");
  assert.equal(barrier.recoverableByInstalledBuild, false);
  await assert.rejects(recoverKnownFileTransaction({ consumerRoot: root }));
  assert.equal(await readFile(torn, "utf8"), "{\"schemaVersion\":5");
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
});

for (const [name, evidence] of [
  ["corrupt v5", { schemaVersion: 5 }],
  ["invalid schema version", { operationKind: "known-file-transaction" }]
]) {
  posixTest(`classifies ${name} transaction evidence for manual recovery`, async (context) => {
    const root = await fixture(context);
    const state = join(root, ".agent-teams-local");
    await mkdir(state);
    await writeFile(
      join(state, "scaffolding-transaction.json"),
      `${JSON.stringify(evidence)}\n`,
      "utf8"
    );
    const barrier = await inspectKnownFileTransactionBarrier({ consumerRoot: root });
    assert.equal(barrier.state, "recovery-required");
    assert.equal(barrier.recoverableByInstalledBuild, false);
  });
}
