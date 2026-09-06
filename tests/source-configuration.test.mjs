import assert from "node:assert/strict";
import test from "node:test";
import { assertFeatureOutsideSchemaCycles, assertSchemaAssemblyImportRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/source-dependencies/adapters/inbound/configuration/load-capability-config.js";
import { readSourceArchitectureHeader, parseSourceArchitecturePolicy } from "../packages/engineering-foundation/dist/capabilities/source-dependencies/adapters/inbound/configuration/parse-capability-config.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";

function configuration(schemaVersion) {
  return {
    schemaVersion, workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
    governedRoots: ["packages/app/src"],
    ...(schemaVersion === 2 ? { packageRoots: ["packages"] } : {}),
    boundaries: [{ id: "app", roots: ["packages/app/src"], entrypoints: ["packages/app/src/index.ts"],
      allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] }
    }]
  };
}

test("source dependency configuration no longer joins the module schema assembly cycle", async () => {
  await assertFeatureOutsideSchemaCycles("source-dependencies");
});

test("source policy rejects reintroducing schema assembly inside its own configuration adapter", async () => {
  await assertSchemaAssemblyImportRejected(
    "packages/engineering-foundation/src/capabilities/source-dependencies/adapters/inbound/configuration/load-capability-config.ts",
    "../../../../../schema-catalog.js"
  );
});

for (const version of [1, 2]) {
  test(`source v${version} configuration observes version before validating and maps pure values`, async () => {
    const input = configuration(version), calls = [];
    const policy = await loadCapabilityConfig({
      async readYaml(...args) { calls.push(["read", ...args]); return input; },
      async assertSchema(...args) { calls.push(["schema", ...args]); await assertSchema(...args); }
    }, "explicit-memory-consumer", "source.yaml", new AbortController().signal, (observed) => { calls.push(["version", observed]); });
    assert.deepEqual(calls, [
      ["read", "explicit-memory-consumer", "source.yaml", "source-architecture-config"],
      ["version", version],
      ["schema", `architecture-source-dependencies/v${version}`, input, "source-architecture-config"]
    ]);
    assert.equal(policy.schemaVersion, version);
    assert.deepEqual(policy.governedRoots, ["packages/app/src"]);
    assert.deepEqual(parseSourceArchitecturePolicy(readSourceArchitectureHeader(input)), policy);
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.boundaries));
  });

  test(`source v${version} cancellation retains one bounded read and the requested report version`, async () => {
    const controller = new AbortController();
    controller.abort();
    let reads = 0, validations = 0, observed;
    await assert.rejects(loadCapabilityConfig({
      async readYaml(...args) {
        reads += 1;
        assert.equal(args.length, 3);
        return configuration(version);
      },
      async assertSchema() { validations += 1; }
    }, "explicit-memory-consumer", "source.yaml", controller.signal, (value) => { observed = value; }), (error) => {
      assert.equal(error.problem.code, "EXECUTION_CANCELLED");
      return true;
    });
    assert.equal(reads, 1);
    assert.equal(validations, 0);
    assert.equal(observed, version);
  });
}

test("source configuration preserves schema failure identity after publishing its version", async () => {
  const failure = new Error("explicit schema rejection");
  let observed;
  await assert.rejects(loadCapabilityConfig({
    async readYaml() { return configuration(2); },
    async assertSchema() { throw failure; }
  }, "explicit-memory-consumer", "source.yaml", undefined, (value) => { observed = value; }), (error) => error === failure);
  assert.equal(observed, 2);
});

test("source configuration retains cancellation precedence when its bounded read fails", async () => {
  const failure = new Error("read failed");
  const controller = new AbortController();
  controller.abort();
  const dependencies = { async readYaml() { throw failure; }, async assertSchema() { assert.fail("schema must not run"); } };
  await assert.rejects(loadCapabilityConfig(dependencies, "explicit-memory-consumer", "source.yaml"), (error) => error === failure);
  await assert.rejects(loadCapabilityConfig(dependencies, "explicit-memory-consumer", "source.yaml", controller.signal), (error) => {
    assert.equal(error.problem.code, "EXECUTION_CANCELLED");
    return true;
  });
});

// Schema assembly contracts belong to configuration-input alongside its readers.
test("schema lists retain contribution order, duplicates, and mutable array identity", async () => {
  const { createSchemaList } = await import("../packages/engineering-foundation/dist/features/configuration-input/module.js");
  const first = ["one", "duplicate"], second = ["duplicate", "two"];
  const { schemaIds, firstSchemaId } = createSchemaList([first, [], second]);
  assert.deepEqual(schemaIds, ["one", "duplicate", "duplicate", "two"]);
  assert.equal(firstSchemaId, "one");
  assert.notEqual(schemaIds, first);
  assert.equal(Object.isFrozen(schemaIds), false);
  schemaIds.push("three");
  assert.deepEqual(first, ["one", "duplicate"]);
  assert.deepEqual(second, ["duplicate", "two"]);
});

