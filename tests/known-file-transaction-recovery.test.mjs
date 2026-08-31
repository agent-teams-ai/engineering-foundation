import assert from "node:assert/strict";
import { link, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, compileKnownFileTransactionPlan, inspectKnownFileTransactionBarrier } from "../packages/repository-mutation/dist/index.js";
import { applyKnownFileTransaction, recoverKnownFileTransaction } from "../packages/repository-mutation/dist/qualification/index.js";
import { compileKnownFileTransactionEnvelope } from "../packages/repository-mutation/dist/repository-mutation/application/policies/known-file-transaction-envelope.js";
import { fixture, killAtCheckpoint, plan, posixTest, replacementPlan } from "./support/known-file-transaction-node-fixtures.mjs";

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
    assert.equal(recovered.outcome, expectedOutcome);
    assert.equal(
      await readFile(join(root, "managed", "existing.txt"), "utf8"),
      expectedOutcome === "applied" ? "new\n" : "old\n"
    );
    assert.equal((await stat(join(root, "managed", "existing.txt"))).nlink, 1);
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

posixTest("recovery requires the exact owner and kernel builds before touching files", async (context) => {
  const root = await fixture(context);
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: replacementPlan(),
    faultInjector(point) {
      if (point.phase === "after-temporary-synced") {throw new Error("apply-crash");}
    }
  }), /apply-crash/u);
  const journalPath = join(root, ".agent-teams-local", "scaffolding-transaction.json");
  const envelope = JSON.parse(await readFile(journalPath, "utf8"));
  const foreignBuild = compileKnownFileTransactionEnvelope({
    ownerArtifact: {
      ...envelope.ownerArtifact,
      buildIdentity: `sha256:${"0".repeat(64)}`
    },
    kernelArtifact: envelope.kernelArtifact,
    journal: envelope.payload,
    state: envelope.state
  });
  await writeFile(journalPath, `${canonicalJson(foreignBuild)}\n`, "utf8");
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    /exact owner and kernel artifacts/u
  );
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
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
