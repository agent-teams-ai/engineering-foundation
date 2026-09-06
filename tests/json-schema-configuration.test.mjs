import assert from "node:assert/strict";
import test from "node:test";
import { assertFeatureOutsideSchemaCycles, assertSchemaAssemblyImportRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/contract-json-schema-releases/adapters/inbound/configuration/load-capability-config.js";

function configuration() {
  return { schemaVersion: 1, contractId: "example", publicContractVersion: "1.0.0",
    releasedBaselinePath: "architecture/contracts/example.json", schemaPaths: ["schemas/example.json"],
    fixtures: [
      { id: "valid", path: "fixtures/valid.json", schemaId: "example", expectation: "valid" },
      { id: "invalid", path: "fixtures/invalid.json", schemaId: "example", expectation: "invalid" }
    ], currentConsumerEvidence: []
  };
}

function baseline() {
  return { schemaVersion: 1, contractId: "example", publicContractVersion: "1.0.0",
    schemaSetDigest: `sha256:${"a".repeat(64)}`, fixtureCorpusDigest: `sha256:${"b".repeat(64)}`, supportedConsumers: [] };
}

test("JSON Schema configuration no longer joins the module schema assembly cycle", async () => {
  await assertFeatureOutsideSchemaCycles("contract-json-schema-releases");
});

test("source policy rejects reintroducing schema assembly inside the JSON Schema configuration adapter", async () => {
  await assertSchemaAssemblyImportRejected(
    "packages/engineering-foundation/src/capabilities/contract-json-schema-releases/adapters/inbound/configuration/load-capability-config.ts",
    "../../../../../schema-catalog.js"
  );
});

test("JSON Schema configuration retains separate schema validation for release-owned baseline input", async () => {
  const input = configuration(), released = baseline(), calls = [], signal = new AbortController().signal;
  const policy = await loadCapabilityConfig({
    async readYaml(...args) { calls.push(["read", ...args]); return args[1] === "contract.yaml" ? input : released; },
    async assertSchema(...args) { calls.push(["schema", ...args]); }
  }, "explicit-memory-consumer", "contract.yaml", signal);
  assert.deepEqual(calls, [
    ["read", "explicit-memory-consumer", "contract.yaml", "json-schema-release-config", signal],
    ["schema", "contract-json-schema-releases/v1", input, "json-schema-release-config"],
    ["read", "explicit-memory-consumer", input.releasedBaselinePath, "json-schema-release-baseline", signal],
    ["schema", "contract-json-schema-release-baseline/v1", released, "json-schema-release-baseline"]
  ]);
  assert.deepEqual(policy.released, released);
  assert.deepEqual(policy.fixtures, input.fixtures);
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.released.supportedConsumers));
});

test("JSON Schema configuration preserves baseline schema rejection before producing policy", async () => {
  const failure = new Error("explicit baseline schema rejection"), input = configuration(), released = baseline();
  let reads = 0, validations = 0;
  await assert.rejects(loadCapabilityConfig({
    async readYaml() { reads += 1; return reads === 1 ? input : released; },
    async assertSchema() { validations += 1; if (validations === 2) { throw failure; } }
  }, "explicit-memory-consumer", "contract.yaml"), (error) => error === failure);
  assert.equal(reads, 2);
  assert.equal(validations, 2);
});
