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
