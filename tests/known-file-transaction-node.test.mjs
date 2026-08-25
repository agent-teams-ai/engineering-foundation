import assert from "node:assert/strict";
import { link, mkdir, open, readFile, readdir, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyKnownFileTransaction, compileKnownFileTransactionPlan, inspectKnownFileTransactionBarrier, recoverKnownFileTransaction } from "../packages/engineering-foundation/dist/mutation/index.js";
import { releaseKnownFileTransactionLease } from "../packages/engineering-foundation/dist/repository-mutation/adapters/node/node-known-file-transaction-lease-release.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
import { fixture, killAtCheckpoint, plan, posixTest, replacementPlan, temporaryDirectory, windowsTest } from "./support/known-file-transaction-node-fixtures.mjs";

for (const checkpoint of [
  "after-retirement-directory-bound",
  "after-retirement-captured",
  "after-retirement-unlink-authorized"
]) {
  posixTest(`SIGKILL retirement replay leaves no residue at ${checkpoint}`, async (context) => {
    const root = await fixture(context);
    await killAtCheckpoint(root, "after-postimage-linked");
    await killAtCheckpoint(root, checkpoint, "recover");
    const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
    assert.equal(recovered.outcome, "rolled-back");
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
    assert.equal(
      (await readdir(join(root, "managed"))).some((entry) => entry.includes("agent-teams.retire")),
      false
    );
    const applied = await applyKnownFileTransaction({
      consumerRoot: root,
      plan: replacementPlan()
    });
    assert.equal(applied.outcome, "applied");
  });
}

posixTest("terminal and ancestor symlinks never redirect a known-file mutation", async (context) => {
  const root = await temporaryDirectory(context, "foundation-known-file-symlink-");
  const outside = await temporaryDirectory(context, "foundation-known-file-outside-");
  await mkdir(join(root, "managed"));
  await writeFile(join(outside, "target.txt"), "outside\n", { mode: 0o640 });
  await symlink(join(outside, "target.txt"), join(root, "managed", "existing.txt"));
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: root, plan: replacementPlan() }),
    /real regular file/u
  );
  assert.equal(await readFile(join(outside, "target.txt"), "utf8"), "outside\n");

  const ancestorRoot = await temporaryDirectory(context, "foundation-known-file-ancestor-");
  await symlink(outside, join(ancestorRoot, "managed"));
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: ancestorRoot, plan: replacementPlan() })
  );
  assert.equal(await readFile(join(outside, "target.txt"), "utf8"), "outside\n");
});

posixTest("runtime case aliases and non-portable Unicode aliases fail closed", async (context) => {
  const root = await temporaryDirectory(context, "foundation-known-file-alias-");
  await mkdir(join(root, "Managed"));
  const aliasPlan = compileKnownFileTransactionPlan({ operations: [{
    path: "managed/new.txt",
    precondition: { state: "absent" },
    postimage: { bytes: Buffer.from("new\n") }
  }] });
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: root, plan: aliasPlan }),
    /Portable case or Unicode path collision/u
  );
  assert.deepEqual(await readdir(join(root, "Managed")), []);
  assert.throws(() => compileKnownFileTransactionPlan({ operations: [{
    path: "ma\u006e\u0301aged/new.txt",
    precondition: { state: "absent" },
    postimage: { bytes: Buffer.from("new\n") }
  }] }), /not portable|NFC normalization/u);
});

posixTest("two concurrent applies admit one publisher and fail the live-lock contender closed", async (context) => {
  const root = await fixture(context);
  const attempts = await Promise.allSettled([
    applyKnownFileTransaction({ consumerRoot: root, plan: replacementPlan() }),
    applyKnownFileTransaction({ consumerRoot: root, plan: replacementPlan() })
  ]);
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(attempts.find(({ status }) => status === "fulfilled").value.outcome, "applied");
  assert.equal(attempts.find(({ status }) => status === "rejected").reason.code, "LOCAL_STATE_INVALID");
  const retry = await applyKnownFileTransaction({ consumerRoot: root, plan: replacementPlan() });
  assert.equal(retry.outcome, "already-satisfied");
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "new\n");
  assert.equal((await stat(join(root, "managed", "existing.txt"))).nlink, 1);
});

