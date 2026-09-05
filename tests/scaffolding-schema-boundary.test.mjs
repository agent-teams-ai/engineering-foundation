import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { observeFoundationFeatureGraph } from "./helpers/local-mode-boundaries.mjs";
import { assertSchemaAssemblyImportsRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
import { createNodeScaffoldingApi, createScaffoldFilesystemDependencies } from "../packages/engineering-foundation/dist/scaffolding/composition/node-scaffolding.js";
import { applyAuthorityFilesystemScaffoldWithFaultInjection as apply } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-authority-workspace.js";
import { assessScaffoldPlanAuthority } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/node-plan-authority.js";
import { freshAuthorityScaffoldJournal } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-journal-state.js";
import { serializeScaffoldJournal, parseScaffoldJournal } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/node-scaffold-journal-evidence.js";
import { inspectLegacyScaffoldingJournal, inspectLegacyScaffoldingEnvelope } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/scaffold-transaction-status.js";

async function unusedTransactions() { assert.fail("no filesystem transaction is admitted in this test"); }
async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "scaffolding-schema-boundary-"));
  try {
    await cp(new URL("./fixtures/scaffolding-authority-consumer/", import.meta.url), root, { recursive: true });
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
function api(validate = assertSchema) { return createNodeScaffoldingApi(validate, unusedTransactions); }
function plan(root, service = api()) { return service.planScaffoldFromFile({ consumerRoot: root, intentPath: "intents/create-fixture.yaml" }); }

test("Foundation runtime and type feature graphs have no schema assembly cycles", async () => {
  const graph = await observeFoundationFeatureGraph();
  assert.deepEqual(graph.missing, []);
  assert.deepEqual(graph.runtimeCycles, []);
  assert.deepEqual(graph.combinedCycles, []);
});

test("source policy rejects schema assembly imports in all six scaffolding adapters", async () => {
  await assertSchemaAssemblyImportsRejected([
    "node/node-authority-input-loader.ts",
    "node/node-authority-receipt-validator.ts",
    "node/node-scaffold-journal-evidence.ts",
    "node/scaffold-transaction-status.ts",
    "node/filesystem-authority-workspace.ts",
    "inbound/scaffolding-cli-command.ts"
  ].map((path) => ({
    path: `packages/engineering-foundation/src/scaffolding/adapters/${path}`,
    specifier: "../../../schema-catalog.js"
  })));
});

test("injected validation retains planning and Plan reading schema order and bytes", async () => withFixture(async (root) => {
  const calls = [];
  const service = api(async (id, input, phase) => { calls.push([id, phase]); await assertSchema(id, input, phase); });
  const actual = await plan(root, service);
  assert.deepEqual(actual, await plan(root));
  assert.deepEqual(calls, [
    ["scaffolding-config/v1", "scaffolding-config"],
    ["scaffold-intent/v1", "scaffold-intent"],
    ["scaffold-target-catalog/v1", "scaffold-target-catalog"],
    ["scaffold-authority-evidence/v1", "scaffold-authority-evidence"]
  ]);
  const bytes = `${JSON.stringify(actual, null, 2)}\n`;
  await writeFile(join(root, "plan.json"), bytes);
  assert.deepEqual(await service.readScaffoldPlanFile(root, "plan.json"), actual);
  assert.deepEqual(calls.at(-1), ["scaffold-plan/v1", "scaffold-plan"]);
  assert.equal(await readFile(join(root, "plan.json"), "utf8"), bytes);
}));

test("schema rejection precedes apply filesystem access and keeps the caller Plan unchanged", async () => withFixture(async (root) => {
  const value = await plan(root), before = JSON.stringify(value), calls = [], failure = new Error("plan schema rejected");
  const dependencies = createScaffoldFilesystemDependencies(async (...args) => { calls.push(args); throw failure; }, unusedTransactions);
  await assert.rejects(apply(join(root, "does-not-exist"), value, undefined, dependencies), (error) => error === failure);
  assert.deepEqual(calls.map(([id, , phase]) => [id, phase]), [["scaffold-plan/v1", "scaffold-apply-plan"]]);
  assert.notEqual(calls[0][1], value);
  assert.equal(JSON.stringify(value), before);
}));

test("authority validation failures remain unverifiable rather than stale", async () => withFixture(async (root) => {
  const value = await plan(root);
  assert.deepEqual(await assessScaffoldPlanAuthority(root, value, async () => { throw new Error("schema unavailable"); }), { state: "unverifiable" });
}));

test("receipt validation preserves the delegated schema failure and input identity", async () => {
  const receipt = {}, calls = [], failure = new Error("receipt rejected");
  await assert.rejects(api(async (...args) => { calls.push(args); throw failure; }).validateScaffoldReceipt(receipt), (error) => error === failure);
  assert.deepEqual(calls, [["scaffold-receipt/v1", receipt, "scaffold-receipt"]]);
  assert.equal(calls[0][1], receipt);
});

test("journal codecs preserve historical pretty JSON and current envelope bytes", async () => withFixture(async (root) => {
  const journal = freshAuthorityScaffoldJournal(await plan(root));
  const historical = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
  const historicalCopy = Buffer.from(historical), calls = [];
  const validate = async (id, input, phase) => { calls.push([id, phase]); await assertSchema(id, input, phase); };
  assert.deepEqual(await parseScaffoldJournal(historical, validate), journal);
  assert.deepEqual(historical, historicalCopy);
  assert.deepEqual(calls, [["scaffold-recovery-journal/v1", "scaffold-recovery-journal"], ["scaffold-plan/v1", "scaffold-recovery-journal"]]);
  const current = await serializeScaffoldJournal(journal, validate);
  assert.deepEqual(await parseScaffoldJournal(current, validate), journal);
  assert.deepEqual(await serializeScaffoldJournal(journal, assertSchema), current);
  const invalid = Buffer.from(`${historical.toString("utf8")} `);
  await assert.rejects(parseScaffoldJournal(invalid, validate), /historical canonical form/u);
  await assert.rejects(parseScaffoldJournal(Buffer.from("{broken"), async () => assert.fail("invalid JSON cannot reach schema validation")), /invalid strict JSON/u);
}));

for (const [name, inspect, schema] of [
  ["journal", inspectLegacyScaffoldingJournal, "scaffold-recovery-journal/v1"],
  ["envelope", inspectLegacyScaffoldingEnvelope, "foundation-transaction-envelope/v2"]
]) {
  test(`legacy scaffolding ${name} retains exact schema, evidence and rejection`, async () => {
    const value = {}, calls = [], failure = new Error("legacy schema rejected");
    const input = name === "journal" ? { value, installedVersion: "1.0.0", installedBuildIdentity: `sha256:${"a".repeat(64)}` } : value;
    await assert.rejects(inspect(input, async (...args) => { calls.push(args); throw failure; }), (error) => error === failure);
    assert.deepEqual(calls, [[schema, value, "foundation-transaction-slot"]]);
    assert.equal(calls[0][1], value);
    assert.deepEqual(value, {});
  });
}
