import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyKnownFileTransaction,
  compileKnownFileTransactionPlan,
  recoverKnownFileTransaction
} from "../packages/engineering-foundation/dist/mutation/index.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";

const posixTest = process.platform === "win32" ? test.skip : test;
const windowsTest = process.platform === "win32" ? test : test.skip;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foundation-known-file-"));
  await mkdir(join(root, "managed"));
  await writeFile(join(root, "managed", "existing.txt"), "old\n", { mode: 0o640 });
  return root;
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

windowsTest("fails closed before known-file mutation on Windows", async () => {
  const root = await fixture();
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: root, plan: plan() }),
    (error) => error?.code === "KNOWN_FILE_APPLY_UNSUPPORTED"
  );
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
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
    await recoverKnownFileTransaction({ consumerRoot: root });
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
  });
}

posixTest("reuses an exact rollback temporary left by an interrupted recovery", async () => {
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
  await writeFile(
    join(root, "managed", ".existing.txt.agent-teams.rollback.0.tmp"),
    "old\n",
    { mode: 0o640 }
  );
  await recoverKnownFileTransaction({ consumerRoot: root });
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
