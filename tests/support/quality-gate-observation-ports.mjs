import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureRoot = join(tmpdir(), "explicit-observation-fixture");
import { FilesystemPackageScriptCatalogReader } from "../../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/outbound/filesystem/filesystem-package-script-catalog-reader.js";

export function registerQualityGateObservationPortTests() {
  test("package-script observation preserves limits, fresh reads and immutable snapshots", async () => {
    const calls = [];
    let source = '{"scripts":{"check":"first"}}';
    const reader = new FilesystemPackageScriptCatalogReader(async (input) => {
      calls.push(input); return new TextEncoder().encode(source);
    });
    const first = await reader.read(fixtureRoot);
    source = '{"scripts":{"check":"second"}}';
    const second = await reader.read(fixtureRoot);
    assert.deepEqual(first, { scripts: Object.assign(Object.create(null), { check: "first" }) });
    assert.deepEqual(second, { scripts: Object.assign(Object.create(null), { check: "second" }) });
    assert.ok(Object.isFrozen(first) && Object.isFrozen(first.scripts));
    assert.throws(() => { first.scripts.check = "mutated"; }, TypeError);
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ({
      root: fixtureRoot, candidate: join(fixtureRoot, "package.json"), maxBytes: 1024 * 1024,
    })));
  });

  test("package-script observation preserves cancellation versus read/parse failure precedence", async () => {
    for (const [source, expected] of [["{}", "EXECUTION_CANCELLED"], ["{", "QUALITY_GATE_RUNNER_PACKAGE_INVALID"]]) {
      const controller = new AbortController();
      const reader = new FilesystemPackageScriptCatalogReader(async () => { controller.abort(); return Buffer.from(source); });
      await assert.rejects(reader.read(fixtureRoot, controller.signal), (error) => error.problem.code === expected);
    }
    const controller = new AbortController(); controller.abort();
    const reader = new FilesystemPackageScriptCatalogReader(() => assert.fail("cancelled read must not observe"));
    await assert.rejects(reader.read(fixtureRoot, controller.signal), (error) => error.problem.code === "EXECUTION_CANCELLED");
    for (const failure of [new Error("explicit failure"), { failure: "unknown" }, null, "unknown"]) {
      const broken = new FilesystemPackageScriptCatalogReader(async () => { throw failure; });
      await assert.rejects(broken.read(fixtureRoot), (error) => {
        assert.equal(error.problem.code, "QUALITY_GATE_RUNNER_PACKAGE_INVALID");
        assert.equal(error.message, `The consumer root package.json must be a stable strict JSON file: ${failure instanceof Error ? failure.message : "unavailable"}`);
        return true;
      });
    }
  });
}
