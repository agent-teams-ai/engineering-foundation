import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { assertFeatureOutsideSchemaCycles, assertSchemaAssemblyImportRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/executable-specifications/adapters/inbound/configuration/load-capability-config.js";
import { parseCatalogSource } from "../packages/engineering-foundation/dist/capabilities/executable-specifications/adapters/inbound/configuration/parse-capability-config.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";

function catalog() {
  return { schemaVersion: 1, specifications: [{
    id: "example-contract", ownerDocs: ["docs/example.md"], adrRefs: ["docs/decisions/0001-example.md"],
    schemaPaths: ["specifications/example.schema.json"],
    documents: [{ path: "specifications/example.json", schemaId: "https://schemas.example.test/example/v1" }],
    generatedTypes: [], gateBindings: {
      property: { packageName: "@example/specs", script: "spec:property" },
      mutation: { packageName: "@example/specs", script: "spec:mutation" }
    }, stateModel: { kind: "none" }
  }] };
}

test("executable configuration no longer joins the module schema assembly cycle", async () => {
  await assertFeatureOutsideSchemaCycles("executable-specifications");
});

test("source policy rejects reintroducing schema assembly inside the executable configuration adapter", async () => {
  await assertSchemaAssemblyImportRejected(
    "packages/engineering-foundation/src/capabilities/executable-specifications/adapters/inbound/configuration/load-capability-config.ts",
    "../../../../../schema-catalog.js"
  );
});

test("executable configuration retains the two schema checks and bounded contained catalog read", async () => {
  const input = { schemaVersion: 1, catalogPath: "architecture/catalog.json" }, value = catalog();
  const calls = [], signal = new AbortController().signal, consumerRoot = resolve("explicit-memory-consumer");
  const policy = await loadCapabilityConfig({
    async readYaml(...args) { calls.push(["yaml", ...args]); return input; },
    async readFile(...args) { calls.push(["file", ...args]); return Buffer.from(JSON.stringify(value)); },
    async assertSchema(id, candidate, phase) { calls.push(["schema", id, phase]); await assertSchema(id, candidate, phase); }
  }, consumerRoot, "specifications.yaml", signal);
  assert.deepEqual(calls, [
    ["yaml", consumerRoot, "specifications.yaml", "executable-specification-config", signal],
    ["schema", "quality-executable-specifications/v1", "executable-specification-config"],
    ["file", { candidate: resolve(consumerRoot, input.catalogPath), maxBytes: 4 * 1024 * 1024, root: consumerRoot }],
    ["schema", "quality-executable-specification-catalog/v1", "executable-specification-catalog"]
  ]);
  assert.deepEqual(policy, { schemaVersion: 1, configPath: "specifications.yaml", catalogPath: input.catalogPath, specifications: value.specifications });
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.specifications[0].documents));
});

test("pure executable catalog decoding retains duplicate-key and invalid JSON diagnostics", () => {
  for (const [source, code, message] of [
    ['{"key":1,"key":2}', "EXECUTABLE_SPECIFICATION_CATALOG_DUPLICATE_KEY", "Executable specification catalog contains duplicate object keys: catalog.json."],
    ['{"key":', "EXECUTABLE_SPECIFICATION_CATALOG_INVALID", "Executable specification catalog is not valid JSON: catalog.json."]
  ]) {
    assert.throws(() => parseCatalogSource(source, "catalog.json"), (error) => {
      assert.deepEqual(error.problem, { code, message, phase: "executable-specification-config", retryable: false });
      return true;
    });
  }
});

test("executable catalog cancellation keeps its schema boundary after the contained read", async () => {
  const controller = new AbortController();
  let validations = 0, reads = 0;
  await assert.rejects(loadCapabilityConfig({
    async readYaml() { return { schemaVersion: 1, catalogPath: "catalog.json" }; },
    async readFile() { reads += 1; controller.abort(); return Buffer.from(JSON.stringify(catalog())); },
    async assertSchema(...args) { validations += 1; await assertSchema(...args); }
  }, "explicit-memory-consumer", "specifications.yaml", controller.signal), (error) => {
    assert.equal(error.problem.code, "EXECUTION_CANCELLED");
    return true;
  });
  assert.equal(reads, 1);
  assert.equal(validations, 1);
});