posixTest("exact BOM and CRLF bytes and non-default mode survive replacement", async (context) => {
  const root = await temporaryDirectory(context, "foundation-known-file-bytes-");
  await mkdir(join(root, "managed"));
  const destination = join(root, "managed", "existing.txt");
  const before = Buffer.from("\uFEFFold\r\n", "utf8");
  const after = Buffer.from("\uFEFFnew\r\n", "utf8");
  await writeFile(destination, before, { mode: 0o600 });
  const exactPlan = compileKnownFileTransactionPlan({ operations: [{
    path: "managed/existing.txt",
    precondition: { state: "known-file", acceptedPreimages: [{ bytes: before, mode: 0o600 }] },
    postimage: { bytes: after, mode: 0o600 }
  }] });
  await applyKnownFileTransaction({ consumerRoot: root, plan: exactPlan });
  assert.deepEqual(await readFile(destination), after);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
});

for (const code of ["EACCES", "ENOSPC"]) {
  posixTest(`${code} fault leaves a deterministically recoverable transaction`, async (context) => {
    const root = await fixture(context);
    await assert.rejects(applyKnownFileTransaction({
      consumerRoot: root,
      plan: replacementPlan(),
      faultInjector(point) {
        if (point.phase === "after-temporary-authorized") {
          throw Object.assign(new Error(`injected ${code}`), { code });
        }
      }
    }), (error) => error?.code === code);
    const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
    assert.equal(recovered.outcome, "rolled-back");
    const applied = await applyKnownFileTransaction({ consumerRoot: root, plan: replacementPlan() });
    assert.equal(applied.outcome, "applied");
  });
}

async function observePromise(promise) {
  return promise.then(
    (value) => ({ state: "fulfilled", value }),
    (reason) => ({ reason, state: "rejected" }),
  );
}

posixTest("lease release preserves arbitrary single and joint failures", async (context) => {
  const releaseObject = { outcome: "release" };
  for (const scenario of [
    {
      name: "successful release remains fulfilled",
      release: { state: "fulfilled" },
    },
    {
      expectedReason: undefined,
      name: "undefined release failure remains the exact rejection",
      release: { reason: undefined, state: "rejected" },
    },
    {
      aggregate: ["primary", releaseObject],
      name: "non-Error double failure has ordered provenance",
      primaryFailure: { reason: "primary" },
      release: { reason: releaseObject, state: "rejected" },
    },
    {
      aggregate: [undefined, undefined],
      name: "undefined double failure remains explicitly diagnosable",
      primaryFailure: { reason: undefined },
      release: { reason: undefined, state: "rejected" },
    },
  ]) {
    await context.test(scenario.name, async () => {
      let releaseCalls = 0;
      let releaseOptions;
      const observed = await observePromise(releaseKnownFileTransactionLease({
        jointFailureMessage: "operation and release failed",
        lease: {
          status: { diagnostics: [], state: "idle" },
          async release(options) {
            releaseCalls += 1;
            releaseOptions = options;
            if (scenario.release.state === "rejected") {throw scenario.release.reason;}
          },
        },
        ...(scenario.primaryFailure === undefined ? {} : {
          primaryFailure: scenario.primaryFailure,
        }),
        retainTransactionBarrier: true,
      }));
      assert.equal(releaseCalls, 1);
      assert.deepEqual(releaseOptions, { retainTransactionBarrier: true });
      if (scenario.aggregate === undefined) {
        assert.equal(observed.state, scenario.release.state);
        if (observed.state === "rejected") {
          assert.equal(observed.reason, scenario.expectedReason);
        }
        return;
      }
      assert.equal(observed.state, "rejected");
      assert.ok(observed.reason instanceof AggregateError);
      assert.equal(observed.reason.errors[0], scenario.aggregate[0]);
      assert.equal(observed.reason.errors[1], scenario.aggregate[1]);
      assert.equal(Object.hasOwn(observed.reason, "cause"), true);
      assert.equal(observed.reason.cause, scenario.aggregate[0]);
    });
  }
});

posixTest("apply preserves ordered provenance when mutation and release both fail", async (context) => {
  const root = await fixture(context);
  const originalCause = new Error("apply primary cause");
  const primaryFailure = new Error("apply primary failure", { cause: originalCause });
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: replacementPlan(),
    async faultInjector(point) {
      if (point.phase !== "after-journal-created") {return;}
      await writeFile(
        join(root, ".agent-teams-local", "foundation-operation.lock"),
        "invalid release evidence\n",
        "utf8",
      );
      throw primaryFailure;
    },
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "Known-file apply and transaction lease release both failed.");
    assert.equal(error.errors[0], primaryFailure);
    assert.equal(error.errors[1]?.code, "LOCAL_STATE_INVALID");
    assert.equal(error.cause, primaryFailure);
    assert.equal(primaryFailure.cause, originalCause);
    return true;
  });
  assert.ok(await stat(join(
    root,
    ".agent-teams-local",
    "scaffolding-transaction.json",
  )));
});

