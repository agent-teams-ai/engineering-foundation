import assert from "node:assert/strict";
import test from "node:test";
import { assertFeatureOutsideSchemaCycles, assertSchemaAssemblyImportRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { loadQualityGatePolicy } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/inbound/configuration/load-quality-gate-policy.js";
import { parseQualityGatePolicy } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/inbound/configuration/parse-quality-gate-policy.js";
import { CapabilityInputError } from "../packages/engineering-foundation/dist/features/validation-reporting/api.js";

test("quality gate configuration no longer joins the module schema assembly cycle", async () => {
  await assertFeatureOutsideSchemaCycles("quality-gate-runner");
});

test("source policy rejects reintroducing schema assembly inside the quality gate adapter", async () => {
  await assertSchemaAssemblyImportRejected(
    "packages/engineering-foundation/src/capabilities/quality-gate-runner/adapters/inbound/configuration/load-quality-gate-policy.ts",
    "../../../../../schema-catalog.js"
  );
});

test("quality gate configuration retains the dependency trace and immutable task graph", async () => {
  const input = { schemaVersion: 1, packageManager: "pnpm", profiles: [
    { id: "verify", concurrency: 2, tasks: [{ id: "build" }, { id: "test", needs: ["build"], timeoutMs: 5000 }] }
  ] };
  const calls = [], signal = new AbortController().signal;
  const policy = await loadQualityGatePolicy({
    async readYaml(...args) { calls.push(["read", ...args]); return input; },
    async assertSchema(...args) { calls.push(["schema", ...args]); }
  }, "explicit-memory-consumer", "quality-gates.yaml", signal);
  assert.deepEqual(calls, [
    ["read", "explicit-memory-consumer", "quality-gates.yaml", "quality-gate-runner-config", signal],
    ["schema", "quality-gate-runner/v1", input, "quality-gate-runner-config"]
  ]);
  assert.deepEqual(policy, { packageManager: "pnpm", profiles: [
    { id: "verify", concurrency: 2, tasks: [
      { id: "build", needs: [], after: [] },
      { id: "test", needs: ["build"], after: [], timeoutMs: 5000 }
    ] }
  ] });
  assert.deepEqual(parseQualityGatePolicy(input), policy);
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.profiles[0].tasks));
  assert.ok(Object.isFrozen(policy.profiles[0].tasks[1].needs));
});

test("quality gate configuration preserves injected schema rejection before graph mapping", async () => {
  const failure = new Error("explicit schema rejection");
  let attempts = 0;
  await assert.rejects(loadQualityGatePolicy({
    async readYaml() { return null; },
    async assertSchema() { attempts += 1; throw failure; }
  }, "explicit-memory-consumer", "quality-gates.yaml"), (error) => error === failure);
  assert.equal(attempts, 1);
});

test("quality gate configuration preserves graph errors after schema validation", async () => {
  const input = { profiles: [{ id: "verify", concurrency: 1, tasks: [{ id: "build", needs: ["missing"] }] }] };
  let validated = false;
  await assert.rejects(loadQualityGatePolicy({
    async readYaml() { return input; },
    async assertSchema() { validated = true; }
  }, "explicit-memory-consumer", "quality-gates.yaml"), (error) => {
    assert.ok(error instanceof CapabilityInputError);
    assert.equal(error.problem.code, "QUALITY_GATE_RUNNER_CONFIG_INVALID");
    assert.equal(error.problem.phase, "quality-gate-runner-config");
    assert.equal(error.message, "Profile verify task build references unknown task missing.");
    return true;
  });
  assert.equal(validated, true);
});
