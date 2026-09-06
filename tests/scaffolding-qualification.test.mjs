import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyFilesystemScaffold, planScaffoldFromFile, validateScaffoldReceipt } from "../packages/engineering-foundation/dist/scaffolding/index.js";
import { runScaffoldCrashQualification } from "../packages/engineering-foundation/dist/scaffolding/qualification.js";
import { createScaffoldCrashQualification } from "../packages/engineering-foundation/dist/scaffolding/testing/api.js";
import { verifyPackedScaffoldingQualification } from "../scripts/pack-scaffolding-qualification-test.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const phases = [
  "after-journal-temporary-synced", "after-journal-prepared",
  "before-operation-authority-recheck", "after-journal-operation-publishing",
  "after-temporary-synced", "after-hard-link", "after-journal-operation-published",
  "before-final-authority-recheck", "after-final-verification",
  "before-journal-quarantine", "after-journal-unlinked"
];
async function consumer(t) {
  const root = await mkdtemp(join(tmpdir(), "scaffold-qualification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(repositoryRoot, "tests/fixtures/scaffolding-authority-consumer"), root, { recursive: true });
  return root;
}
function plan(root) {
  return planScaffoldFromFile({ consumerRoot: root, intentPath: "intents/create-fixture.yaml" });
}
async function assertNoOutputs(root, planned) {
  for (const op of planned.operations) {await assert.rejects(readFile(join(root, op.path)), { code: "ENOENT" });}
}

test("real journal and publication callbacks pause apply; events are fresh frozen phase-only values", async t => {
  for (const pausedPhase of ["after-journal-temporary-synced", "after-temporary-synced"]) {
    const root = await consumer(t);
    const planned = await plan(root);
    const reached = Promise.withResolvers();
    const release = Promise.withResolvers();
    const points = [];
    let paused = false;
    let settled = false;
    const applied = runScaffoldCrashQualification(root, planned, async point => {
      assert.equal(Object.isFrozen(point), true);
      assert.deepEqual(Reflect.ownKeys(point), ["phase"]);
      assert.ok(phases.includes(point.phase));
      assert.equal(points.includes(point), false);
      points.push(point);
      assert.throws(() => { point.phase = "future-phase"; }, TypeError);
      if (!paused && point.phase === pausedPhase) {
        paused = true;
        reached.resolve();
        await release.promise;
      }
    });
    applied.then(() => { settled = true; return null; }, () => { settled = true; return null; });
    await reached.promise;
    try {
      const count = points.length;
      await new Promise(resolve => { setImmediate(resolve); });
      await assertNoOutputs(root, planned);
      assert.equal(settled, false);
      assert.equal(points.length, count);
    } finally { release.resolve(); }
    const receipt = await applied;
    assert.equal(receipt.outcome, "applied");
    await validateScaffoldReceipt(receipt, planned);
    assert.deepEqual(new Set(points.map(point => point.phase)), new Set(phases));
    for (const op of planned.operations) {assert.deepEqual(await readFile(join(root, op.path)), Buffer.from(op.after.contentBase64, "base64"));}
  }
});

test("callback guard precedes apply; real schema and authority validation remain authoritative", async t => {
  const root = await consumer(t);
  const planned = await plan(root);
  const before = await readdir(root, { recursive: true });
  for (const callback of [undefined, null, {}, 1, "callback"]) {
    await assert.rejects(runScaffoldCrashQualification(root, planned, callback), TypeError);
  }
  assert.deepEqual(await readdir(root, { recursive: true }), before);
  let calls = 0;
  await assert.rejects(runScaffoldCrashQualification(root, {}, () => { calls++; }));
  assert.equal(calls, 0);
  await assertNoOutputs(root, planned);
  for (const apply of [applyFilesystemScaffold, runScaffoldCrashQualification]) {
    const changedRoot = await consumer(t);
    const changedPlan = await plan(changedRoot);
    const catalog = join(changedRoot, "architecture/package-catalog.yaml");
    await writeFile(catalog, (await readFile(catalog, "utf8")).replace("owner_document: ADR-0060", "owner_document: ADR-0061"));
    const receipt = await apply(changedRoot, changedPlan, () => {});
    assert.equal(receipt.outcome, "authority-stale");
    await assertNoOutputs(changedRoot, changedPlan);
  }
});

test("projection excludes unknown and recovery events without leaking internal objects", async () => {
  const internal = { phase: "after-hard-link", operationIndex: 0, operationPath: "private", mutable: {} };
  const receipt = {};
  const points = [];
  const harness = createScaffoldCrashQualification(async (_root, _plan, inject) => {
    for (const phase of ["after-temporary-written", "after-recovery-scope-checked", "future-phase"]) {await inject({ ...internal, phase });}
    await inject(internal);
    await inject(internal);
    return receipt;
  });
  assert.equal(await harness.runScaffoldCrashQualification("unused", {}, point => { points.push(point); }), receipt);
  assert.equal(points.length, 2);
  assert.notEqual(points[0], points[1]);
  for (const point of points) {
    assert.notEqual(point, internal);
    assert.deepEqual(Reflect.ownKeys(point), ["phase"]);
    assert.equal(Object.isFrozen(point), true);
  }
  let invoked = false;
  const guarded = createScaffoldCrashQualification(async () => { invoked = true; return receipt; });
  await assert.rejects(guarded.runScaffoldCrashQualification("unused", {}, null), TypeError);
  assert.equal(invoked, false);
});

test("callback rejection follows the existing real apply error behavior", async t => {
  const root = await consumer(t);
  const planned = await plan(root);
  const failure = new Error("qualification-callback-failure");
  await assert.rejects(runScaffoldCrashQualification(root, planned, async point => {
    if (point.phase === "before-operation-authority-recheck") {throw failure;}
  }), error => error === failure);
  await assertNoOutputs(root, planned);
});

test("source-built bare-import fixture: eleven exit-73 cuts and TypeScript contract (not released package qualification)", async t => {
  const consumerRoot = await mkdtemp(join(tmpdir(), "scaffold-bare-import-"));
  t.after(() => rm(consumerRoot, { recursive: true, force: true }));
  const scope = join(consumerRoot, "node_modules/@agent-teams");
  await mkdir(scope, { recursive: true });
  await symlink(join(repositoryRoot, "packages/engineering-foundation"), join(scope, "engineering-foundation"), process.platform === "win32" ? "junction" : "dir");
  const result = await verifyPackedScaffoldingQualification({ fixture: { consumerRoot }, repositoryRoot });
  t.diagnostic(result.stdout);
});
