import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { inspectKnownFileTransactionBarrier, sha256Bytes } from "@agent-teams/repository-mutation";
import { managedRestorationFixture } from "./consumer-restoration-fixture.mjs";
import { assertCliSuccess, restorationArgs, restorationCli, restorationSnapshot } from "./consumer-restoration-cli-fixture.mjs";
import { restorationJson } from "../dist/consumer-integration/application/policies/consumer-restoration-proof.js";

async function prepare(fixture, name) {
  const path = join(fixture.disposable, name, "proof.json");
  await mkdir(join(fixture.disposable, name));
  const result = await restorationCli(fixture, ["upgrade", "--consumer", fixture.consumerRoot, "--source-generation", "1", "--target-generation", "2",
    "--to", fixture.target.cohortId, "--restoration-proof", path, "--prepare", "--json"], { label: `${name}-prepare` });
  return { path, selection: assertCliSuccess(result, "prepared").preparation };
}

async function retryAndRestore(fixture, selected, path, label) {
  const result = assertCliSuccess(await restorationCli(fixture, restorationArgs(fixture, "finalize", selected, path), { label: `${label}-retry` }), "upgraded");
  assert.equal(result.receipt.outcome, "already-satisfied");
  assert.ok(result.receipt.operations.every(({ outcome }) => outcome === "already-satisfied"));
  assertCliSuccess(await restorationCli(fixture, restorationArgs(fixture, "restore", result.restoration, path), { label: `${label}-restore` }), "restored");
  return result;
}