windowsTest("fails closed before known-file mutation on Windows", async (context) => {
  const root = await fixture(context);
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: root, plan: plan() }),
    (error) => error?.code === "KNOWN_FILE_APPLY_UNSUPPORTED"
  );
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_APPLY_UNSUPPORTED"
  );
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
  await assert.rejects(
    stat(join(root, ".agent-teams-local")),
    (error) => error?.code === "ENOENT"
  );
});

posixTest("applies create and exact known replacement, then performs a write-free no-op", async (context) => {
  const root = await fixture(context);
  const first = await applyKnownFileTransaction({ consumerRoot: root, plan: plan() });
  await assertSchema("known-file-transaction-plan/v1", plan(), "test");
  await assertSchema("known-file-transaction-receipt/v1", first, "test");
  assert.equal(first.outcome, "applied");
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "new\n");
  assert.equal((await stat(join(root, "managed", "existing.txt"))).mode & 0o777, 0o640);
  assert.equal(await readFile(join(root, "managed", "new.txt"), "utf8"), "created\n");
  const before = (await stat(join(root, "managed", "existing.txt"), { bigint: true })).mtimeNs;
  const second = await applyKnownFileTransaction({ consumerRoot: root, plan: plan() });
  const after = (await stat(join(root, "managed", "existing.txt"), { bigint: true })).mtimeNs;
  assert.equal(second.outcome, "already-satisfied");
  assert.equal(after, before);
});

posixTest("rejects stale preimages before creating a recovery journal", async (context) => {
  const root = await fixture(context);
  await writeFile(join(root, "managed", "existing.txt"), "foreign\n");
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: root, plan: plan() }),
    (error) => error?.code === "KNOWN_FILE_CAS_MISMATCH"
  );
  await assert.rejects(readFile(join(root, ".agent-teams-local", "scaffolding-transaction.json")), /ENOENT/u);
  assert.equal((await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state, "idle");
});

posixTest("returns an already-satisfied Plan without acquiring or writing the barrier", async (context) => {
  const root = await fixture(context);
  await applyKnownFileTransaction({ consumerRoot: root, plan: plan() });
  const state = join(root, ".agent-teams-local");
  await assert.rejects(readFile(state), (error) => error?.code === "EISDIR");
  const before = (await stat(state, { bigint: true })).mtimeNs;
  let invoked = false;
  const result = await applyKnownFileTransaction({
    consumerRoot: root,
    plan: plan(),
    faultInjector() {invoked = true;}
  });
  assert.equal(result.outcome, "already-satisfied");
  assert.equal(invoked, false);
  assert.equal((await stat(state, { bigint: true })).mtimeNs, before);
  assert.equal((await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state, "idle");
});

posixTest("fresh no-op does not materialize Foundation local state", async (context) => {
  const root = await fixture(context);
  await writeFile(join(root, "managed", "existing.txt"), "new\n", { mode: 0o640 });
  await writeFile(join(root, "managed", "new.txt"), "created\n", { mode: 0o644 });
  const result = await applyKnownFileTransaction({ consumerRoot: root, plan: plan() });
  assert.equal(result.outcome, "already-satisfied");
  await assert.rejects(
    stat(join(root, ".agent-teams-local")),
    (error) => error?.code === "ENOENT"
  );
});

posixTest("no-op refuses an exact postimage while an APPLYING journal exists", async (context) => {
  const root = await fixture(context);
  const single = replacementPlan();
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: single,
    faultInjector(point) {
      if (point.phase === "after-operation-published") {throw new Error("apply-crash");}
    }
  }), /apply-crash/u);
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "new\n");
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: root, plan: single }),
    (error) => error?.code === "KNOWN_FILE_RECOVERY_REQUIRED"
  );
  assert.equal(
    (await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state,
    "recovery-required"
  );
  assert.equal((await recoverKnownFileTransaction({ consumerRoot: root })).outcome, "rolled-back");
});

