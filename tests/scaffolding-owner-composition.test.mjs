import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateFeatureModules } from "../scripts/check-feature-modules.mjs";
import { FoundationTransactionError } from "../packages/engineering-foundation/dist/transaction-coordination/application/foundation-transaction-error.js";
import { ScaffoldError } from "../packages/engineering-foundation/dist/scaffolding/scaffold-error.js";

const policy = "../packages/engineering-foundation/dist/scaffolding/application/policies/scaffold-transaction.js";

test("scaffolding registry and public boundaries have one owner and adapters do not select composition", async () => {
  const report = await validateFeatureModules();
  assert.equal(report.modules, 6);
  assert.deepEqual(report.problems.filter(({ code }) => ["input-error", "source-policy"].includes(code)), []);
  assert.deepEqual(report.problems.filter(({ code, message }) =>
    code === "boundary-ownership" && /foundation\.scaffolding\.(canonical-composition|parameters)/u.test(message) ||
    code === "layer-direction" && /scaffolding\/adapters\/.* -> .*scaffolding\/composition\//u.test(message) ||
    code === "layer-direction" && message.startsWith("packages/engineering-foundation/src/scaffolding/index.ts ->") ||
    code === "assembly-behavior" && message.startsWith("packages/engineering-foundation/src/composition/scaffold-filesystem.ts:")
  ), []);
});

test("scaffolding transaction provider preserves root, coordinator and cleanup identity without eager effects", async () => {
  const { createScaffoldTransactionProvider } = await import(policy);
  const calls = [], coordinator = { acquire() { assert.fail("creation must not acquire"); } }, cleanup = {};
  let ready;
  const provider = createScaffoldTransactionProvider({
    createCoordinator(root) {
      calls.push(["coordinator", root]);
      return new Promise((resolve) => { ready = resolve; });
    },
    createCleanupTransition(root, id) { calls.push(["cleanup", root, id]); return cleanup; }
  });
  assert.deepEqual(calls, []);
  const pending = provider("/sandbox/canonical-root");
  assert.deepEqual(calls, [["coordinator", "/sandbox/canonical-root"]]);
  ready(coordinator);
  const transactions = await pending;
  assert.equal(transactions.coordinator, coordinator);
  assert.equal(transactions.createCleanupTransition("exact-transaction-id"), cleanup);
  assert.deepEqual(calls, [["coordinator", "/sandbox/canonical-root"], ["cleanup", "/sandbox/canonical-root", "exact-transaction-id"]]);
  const failure = new Error("cancelled before coordinator creation");
  const rejected = createScaffoldTransactionProvider({
    createCoordinator() { throw failure; },
    createCleanupTransition() { assert.fail("failed creation must not create cleanup"); }
  });
  await assert.rejects(rejected("/sandbox/other-root"), (error) => error === failure);
});

test("scaffolding acquisition owns requested mutation, orphan diagnostics and exact foreign failures", async () => {
  const { acquireScaffoldingTransaction } = await import(policy);
  const requests = [], releases = [];
  const lease = await acquireScaffoldingTransaction({
    async acquire(request) { requests.push(request); return { async release(options) { releases.push(options); } }; }
  });
  assert.deepEqual(requests, [{ requestedMutation: "scaffolding", allowRecoveryOf: "scaffolding" }]);
  await lease.releaseAfterInspection(async () => false);
  assert.deepEqual(releases, [{ retainTransactionBarrier: false }]);
  const foreign = new Error("cancelled");
  await assert.rejects(acquireScaffoldingTransaction({ acquire() { throw foreign; } }), (error) => error === foreign);
  const cause = new FoundationTransactionError({ requestedMutation: "scaffolding", status: { state: "manual-recovery-required", reason: "orphan-temporary", diagnostics: [] } });
  await assert.rejects(acquireScaffoldingTransaction({ acquire() { throw cause; } }), (error) =>
    error instanceof ScaffoldError && error.code === "SCAFFOLD_RECOVERY_REQUIRED" && error.cause === cause &&
    error.message === "Scaffolding journal temporary cannot be proven transaction-owned; it was preserved and requires manual recovery."
  );
});

