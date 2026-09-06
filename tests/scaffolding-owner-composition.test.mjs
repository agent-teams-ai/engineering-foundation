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
    code === "layer-direction" && message.startsWith("packages/engineering-foundation/src/scaffolding/") ||
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

test("authority observation ports retain exact arguments, rechecks and opaque failure causes", async () => {
  const { mkdtemp, writeFile, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { readContainedRepositoryFile } = await import("../packages/engineering-foundation/dist/scaffolding/adapters/node/node-repository-file.js");
  const { scaffoldAuthorityObservation } = await import("../packages/engineering-foundation/dist/scaffolding/composition/node-scaffolding.js");
  const root = await mkdtemp(join(tmpdir(), "scaffold-observation-port-"));
  try {
    await writeFile(join(root, "input.yaml"), "value: true\n");
    const calls = [], canonical = await realpath(root);
    const observation = { ...scaffoldAuthorityObservation, async pathTraversesSymbolicLink(...args) { calls.push(args); return false; } };
    const file = await readContainedRepositoryFile(root, "input.yaml", "port-probe", observation);
    assert.equal(file.source, "value: true\n");
    assert.deepEqual(calls, [[canonical, join(canonical, "input.yaml")], [canonical, join(canonical, "input.yaml")]]);
    for (const cause of [Symbol("opaque"), Object.freeze({ code: "ENOENT" }), new DOMException("cancelled", "AbortError")]) {
      await assert.rejects(readContainedRepositoryFile(root, "input.yaml", "port-probe", {
        ...observation, async pathTraversesSymbolicLink() { throw cause; }
      }), (error) => error instanceof ScaffoldError && error.cause === cause);
    }
    await assert.rejects(readContainedRepositoryFile(root, "input.yaml", "port-probe", {
      ...observation, async pathTraversesSymbolicLink() { return calls.length++ > 2; }
    }), /changed while it was being read/u);
    await assert.rejects(readContainedRepositoryFile(root, "../escape", "port-probe", {
      ...observation, async pathTraversesSymbolicLink() { assert.fail("invalid path must precede observation"); }
    }), /Cannot read scaffolding input/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("YAML observation preserves unknown thrown identity before schema validation", async () => {
  const { cp, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { loadAuthorityScaffoldCompilationInputFromFile } = await import("../packages/engineering-foundation/dist/scaffolding/adapters/node/node-authority-input-loader.js");
  const { scaffoldAuthorityObservation } = await import("../packages/engineering-foundation/dist/scaffolding/composition/node-scaffolding.js");
  const root = await mkdtemp(join(tmpdir(), "scaffold-yaml-port-"));
  try {
    await cp(new URL("./fixtures/scaffolding-authority-consumer/", import.meta.url), root, { recursive: true });
    for (const failure of [Symbol("opaque parser"), new DOMException("cancelled", "AbortError")]) {
      const calls = [];
      await assert.rejects(loadAuthorityScaffoldCompilationInputFromFile({
        consumerRoot: root, configPath: "architecture/foundation/scaffolding.yaml", intentPath: "intents/create-fixture.yaml", foundationVersion: "1.0.0"
      }, async () => assert.fail("parser failure must precede schema"), {
        ...scaffoldAuthorityObservation, parseYaml(source, phase) { calls.push([source, phase]); throw failure; }
      }), (error) => error === failure);
      assert.equal(calls.length, 1);
      assert.equal(calls[0][1], "scaffold-intent");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy digest observation keeps schema precedence and unknown error identity", async () => {
  const { inspectLegacyScaffoldingEnvelope } = await import("../packages/engineering-foundation/dist/scaffolding/adapters/node/scaffold-transaction-status.js");
  const calls = [], value = {}, failure = Symbol("digest failure");
  await assert.rejects(inspectLegacyScaffoldingEnvelope(value, async (...args) => { calls.push(args); }, {
    assertEnvelopeDigests(input) { assert.equal(input, value); throw failure; },
    journalPlanDigest() { assert.fail("envelope digest failure precedes journal validation"); }
  }), (error) => error === failure);
  assert.deepEqual(calls, [["foundation-transaction-envelope/v2", value, "foundation-transaction-slot"]]);
});

test("artifact ports preserve validation precedence, exact build binding and opaque rejection", async () => {
  const { cp, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { planScaffoldFromFile } = await import("../packages/engineering-foundation/dist/scaffolding/index.js");
  const { freshAuthorityScaffoldJournal } = await import("../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-journal-state.js");
  const { compileFoundationScaffoldEnvelope, parseFoundationScaffoldEnvelope } = await import("../packages/engineering-foundation/dist/scaffolding/adapters/node/foundation-scaffold-envelope.js");
  const { scaffoldTransactionArtifacts } = await import("../packages/engineering-foundation/dist/scaffolding/composition/node-scaffolding.js");
  const root = await mkdtemp(join(tmpdir(), "scaffold-artifact-port-"));
  try {
    await cp(new URL("./fixtures/scaffolding-authority-consumer/", import.meta.url), root, { recursive: true });
    const journal = freshAuthorityScaffoldJournal(await planScaffoldFromFile({ consumerRoot: root, intentPath: "intents/create-fixture.yaml" }));
    const artifacts = await scaffoldTransactionArtifacts(), calls = [];
    const observe = async () => { calls.push("artifacts"); return artifacts; };
    const envelope = await compileFoundationScaffoldEnvelope(journal, observe);
    assert.deepEqual(calls, ["artifacts"]);
    assert.deepEqual(envelope.ownerArtifact, artifacts.owner);
    assert.deepEqual(envelope.kernelArtifact, artifacts.kernel);
    const { canonicalJson } = await import("../packages/engineering-foundation/dist/scaffolding/kernel/canonical-json.js");
    const bytes = Buffer.from(canonicalJson(envelope));
    assert.deepEqual((await parseFoundationScaffoldEnvelope(bytes, observe)).journal, journal);
    await assert.rejects(parseFoundationScaffoldEnvelope(bytes, async () => ({ ...artifacts, owner: { ...artifacts.owner, buildIdentity: `sha256:${"0".repeat(64)}` } })), /artifact/u);
    await assert.rejects(parseFoundationScaffoldEnvelope(Buffer.from("{bad"), async () => assert.fail("strict envelope parse precedes artifact observation")));
    for (const failure of [Symbol("opaque artifact"), new DOMException("cancelled", "AbortError")]) {
      const reject = async () => { throw failure; };
      await assert.rejects(compileFoundationScaffoldEnvelope(journal, reject), (error) => error === failure);
      await assert.rejects(parseFoundationScaffoldEnvelope(bytes, reject), (error) => error === failure);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
