/* oxlint-disable max-lines -- crash, race, and recovery checkpoints form one contract matrix. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { link, mkdtemp, mkdir, open, readFile, readdir, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyKnownFileTransaction,
  compileKnownFileTransactionPlan,
  inspectKnownFileTransactionBarrier,
  recoverKnownFileTransaction
} from "../packages/engineering-foundation/dist/mutation/index.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
import { compileKnownFileTransactionEnvelope } from "../packages/engineering-foundation/dist/repository-mutation/application/policies/known-file-transaction-envelope.js";

const posixTest = process.platform === "win32" ? test.skip : test;
const windowsTest = process.platform === "win32" ? test : test.skip;
const crashWorker = fileURLToPath(new URL(
  "./fixtures/known-file-transaction-crash-worker.mjs",
  import.meta.url
));

async function killAtCheckpoint(root, checkpoint, action = "apply") {
  const child = spawn(process.execPath, [crashWorker, root, checkpoint, action], {
    stdio: ["ignore", "pipe", "inherit"]
  });
  const exited = new Promise((resolve) => {child.once("exit", resolve);});
  let output = "";
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`checkpoint timeout: ${checkpoint}`)), 30_000);
      child.once("error", reject);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes(`${checkpoint}\n`)) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw error;
  }
  assert.equal(child.kill("SIGKILL"), true);
  await exited;
}

for (const checkpoint of [
  "after-retirement-directory-bound",
  "after-retirement-captured",
  "after-retirement-unlink-authorized"
]) {
  posixTest(`SIGKILL retirement replay leaves no residue at ${checkpoint}`, async () => {
    const root = await fixture();
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foundation-known-file-"));
  await mkdir(join(root, "managed"));
  await writeFile(join(root, "managed", "existing.txt"), "old\n", { mode: 0o640 });
  return root;
}

posixTest("terminal and ancestor symlinks never redirect a known-file mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-known-file-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "foundation-known-file-outside-"));
  await mkdir(join(root, "managed"));
  await writeFile(join(outside, "target.txt"), "outside\n", { mode: 0o640 });
  await symlink(join(outside, "target.txt"), join(root, "managed", "existing.txt"));
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: root, plan: replacementPlan() }),
    /real regular file/u
  );
  assert.equal(await readFile(join(outside, "target.txt"), "utf8"), "outside\n");

  const ancestorRoot = await mkdtemp(join(tmpdir(), "foundation-known-file-ancestor-"));
  await symlink(outside, join(ancestorRoot, "managed"));
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: ancestorRoot, plan: replacementPlan() })
  );
  assert.equal(await readFile(join(outside, "target.txt"), "utf8"), "outside\n");
});

posixTest("runtime case aliases and non-portable Unicode aliases fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-known-file-alias-"));
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

posixTest("two concurrent applies admit one publisher and fail the live-lock contender closed", async () => {
  const root = await fixture();
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

posixTest("exact BOM and CRLF bytes and non-default mode survive replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-known-file-bytes-"));
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
  posixTest(`${code} fault leaves a deterministically recoverable transaction`, async () => {
    const root = await fixture();
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

function plan() {
  return compileKnownFileTransactionPlan({ operations: [
    {
      path: "managed/existing.txt",
      precondition: {
        state: "known-file",
        acceptedPreimages: [{ bytes: Buffer.from("old\n"), mode: 0o640 }]
      },
      postimage: { bytes: Buffer.from("new\n"), mode: 0o640 }
    },
    {
      path: "managed/new.txt",
      precondition: { state: "absent" },
      postimage: { bytes: Buffer.from("created\n") }
    }
  ] });
}

function replacementPlan() {
  const operation = plan().operations[0];
  return compileKnownFileTransactionPlan({ operations: [{
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
  }] });
}

windowsTest("fails closed before known-file mutation on Windows", async () => {
  const root = await fixture();
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

posixTest("applies create and exact known replacement, then performs a write-free no-op", async () => {
  const root = await fixture();
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

posixTest("rejects stale preimages before creating a recovery journal", async () => {
  const root = await fixture();
  await writeFile(join(root, "managed", "existing.txt"), "foreign\n");
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: root, plan: plan() }),
    (error) => error?.code === "KNOWN_FILE_CAS_MISMATCH"
  );
  await assert.rejects(readFile(join(root, ".agent-teams-local", "scaffolding-transaction.json")), /ENOENT/u);
  assert.equal((await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state, "idle");
});

posixTest("returns an already-satisfied Plan without acquiring or writing the barrier", async () => {
  const root = await fixture();
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

posixTest("fresh no-op does not materialize Foundation local state", async () => {
  const root = await fixture();
  await writeFile(join(root, "managed", "existing.txt"), "new\n", { mode: 0o640 });
  await writeFile(join(root, "managed", "new.txt"), "created\n", { mode: 0o644 });
  const result = await applyKnownFileTransaction({ consumerRoot: root, plan: plan() });
  assert.equal(result.outcome, "already-satisfied");
  await assert.rejects(
    stat(join(root, ".agent-teams-local")),
    (error) => error?.code === "ENOENT"
  );
});

posixTest("no-op refuses an exact postimage while an APPLYING journal exists", async () => {
  const root = await fixture();
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
  posixTest(`replacement recovery is replayable after ${phase}`, async () => {
    const root = await fixture();
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

posixTest("unbound captured bytes are preserved and never trusted as a preimage", async () => {
  const root = await fixture();
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
  posixTest(`never overwrites editor bytes injected at ${phase}`, async () => {
    const root = await fixture();
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

posixTest("held-fd editor bytes remain public and block conditional rollback", async () => {
  const root = await fixture();
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
  assert.equal(await readFile(destination, "utf8"), "held-fd-edit\n");
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT"
  );
  assert.equal(await readFile(destination, "utf8"), "held-fd-edit\n");
});

posixTest("an external hardlink injected during capture blocks publication", async () => {
  const root = await fixture();
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
  posixTest(`preserves unbound evidence from ${phase}`, async () => {
    const root = await fixture();
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

posixTest("preserves an unbound authorized parent directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-known-file-parent-window-"));
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

posixTest("committed capture cleanup resumes after unlink before directory retirement", async () => {
  const root = await fixture();
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

posixTest("apply re-verifies committed postimages after capture cleanup", async () => {
  const root = await fixture();
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

posixTest("committed recovery re-verifies postimages after capture cleanup", async () => {
  const root = await fixture();
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

for (const [checkpoint, expectedOutcome] of [
  ["after-rollback-temporary-ready", "rolled-back"],
  ["after-preimage-captured", "rolled-back"],
  ["after-postimage-linked", "rolled-back"],
  ["after-committed-capture-unlinked", "applied"]
]) {
  posixTest(`SIGKILL recovery is exact at ${checkpoint}`, async () => {
    const root = await fixture();
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
  posixTest(`dead lock residue is safely taken over after SIGKILL at ${checkpoint}`, async () => {
    const root = await fixture();
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

posixTest("rollback verifies already-satisfied guards before returning a receipt", async () => {
  const root = await fixture();
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

posixTest("journal policy rejects created and authorized paths outside operation parents", async () => {
  const root = await fixture();
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
      ...envelope.journal,
      createdDirectories: [{
        path: "../outside",
        identity: { birthtimeNs: "1", dev: "1", ino: "1" }
      }]
    },
    { ...envelope.journal, authorizedDirectories: ["unrelated"] }
  ]) {
    assert.throws(() => compileKnownFileTransactionEnvelope({
      foundation: envelope.foundation,
      journal,
      state: "APPLYING"
    }), /created directory|authorized-directory/u);
  }
});

posixTest("recovery requires the exact Foundation build before touching files", async () => {
  const root = await fixture();
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
    foundation: {
      ...envelope.foundation,
      buildIdentity: `sha256:${"0".repeat(64)}`
    },
    journal: envelope.journal,
    state: envelope.state
  });
  await writeFile(journalPath, `${JSON.stringify(foreignBuild)}\n`, "utf8");
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    /must recover the pending known-file transaction|exact Foundation build/u
  );
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
});

for (const phase of ["after-operation-publishing", "after-operation-published"]) {
  posixTest(`recovers an interrupted replacement at ${phase}`, async () => {
    const root = await fixture();
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
    const envelope = JSON.parse(await readFile(
      join(root, ".agent-teams-local", "scaffolding-transaction.json"),
      "utf8"
    ));
    await assertSchema("foundation-transaction-envelope/v5", envelope, "test");
    const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
    assert.equal(recovered.outcome, "rolled-back");
    assert.equal(recovered.operations[0].outcome, "rolled-back-to-preimage");
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
  });
}

posixTest("preserves an unbound rollback temporary after its creation window", async () => {
  const root = await fixture();
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
  posixTest(`resumes rollback after a crash at ${phase}`, async () => {
    const root = await fixture();
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

posixTest("preserves a destination that appears before rollback publication", async () => {
  const root = await fixture();
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

posixTest("preserves an exact-content foreign temporary when its identity changed", async () => {
  const root = await fixture();
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

posixTest("rejects hard-linked destinations before mutation", async () => {
  const root = await fixture();
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

posixTest("finishes retirement of a committed transaction without rolling it back", async () => {
  const root = await fixture();
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

posixTest("committed recovery verifies unchanged guard operations too", async () => {
  const root = await fixture();
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

posixTest("never rolls back an exact third-party postimage replacement", async () => {
  const root = await fixture();
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

posixTest("recovers from the canonical journal while preserving a torn transition candidate", async () => {
  const root = await fixture();
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

posixTest("canonical-absent torn journal candidate remains manual evidence", async () => {
  const root = await fixture();
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
  posixTest(`classifies ${name} transaction evidence for manual recovery`, async () => {
    const root = await fixture();
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
