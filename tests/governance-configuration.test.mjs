import assert from "node:assert/strict";
import test from "node:test";
import { assertFeatureOutsideSchemaCycles, assertSchemaAssemblyImportRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/adapters/inbound/configuration/load-capability-config.js";
import { parseCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/adapters/inbound/configuration/parse-capability-config.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";

function configuration() {
  return { schemaVersion: 1, adrRoots: ["docs/decisions"],
    index: { path: "docs/decisions/README.md", sections: { proposed: "Proposed", accepted: "Accepted", superseded: "Superseded" } },
    acceptedBaselinePath: "architecture/decisions/accepted-decisions.json"
  };
}

test("governance configuration no longer joins the module schema assembly cycle", async () => {
  await assertFeatureOutsideSchemaCycles("governance-architecture-decisions");
});

test("source policy rejects reintroducing schema assembly inside the governance configuration adapter", async () => {
  await assertSchemaAssemblyImportRejected(
    "packages/engineering-foundation/src/capabilities/governance-architecture-decisions/adapters/inbound/configuration/load-capability-config.ts",
    "../../../../../schema-catalog.js"
  );
});

test("governance configuration retains ordered validation and immutable baseline policy", async () => {
  const input = configuration(), calls = [], signal = new AbortController().signal;
  const policy = await loadCapabilityConfig({
    async readYaml(...args) { calls.push(["read", ...args]); return input; },
    async assertSchema(...args) { calls.push(["schema", ...args]); await assertSchema(...args); }
  }, "explicit-memory-consumer", "governance.yaml", signal);
  assert.deepEqual(calls, [
    ["read", "explicit-memory-consumer", "governance.yaml", "architecture-decision-governance-config", signal],
    ["schema", "governance-architecture-decisions/v1", input, "architecture-decision-governance-config"]
  ]);
  assert.deepEqual(policy, { adrRoots: input.adrRoots, index: input.index, acceptedBaselinePath: input.acceptedBaselinePath });
  assert.deepEqual(parseCapabilityConfig(input), policy);
  assert.ok(Object.isFrozen(policy.index.sections));
});

test("pure governance configuration preserves the stable anchor and distinct status headings", () => {
  const relocated = configuration();
  relocated.acceptedBaselinePath = "tmp/reset-history.json";
  assert.throws(() => parseCapabilityConfig(relocated), (error) => {
    assert.equal(error.problem.code, "ARCHITECTURE_DECISION_GOVERNANCE_CONFIG_INVALID");
    assert.equal(error.problem.phase, "architecture-decision-governance-config");
    assert.equal(error.message, "acceptedBaselinePath must use the stable architecture/decisions/accepted-decisions.json anchor.");
    return true;
  });
  const duplicate = configuration();
  duplicate.index.sections.proposed = " Accepted ";
  assert.throws(() => parseCapabilityConfig(duplicate), /index.sections values must be distinct/u);
});

test("governance configuration preserves schema rejection before accepted-history mapping", async () => {
  const failure = new Error("explicit schema rejection");
  await assert.rejects(loadCapabilityConfig({
    async readYaml() { return null; },
    async assertSchema() { throw failure; }
  }, "explicit-memory-consumer", "governance.yaml"), (error) => error === failure);
});
