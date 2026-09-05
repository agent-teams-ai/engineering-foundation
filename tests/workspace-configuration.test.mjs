import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertFeatureOutsideSchemaCycles, assertSchemaAssemblyImportRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/workspace-dependency-declarations/adapters/inbound/filesystem/load-capability-config.js";

const schema = await readFile(new URL("../packages/engineering-foundation/schemas/workspace-dependency-declarations/v1.schema.json", import.meta.url), "utf8");

test("workspace declaration configuration no longer joins the module schema assembly cycle", async () => {
  await assertFeatureOutsideSchemaCycles("workspace-dependency-declarations");
});

test("source policy rejects reintroducing schema assembly inside the workspace configuration adapter", async () => {
  await assertSchemaAssemblyImportRejected(
    "packages/engineering-foundation/src/capabilities/workspace-dependency-declarations/adapters/inbound/filesystem/load-capability-config.ts",
    "../../../../../schema-catalog.js"
  );
});

test("workspace configuration reads the exact schema after the bounded YAML input", async () => {
  const input = { schemaVersion: 1, packageManager: { kind: "pnpm", workspaceManifest: "pnpm-workspace.yaml" }, policies: {
    externalDependencies: "catalog", catalogVersions: "exact", internalDependencies: "workspace-protocol",
    reservedScopes: ["@fixture/"], developmentOnlyPackages: ["typescript"], exactRegistryDevelopmentOnlyPackages: ["@fixture/foundation"]
  } };
  const calls = [], signal = new AbortController().signal;
  const settings = await loadCapabilityConfig({
    async readYaml(...args) { calls.push(["read", ...args]); return input; },
    async readSchema(...args) { calls.push(["schema", ...args]); return schema; }
  }, "explicit-memory-consumer", "dependencies.yaml", signal);
  assert.deepEqual(calls, [
    ["read", "explicit-memory-consumer", "dependencies.yaml", "workspace-dependency-declarations-config", signal],
    ["schema", "workspace-dependency-declarations/v1"]
  ]);
  assert.deepEqual(settings, { packageManagerKind: "pnpm", workspaceManifestPath: "pnpm-workspace.yaml", policy: {
    reservedScopes: ["@fixture/"], developmentOnlyPackages: ["typescript"], exactRegistryDevelopmentOnlyPackages: ["@fixture/foundation"]
  } });
  assert.ok(Object.isFrozen(settings.policy));
  assert.ok(Object.isFrozen(settings.policy.developmentOnlyPackages));
});

test("workspace configuration preserves failure identity and does not read schema after YAML rejection", async () => {
  const failure = new Error("explicit YAML rejection");
  let schemaReads = 0;
  await assert.rejects(loadCapabilityConfig({
    async readYaml() { throw failure; },
    async readSchema() { schemaReads += 1; return schema; }
  }, "explicit-memory-consumer", "dependencies.yaml"), (error) => error === failure);
  assert.equal(schemaReads, 0);
  await assert.rejects(loadCapabilityConfig({
    async readYaml() { return null; },
    async readSchema() { throw failure; }
  }, "explicit-memory-consumer", "dependencies.yaml"), (error) => error === failure);
});
