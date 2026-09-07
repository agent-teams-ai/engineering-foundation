import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFoundationModeInspection } from "../../packages/engineering-foundation/dist/local-mode/composition/inspection.js";
import { createFoundationTransactionCoordinatorFactory } from "../../packages/engineering-foundation/dist/transaction-coordination/composition/node-coordinator.js";
import { installedFoundationVersion } from "../../packages/engineering-foundation/dist/transaction-coordination/adapters/node/installed-foundation-version.js";
import { installedFoundationBuildIdentity } from "../../packages/engineering-foundation/dist/transaction-coordination/adapters/node/installed-foundation-build-identity.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "local-mode-owned-ports-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const consumer = join(root, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "disposable-consumer", private: true,
    devDependencies: { "@agent-teams/engineering-foundation": "1.0.0" },
  }));
  return { root, consumer };
}

export function registerLocalModeOwnedPortTests(test) {
  test("local transaction observation preserves canonical roots, thrown identity and projection order", async t => {
    const { root, consumer } = await fixture(t);
    const alias = join(root, "alias");
    await symlink(consumer, alias, "junction");
    let thenReads = 0;
    const thenable = runInNewContext('Object.defineProperty({}, "then", { get() { onRead(); throw new Error("must not assimilate rejection"); } })', { onRead() { thenReads++; } });
    for (const sentinel of [undefined, null, Symbol("observation"), thenable]) {
      const reader = createFoundationModeInspection(async canonical => {
        assert.equal(canonical, consumer);
        throw sentinel;
      });
      let rejected = false;
      try { await reader.inspectFoundationMode(alias); }
      catch (error) { rejected = true; assert.equal(error, sentinel); }
      assert.equal(rejected, true);
    }
    assert.equal(thenReads, 0);
    const sentinel = Symbol("status accessor");
    const reader = createFoundationModeInspection(async () => Object.defineProperty({}, "state", { get() { throw sentinel; } }));
    await assert.rejects(reader.inspectFoundationMode(consumer), error => error === sentinel);
  });

  test("local transaction observation is skipped for a redirected state directory", async t => {
    const { root, consumer } = await fixture(t);
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(consumer, ".agent-teams-local"), "junction");
    const reader = createFoundationModeInspection(async () => assert.fail("unsafe directory cannot reach transaction reader"));
    const status = await reader.inspectFoundationMode(consumer);
    assert.equal(status.mode, "INVALID");
    assert.ok(status.issues.includes("Local foundation state path must be a real consumer-owned directory."));
    assert.equal(status.transaction, undefined);
  });

  test("local observation projects private recovery evidence without touching it", async t => {
    const { consumer } = await fixture(t);
    const observed = {
      state: "pending", operationKind: "known-file-transaction", format: "known-file-transaction-envelope-v1",
      foundationVersion: "1.0.0", foundationBuildIdentity: "sha256:fixture",
      recovery: { commandId: "replace-known-file-recover", exactFoundationVersion: "1.0.0", exactFoundationBuildIdentity: "sha256:fixture" },
      diagnostics: [],
    };
    Object.defineProperty(observed, "recoveryArtifacts", { get() { return assert.fail("private evidence is not a public status input"); } });
    const status = await createFoundationModeInspection(async () => observed).inspectFoundationTransactionAwareMode(consumer);
    assert.deepEqual(status.transaction, { ...observed });
    assert.notEqual(status.transaction, observed);
    assert.equal(status.transaction.recovery, observed.recovery);
  });

  test("transaction factory binds the canonical root and exact installed identity to the supplied slot", async t => {
    const { root, consumer } = await fixture(t);
    const alias = join(root, "alias");
    await symlink(consumer, alias, "junction");
    const status = Object.freeze({ state: "idle", diagnostics: [] });
    const seen = [];
    const { createNodeFoundationTransactionCoordinator: createCoordinator } = createFoundationTransactionCoordinatorFactory(options => {
      seen.push(options);
      return { inspect: async () => status };
    });
    const coordinator = await createCoordinator(alias);
    assert.deepEqual(seen, [{ consumerRoot: consumer, installedVersion: await installedFoundationVersion(), installedBuildIdentity: await installedFoundationBuildIdentity() }]);
    assert.equal(await coordinator.inspect(), status);
    await assert.rejects(createCoordinator(join(root, "missing")), error => error.code === "ENOENT");
    assert.equal(seen.length, 1);
    const sentinel = Symbol("slot construction");
    await assert.rejects(createFoundationTransactionCoordinatorFactory(() => { throw sentinel; }).createNodeFoundationTransactionCoordinator(consumer), error => error === sentinel);
  });

  test("local module facade preserves the legacy constructor identity and method arities", async () => {
    const publicModule = await import("../../packages/engineering-foundation/dist/local-mode/index.js");
    const legacy = await import("../../packages/engineering-foundation/dist/composition/local-mode-service.js");
    assert.equal(publicModule.FoundationLocalModeService, legacy.FoundationLocalModeService);
    const Service = publicModule.FoundationLocalModeService;
    assert.equal(Service.length, 1);
    for (const method of ["status", "detach", "assertRegistry", "assertDevOnly"]) { assert.equal(Service.prototype[method].length, 1); }
    assert.equal(Service.prototype.attach.length, 2);
  });
}
