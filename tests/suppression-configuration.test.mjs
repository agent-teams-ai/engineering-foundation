import assert from "node:assert/strict";
import test from "node:test";
import { assertFeatureOutsideSchemaCycles, assertSchemaAssemblyImportRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/suppression-governance/adapters/inbound/configuration/load-capability-config.js";

test("suppression configuration no longer joins the module schema assembly cycle", async () => {
  await assertFeatureOutsideSchemaCycles("suppression-governance");
});

test("source policy rejects reintroducing schema assembly inside the suppression adapter", async () => {
  await assertSchemaAssemblyImportRejected(
    "packages/engineering-foundation/src/capabilities/suppression-governance/adapters/inbound/configuration/load-capability-config.ts",
    "../../../../../schema-catalog.js"
  );
});

test("suppression configuration uses explicit dependencies and retains normalized policy", async () => {
  const input = { schemaVersion: 1, governedRoots: ["src"], nonWaivableRulePrefixes: ["security."], waivers: [] };
  const calls = [], signal = new AbortController().signal;
  const policy = await loadCapabilityConfig({
    async readYaml(...args) { calls.push(["read", ...args]); return input; },
    async assertSchema(...args) { calls.push(["schema", ...args]); }
  }, "explicit-memory-consumer", "suppression.yaml", signal);
  assert.deepEqual(calls, [
    ["read", "explicit-memory-consumer", "suppression.yaml", "suppression-governance-config", signal],
    ["schema", "quality-suppression-governance/v1", input, "suppression-governance-config"]
  ]);
  assert.deepEqual(policy, { governedRoots: ["src"], nonWaivableRulePrefixes: ["security."], waivers: [] });
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.waivers));
});

test("suppression configuration preserves injected schema rejection before parsing", async () => {
  const failure = new Error("explicit schema rejection");
  let attempts = 0;
  await assert.rejects(loadCapabilityConfig({
    async readYaml() { return null; },
    async assertSchema() { attempts += 1; throw failure; }
  }, "explicit-memory-consumer", "suppression.yaml"), (error) => error === failure);
  assert.equal(attempts, 1);
});
