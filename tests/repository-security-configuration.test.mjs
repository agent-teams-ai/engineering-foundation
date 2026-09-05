import assert from "node:assert/strict";
import test from "node:test";
import { assertFeatureOutsideSchemaCycles, assertSchemaAssemblyImportRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/repository-security-baseline/adapters/inbound/configuration/load-capability-config.js";

test("repository security configuration no longer joins the module schema assembly cycle", async () => {
  await assertFeatureOutsideSchemaCycles("repository-security-baseline");
});

test("source policy rejects reintroducing schema assembly inside the security adapter", async () => {
  await assertSchemaAssemblyImportRejected(
    "packages/engineering-foundation/src/capabilities/repository-security-baseline/adapters/inbound/configuration/load-capability-config.ts",
    "../../../../../schema-catalog.js"
  );
});

test("security configuration preserves the injected schema rejection before policy mapping", async () => {
  const failure = new Error("explicit schema rejection"), calls = [];
  const signal = new AbortController().signal;
  await assert.rejects(loadCapabilityConfig({
    async readYaml(...args) { calls.push(["read", ...args]); return null; },
    async assertSchema(...args) { calls.push(["schema", ...args]); throw failure; }
  }, "explicit-memory-consumer", "security.yaml", signal), (error) => error === failure);
  assert.deepEqual(calls, [
    ["read", "explicit-memory-consumer", "security.yaml", "repository-security-config", signal],
    ["schema", "repository-security-baseline/v1", null, "repository-security-config"]
  ]);
});