test("contributed schema catalogs preserve merge precedence, reader identity, order and cache", async () => {
  const { createContributedSchemaCatalog } = await import("../packages/engineering-foundation/dist/features/configuration-input/module.js");
  const calls = [], accesses = [], dependencies = ["a", "b"];
  const first = { get main() { accesses.push("first"); return ["discarded"]; }, cleared: ["discarded"] };
  const second = { get main() { accesses.push("second"); return dependencies; }, b: ["a"], cleared: undefined };
  const readSchema = async (id) => { calls.push(id); return JSON.stringify({ $id: `urn:fixture:${id}`, type: "string" }); };
  const catalog = createContributedSchemaCatalog({ schemaIds: ["main", "cleared"], dependencyContributions: [first, second], readSchema });
  assert.equal(catalog.readSchema, readSchema);
  assert.deepEqual(accesses, ["first", "second"]);
  dependencies.push("c");
  await Promise.all([catalog.assertSchema("main", "valid", "phase"), catalog.assertSchema("main", "valid", "phase")]);
  await catalog.assertSchema("cleared", "valid", "phase");
  assert.deepEqual(calls, ["a", "b", "c", "main", "cleared"]);
  assert(catalog.isSchemaId("main"));
  assert.equal(catalog.isSchemaId("a"), false);
});

test("contributed catalog failures retain rejection identity and bounded diagnostics", async () => {
  const { createContributedSchemaCatalog } = await import("../packages/engineering-foundation/dist/features/configuration-input/module.js");
  const failure = new Error("exact reader rejection");
  let reads = 0;
  const broken = createContributedSchemaCatalog({ schemaIds: ["broken"], dependencyContributions: [{}, {}], readSchema: async () => { reads += 1; throw failure; } });
  for (let count = 0; count < 2; count += 1) {
    await assert.rejects(broken.assertSchema("broken", {}, "phase"), (error) => error === failure);
  }
  assert.equal(reads, 1);
  const required = Array.from({ length: 12 }, (_, index) => `field${index}`);
  const bounded = createContributedSchemaCatalog({ schemaIds: ["bounded"], dependencyContributions: [{}, {}], readSchema: async () => JSON.stringify({ $id: "urn:fixture:bounded", type: "object", required, properties: Object.fromEntries(required.map((name) => [name, { type: "string" }])) }) });
  await assert.rejects(bounded.assertSchema("bounded", {}, "retained-phase"), (error) => {
    assert.equal(error.problem.phase, "retained-phase");
    assert.equal(error.message.split("; ").length, 8);
    assert(error.message.length <= 1000);
    return true;
  });
});

test("installed schema reader observes the actual package root while custom readers retain theirs", async () => {
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { createInstalledPackagedSchemaReader, createPackagedSchemaReader } = await import("../packages/engineering-foundation/dist/features/configuration-input/module.js");
  const expectedRoot = dirname(dirname(fileURLToPath(new URL("../packages/engineering-foundation/dist/schema-catalog.js", import.meta.url))));
  const requests = [], failure = new Error("observation rejected");
  const input = { files: { read: async (request) => { requests.push(request); return Buffer.from("λ"); } }, schemaFiles: { "mapped/v1": "schemas/custom.json" }, readAuthoringSchema: async (id) => `authoring:${id}` };
  const installed = createInstalledPackagedSchemaReader(input);
  assert.equal(await installed("mapped/v1"), "λ");
  assert.deepEqual(requests[0], { root: expectedRoot, candidate: resolve(expectedRoot, "schemas/custom.json"), maxBytes: 1024 * 1024 });
  const customRoot = resolve(expectedRoot, "custom Ω directory");
  const custom = createPackagedSchemaReader({ ...input, packageRoot: customRoot });
  assert.equal(await custom("ordinary/v1"), "λ");
  assert.deepEqual(requests[1], { root: customRoot, candidate: resolve(customRoot, "schemas/ordinary/v1.schema.json"), maxBytes: 1024 * 1024 });
  assert.equal(await installed("document-plan/v1"), "authoring:document-plan/v1");
  await assert.rejects(installed("../escape"));
  assert.equal(requests.length, 2);
  const rejected = createInstalledPackagedSchemaReader({ ...input, files: { read: async () => { throw failure; } } });
  await assert.rejects(rejected("ordinary/v1"), (error) => error === failure);
});