export function registerRestorationFinalizationTests(helpers) {
  test("selected finalization survives real final-write errors and preserves colliding evidence", { skip: process.platform !== "linux" }, async (t) => {
    const fixture = await managedRestorationFixture(helpers);
    try {
      const original = await restorationSnapshot(fixture.consumerRoot);
      for (const fault of ["efbig", "eacces"]) {
        await t.test(`actual ${fault.toUpperCase()} after successful target activation supports selected retry`, async () => {
          const { path, selection } = await prepare(fixture, fault);
          assert.deepEqual(await restorationSnapshot(fixture.consumerRoot), original);
          let failed;
          try {
            failed = await restorationCli(fixture, restorationArgs(fixture, "finalize", selection, path), { fault, proofPath: path, preparationPath: selection.path, label: fault });
          } finally {await chmod(join(fixture.disposable, fault), 0o700);}
          assert.notEqual(failed.code, 0, JSON.stringify(failed));
          assert.equal(failed.execution.outcome, "blocked");
          assert.match(failed.execution.issues[0].message, new RegExp(fault, "iu"));
          assert.match(failed.stderr, /real target activation passed/u);
          assert.equal((await inspectKnownFileTransactionBarrier({ consumerRoot: fixture.consumerRoot })).state, "idle");
          const partial = await readFile(path).catch(() => null);
          if (fault === "efbig") {assert.equal(partial.length, (await lstat(selection.path)).size);}
          else {assert.equal(partial, null);}
          const receipt = JSON.parse(await readFile(`${path}.receipt`));
          assert.equal(receipt.receipt.outcome, "applied");
          if (partial !== null) {
            const refused = await restorationCli(fixture, restorationArgs(fixture, "finalize", selection, path), { label: `${fault}-partial-refused` });
            assert.notEqual(refused.code, 0); assert.deepEqual(await readFile(path), partial);
          }
          // A distinct explicitly selected destination leaves original/partial evidence untouched.
          const retryPath = `${path}.retry`;
          await writeFile(`${retryPath}.receipt`, "foreign companion\n");
          const collision = await restorationCli(fixture, restorationArgs(fixture, "finalize", selection, retryPath), { label: `${fault}-companion-refused` });
          assert.notEqual(collision.code, 0); assert.equal(await readFile(`${retryPath}.receipt`, "utf8"), "foreign companion\n");
          const restored = await retryAndRestore(fixture, selection, `${path}.final`, fault);
          const final = JSON.parse(await readFile(restored.restoration.path));
          assert.equal(final.originalReceipt, null); // This retry observed satisfaction; original remains in its immutable companion.
          assert.deepEqual(await restorationSnapshot(fixture.consumerRoot), original);
          if (partial !== null) {assert.deepEqual(await readFile(path), partial);}
        });
      }
    } finally {await fixture.close();}
  });

  test("selected finalization closes process-death and lost-output gaps with honest current receipts", { skip: process.platform !== "linux" }, async (t) => {
    const fixture = await managedRestorationFixture(helpers);
    try {
      const original = await restorationSnapshot(fixture.consumerRoot);
      for (const fault of ["after-cas", "after-activation", "lost-output"]) {
        await t.test(fault, async () => {
          const { path, selection } = await prepare(fixture, fault);
          const result = await restorationCli(fixture, restorationArgs(fixture, "finalize", selection, path), { fault, proofPath: path, label: fault });
          if (fault === "lost-output") {
            assert.equal(result.code, 0); assert.equal(result.stdout, "");
            assert.equal(JSON.parse(await readFile(path)).receipt.outcome, "applied");
          } else {
            assert.equal(result.signal, "SIGKILL", JSON.stringify(result));
            await assert.rejects(readFile(path), { code: "ENOENT" });
          }
          assert.equal((await inspectKnownFileTransactionBarrier({ consumerRoot: fixture.consumerRoot })).state, "idle");
          const retry = await retryAndRestore(fixture, selection, path, fault);
          if (fault === "lost-output") {
            assert.equal(JSON.parse(await readFile(path)).receipt.outcome, "applied");
            assert.equal(retry.receipt.outcome, "already-satisfied");
          }
          assert.deepEqual(await restorationSnapshot(fixture.consumerRoot), original);
        });
      }
      t.diagnostic("SIGKILL is actual subprocess termination at injected adapter boundaries; not power-loss/fsync or Windows qualification. Lost output discards stdout after durable completion.");
    } finally {await fixture.close();}
  });

  test("intact selected preparation never authenticates fabricated completion or failed activation", { skip: process.platform === "win32" }, async () => {
    const fixture = await managedRestorationFixture(helpers);
    try {
      const original = await restorationSnapshot(fixture.consumerRoot);
      const { path, selection } = await prepare(fixture, "forged-completion");
      const failingEnv = { MANAGED_RESTORATION_TARGET_FAIL: "1" };
      const failed = await restorationCli(fixture, restorationArgs(fixture, "finalize", selection, path), { env: failingEnv, label: "actual-target-check-fails" });
      assert.notEqual(failed.code, 0); assert.match(failed.execution.issues[0].message, /nonzero exit/u);
      const migrated = await restorationSnapshot(fixture.consumerRoot);
      assert.notDeepEqual(migrated, original);
      const preparationBytes = await readFile(selection.path);
      const intent = JSON.parse(preparationBytes);
      const { receipt } = JSON.parse(await readFile(`${path}.receipt`));
      const fabricated = { ...intent, protocol: "agent-teams.managed-v1-restoration/v1", preparationDigest: selection.digest,
        proofPath: path, receipt, originalReceipt: receipt, activation: "verified-current-v2" };
      await writeFile(path, `${restorationJson(fabricated)}\n`);
      // Original independently retained preparation/digest stay intact throughout this attack.
      assert.equal(sha256Bytes(await readFile(selection.path)), selection.digest);
      for (const activation of [[], ["--activation-only"]]) {
        const args = [...restorationArgs(fixture, "restore", selection, path), "--preparation", selection.path, ...activation];
        const rejected = await restorationCli(fixture, args, { env: failingEnv, label: `forged-restore-${activation.length}` });
        assert.equal(rejected.code, 2); assert.match(rejected.execution.issues[0].message, /Unknown consumer arguments/u);
        await assert.rejects(fixture.restore({ proofPath: path, preparationPath: selection.path, expect: selection.digest, activationOnly: activation.length > 0 }), /selection digest/u);
      }
      const rejected = await restorationCli(fixture, restorationArgs(fixture, "finalize", selection, path), { env: failingEnv, label: "forged-finalize-target-fails" });
      assert.notEqual(rejected.code, 0); assert.match(rejected.execution.issues[0].message, /nonzero exit/u);
      assert.deepEqual(await restorationSnapshot(fixture.consumerRoot), migrated);
      assert.equal(sha256Bytes(await readFile(selection.path)), selection.digest);
      await retryAndRestore(fixture, selection, `${path}.actual`, "forged-completion");
      assert.deepEqual(await restorationSnapshot(fixture.consumerRoot), original);
    } finally {await fixture.close();}
  });
}