for (const phase of [
  "after-temporary-authorized",
  "after-temporary-synced",
  "after-capture-authorized",
  "after-capture-ready",
  "after-preimage-captured",
  "after-rollback-temporary-ready",
  "after-destination-captured",
  "after-destination-retired",
  "after-operation-publishing",
  "after-postimage-linked",
  "after-operation-published"
]) {
  posixTest(`replacement recovery is replayable after ${phase}`, async (context) => {
    const root = await fixture(context);
    const single = replacementPlan();
    await assert.rejects(applyKnownFileTransaction({
      consumerRoot: root,
      plan: single,
      faultInjector(point) {
        if (point.phase === phase) {throw new Error(`crash:${phase}`);}
      }
    }), new RegExp(`crash:${phase}`, "u"));
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

posixTest("unbound captured bytes are preserved and never trusted as a preimage", async (context) => {
  const root = await fixture(context);
  const destination = join(root, "managed", "existing.txt");
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: replacementPlan(),
    async faultInjector(point) {
      if (point.phase !== "after-preimage-linked-unbound") {return;}
      const captureDirectory = (await readdir(join(root, "managed"))).find((name) =>
        name.includes(".agent-teams.capture.")
      );
      assert.ok(captureDirectory);
      await writeFile(
        join(root, "managed", captureDirectory, "preimage"),
        "unbound-editor-bytes\n",
        { mode: 0o640 }
      );
      throw new Error("unbound-capture-crash");
    }
  }), /unbound-capture-crash/u);
  assert.equal(await readFile(destination, "utf8"), "unbound-editor-bytes\n");
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT"
  );
  assert.equal(await readFile(destination, "utf8"), "unbound-editor-bytes\n");
});

for (const [phase, replacement] of [
  ["after-capture-ready", "foreign-before-capture\n"],
  ["after-preimage-captured", "foreign-during-capture\n"],
  ["after-destination-retired", "foreign-before-publish\n"],
  ["after-postimage-linked", "foreign-after-publish\n"]
]) {
  posixTest(`never overwrites editor bytes injected at ${phase}`, async (context) => {
    const root = await fixture(context);
    const destination = join(root, "managed", "existing.txt");
    await assert.rejects(
      applyKnownFileTransaction({
        consumerRoot: root,
        plan: replacementPlan(),
        async faultInjector(point) {
          if (point.phase !== phase) {return;}
          const editor = join(root, "managed", `editor-${phase}.tmp`);
          await writeFile(editor, replacement, { mode: 0o640 });
          await rename(editor, destination);
        }
      }),
      (error) => ["KNOWN_FILE_CAS_MISMATCH", "KNOWN_FILE_POSTIMAGE_INVALID"].includes(error?.code)
    );
    assert.equal(await readFile(destination, "utf8"), replacement);
    await assert.rejects(
      recoverKnownFileTransaction({ consumerRoot: root }),
      (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT"
    );
    assert.equal(await readFile(destination, "utf8"), replacement);
  });
}

posixTest("held-fd editor bytes remain public and block conditional rollback", async (context) => {
  const root = await fixture(context);
  const destination = join(root, "managed", "existing.txt");
  const handle = await open(destination, "r+");
  try {
    await assert.rejects(applyKnownFileTransaction({
      consumerRoot: root,
      plan: replacementPlan(),
      async faultInjector(point) {
        if (point.phase === "after-destination-captured") {
          await handle.truncate(0);
          await handle.writeFile("held-fd-edit\n");
          await handle.sync();
        }
      }
    }), (error) => error?.code === "KNOWN_FILE_CAS_MISMATCH");
  } finally {
    await handle.close();
  }
  const published = await open(destination, "r");
  try {
    assert.equal(await published.readFile("utf8"), "held-fd-edit\n");
  } finally {
    await published.close();
  }
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT"
  );
  const preserved = await open(destination, "r");
  try {
    assert.equal(await preserved.readFile("utf8"), "held-fd-edit\n");
  } finally {
    await preserved.close();
  }
});

posixTest("an external hardlink injected during capture blocks publication", async (context) => {
  const root = await fixture(context);
  const destination = join(root, "managed", "existing.txt");
  const external = join(root, "managed", "external-hardlink.txt");
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: replacementPlan(),
    async faultInjector(point) {
      if (point.phase === "after-capture-ready") {
        await link(destination, external);
      }
    }
  }), (error) => error?.code === "KNOWN_FILE_CAS_MISMATCH");
  assert.equal(await readFile(destination, "utf8"), "old\n");
  assert.equal(await readFile(external, "utf8"), "old\n");
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT"
  );
  assert.equal(await readFile(destination, "utf8"), "old\n");
  assert.equal(await readFile(external, "utf8"), "old\n");
  await unlink(external);
  const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
  assert.equal(recovered.outcome, "rolled-back");
  const applied = await applyKnownFileTransaction({
    consumerRoot: root,
    plan: replacementPlan()
  });
  assert.equal(applied.outcome, "applied");
  assert.equal(await readFile(destination, "utf8"), "new\n");
});