test("scaffolding release retains barrier on inspection failure and preserves both failures", async () => {
  const { acquireScaffoldingTransaction } = await import(policy);
  const inspection = new Error("cannot classify evidence"), release = new Error("cannot retain barrier");
  const options = [];
  const lease = await acquireScaffoldingTransaction({ async acquire() {
    return { async release(value) { options.push(value); throw release; } };
  } });
  await assert.rejects(lease.releaseAfterInspection(async () => { throw inspection; }), (error) =>
    error.message === "Foundation transaction evidence inspection and barrier retention both failed." &&
    error.cause instanceof AggregateError && error.cause.errors[0] === inspection && error.cause.errors[1] === release
  );
  assert.deepEqual(options, [{ retainTransactionBarrier: true }]);
});

test("public scaffolding declarations preserve the released function and overload signatures", async () => {
  const declaration = await readFile(new URL("../packages/engineering-foundation/dist/composition/scaffolding-api.d.ts", import.meta.url), "utf8");
  assert.match(declaration, /export declare function recoverFilesystemScaffold\(consumerRoot: string\): Promise<ScaffoldReceipt \| undefined>;/u);
  assert.match(declaration, /export declare function recoverFilesystemScaffold\(consumerRoot: string, scope: ScaffoldRecoveryScope\): Promise<ScaffoldReceipt \| undefined>;/u);
  for (const name of ["planScaffoldFromFile", "applyFilesystemScaffold", "readScaffoldPlanFile", "validateScaffoldReceipt", "assertScaffoldPlanDigest", "assertScaffoldReceiptDigest", "assertScaffoldAuthorityEvidenceDigest"]) {
    assert.match(declaration, new RegExp(`export declare function ${name}\\(`, "u"));
  }
});

test("Node scaffold composition binds the selected cleanup synchronizer without substituting transaction identity", async () => {
  const { createNodeScaffoldTransactionProvider } = await import("../packages/engineering-foundation/dist/scaffolding/composition/scaffold-transactions.js");
  const calls = [], coordinator = {}, cleanup = {}, sync = async (directory) => { calls.push(["sync", directory]); };
  const provider = createNodeScaffoldTransactionProvider(
    async (root) => { calls.push(root); return coordinator; },
    (...args) => { calls.push(args); return cleanup; },
    sync
  );
  assert.deepEqual(calls, []);
  const transactions = await provider("/sandbox/selected-root");
  assert.equal(transactions.coordinator, coordinator);
  assert.equal(transactions.createCleanupTransition("bound-plan-operation-digest"), cleanup);
  assert.deepEqual(calls, ["/sandbox/selected-root", ["/sandbox/selected-root", "bound-plan-operation-digest", { syncStateDirectory: sync }]]);
});

test("scaffolding release preserves ordinary evidence retention and single-error identity", async () => {
  const { acquireScaffoldingTransaction } = await import(policy);
  const calls = [], inspection = new Error("inspection unavailable"), release = new Error("release unavailable");
  const lease = await acquireScaffoldingTransaction({ async acquire() {
    return { async release(options) { calls.push(options); } };
  } });
  await lease.releaseAfterInspection(async () => true);
  assert.deepEqual(calls, [{ retainTransactionBarrier: true }]);
  await assert.rejects(lease.releaseAfterInspection(async () => { throw inspection; }), (error) => error === inspection);
  assert.deepEqual(calls, [{ retainTransactionBarrier: true }, { retainTransactionBarrier: true }]);
  const failing = await acquireScaffoldingTransaction({ async acquire() {
    return { async release() { throw release; } };
  } });
  await assert.rejects(failing.releaseAfterInspection(async () => false), (error) => error === release);
});