for (const phase of [
  "after-temporary-created-unbound",
  "after-capture-created-unbound",
  "after-preimage-linked-unbound",
  "after-rollback-temporary-created-unbound"
]) {
  posixTest(`preserves unbound evidence from ${phase}`, async (context) => {
    const root = await fixture(context);
    await assert.rejects(applyKnownFileTransaction({
      consumerRoot: root,
      plan: replacementPlan(),
      faultInjector(point) {
        if (point.phase === phase) {throw new Error(`crash:${phase}`);}
      }
    }), new RegExp(`crash:${phase}`, "u"));
    await assert.rejects(
      recoverKnownFileTransaction({ consumerRoot: root }),
      (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT"
    );
    const entries = await readdir(join(root, "managed"));
    assert.ok(entries.some((name) =>
      name.includes("agent-teams")
    ));
    assert.equal(
      (await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state,
      "recovery-required"
    );
    if (phase === "after-preimage-linked-unbound") {
      assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
      const captureDirectory = entries.find((name) => name.includes(".agent-teams.capture."));
      assert.ok(captureDirectory);
      assert.equal(
        await readFile(join(root, "managed", captureDirectory, "preimage"), "utf8"),
        "old\n"
      );
    }
  });
}

posixTest("preserves an unbound authorized parent directory", async (context) => {
  const root = await temporaryDirectory(context, "foundation-known-file-parent-window-");
  const nested = compileKnownFileTransactionPlan({ operations: [{
    path: "nested/result.txt",
    precondition: { state: "absent" },
    postimage: { bytes: Buffer.from("result\n") }
  }] });
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: nested,
    faultInjector(point) {
      if (point.phase === "after-directory-created-unbound") {
        throw new Error("directory-window-crash");
      }
    }
  }), /directory-window-crash/u);
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT"
  );
  assert.ok((await stat(join(root, "nested"))).isDirectory());
});

posixTest("committed capture cleanup resumes after unlink before directory retirement", async (context) => {
  const root = await fixture(context);
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: replacementPlan(),
    faultInjector(point) {
      if (point.phase === "after-committed-capture-unlinked") {
        throw new Error("cleanup-crash");
      }
    }
  }), /cleanup-crash/u);
  const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
  assert.equal(recovered.outcome, "applied");
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "new\n");
  assert.equal((await stat(join(root, "managed", "existing.txt"))).nlink, 1);
});

posixTest("apply re-verifies committed postimages after capture cleanup", async (context) => {
  const root = await fixture(context);
  const destination = join(root, "managed", "existing.txt");
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: replacementPlan(),
    async faultInjector(point) {
      if (point.phase === "after-committed-capture-unlinked") {
        await writeFile(destination, "editor-after-cleanup\n", { mode: 0o640 });
      }
    }
  }), (error) => error?.code === "KNOWN_FILE_COMMITTED_DRIFT");
  assert.equal(await readFile(destination, "utf8"), "editor-after-cleanup\n");
  assert.equal((await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state, "recovery-required");
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_COMMITTED_DRIFT"
  );
});

posixTest("committed recovery re-verifies postimages after capture cleanup", async (context) => {
  const root = await fixture(context);
  const destination = join(root, "managed", "existing.txt");
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan: replacementPlan(),
    faultInjector(point) {
      if (point.phase === "after-journal-committed") {throw new Error("commit-stop");}
    }
  }), /commit-stop/u);
  await assert.rejects(recoverKnownFileTransaction({
    consumerRoot: root,
    async faultInjector(point) {
      if (point.phase === "after-committed-capture-unlinked") {
        await writeFile(destination, "editor-during-recovery\n", { mode: 0o640 });
      }
    }
  }), (error) => error?.code === "KNOWN_FILE_COMMITTED_DRIFT");
  assert.equal(await readFile(destination, "utf8"), "editor-during-recovery\n");
  assert.equal((await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state, "recovery-required");
});
