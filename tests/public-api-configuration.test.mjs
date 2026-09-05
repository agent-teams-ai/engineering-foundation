import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertFeatureOutsideSchemaCycles, assertSchemaAssemblyImportRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { withPublicApiFixture } from "./support/capability-fixtures.mjs";
import { ROOT_STABLE_ITEM, currentBaseline } from "./support/public-api-fixtures.mjs";
import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-capability-config.js";
import { readConfigurationHeader, parseCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/inbound/configuration/parse-capability-config.js";
import { FilesystemPublicApiRepository } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-public-api-repository.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";

function configuration() {
  return { schemaVersion: 1, changesetDirectory: ".changeset",
    acceptedDecisionBaselinePath: "architecture/decisions/accepted-decisions.json",
    packages: [{ packageName: "@fixture/public-api", packageRoot: "packages/library",
      manifestPath: "packages/library/package.json", tsconfigPath: "packages/library/tsconfig.json",
      releasedBaselinePath: "architecture/public-api/public-api.json", approvedBreakingChanges: [], nonTypeExports: [],
      entrypoints: [
        { exportPath: "./local-mode", declarationEntryPoint: "packages/library/dist/local-mode.d.ts" },
        { exportPath: ".", declarationEntryPoint: "packages/library/dist/index.d.ts" }
      ]
    }]
  };
}

function packagePolicy() {
  return parseCapabilityConfig(readConfigurationHeader(configuration())).packages[0];
}

test("Public API configuration and baseline storage no longer join the module schema assembly cycle", async () => {
  await assertFeatureOutsideSchemaCycles("public-api-compatibility");
});

for (const adapter of ["inbound/configuration/load-capability-config.ts", "outbound/filesystem/filesystem-public-api-repository.ts"]) {
  test(`source policy rejects a schema assembly import in the Public API ${adapter}`, async () => {
    await assertSchemaAssemblyImportRejected(
      `packages/engineering-foundation/src/capabilities/public-api-compatibility/adapters/${adapter}`,
      "../../../../../schema-catalog.js"
    );
  });
}

test("Public API configuration retains the exact schema, signal forwarding and canonical entrypoint ordering", async () => {
  const input = configuration(), calls = [], signal = new AbortController().signal;
  const policy = await loadCapabilityConfig({
    async readYaml(...args) { calls.push(["read", ...args]); return input; },
    async assertSchema(...args) { calls.push(["schema", ...args]); await assertSchema(...args); }
  }, "explicit-memory-consumer", "public-api.yaml", signal);
  assert.deepEqual(calls, [
    ["read", "explicit-memory-consumer", "public-api.yaml", "public-api-compatibility-config", signal],
    ["schema", "package-public-api-compatibility/v1", input, "public-api-compatibility-config"]
  ]);
  assert.deepEqual(policy, parseCapabilityConfig(readConfigurationHeader(input)));
  assert.deepEqual(policy.packages[0].entrypoints.map(({ exportPath }) => exportPath), [".", "./local-mode"]);
  assert.ok(Object.isFrozen(policy.packages[0].entrypoints));
});

test("Public API configuration retains header-before-schema and schema-before-policy error precedence", async () => {
  const failure = new Error("schema rejected before policy mapping");
  let validations = 0;
  const dependencies = { async readYaml() { return { schemaVersion: 2 }; },
    async assertSchema() { validations += 1; throw failure; } };
  await assert.rejects(loadCapabilityConfig(dependencies, "explicit-memory-consumer", "public-api.yaml"), /schemaVersion must be 1/u);
  assert.equal(validations, 0);
  await assert.rejects(loadCapabilityConfig({ ...dependencies,
    async readYaml() { return { schemaVersion: 1, packages: null }; }
  }, "explicit-memory-consumer", "public-api.yaml"), (error) => error === failure);
  assert.equal(validations, 1);
});

test("Public API pure configuration retains immutable baseline anchors and duplicate export rejection", () => {
  const relocated = configuration();
  relocated.packages[0].releasedBaselinePath = "architecture/public-api/other.json";
  assert.throws(() => parseCapabilityConfig(relocated), /Released baseline path must use the stable package anchor/u);
  const duplicate = configuration();
  duplicate.packages[0].nonTypeExports.push({ exportPath: ".", kind: "runtime" });
  assert.throws(() => parseCapabilityConfig(duplicate), /declared as both typed and non-type/u);
});

test("Public API legacy baseline reads delegate schema validation without rewriting persisted bytes", async () => {
  await withPublicApiFixture(async (root) => {
    const policy = packagePolicy(), path = join(root, policy.releasedBaselinePath), calls = [];
    const legacy = { schemaVersion: 1, packageName: policy.packageName, packageVersion: "1.2.3",
      extractorVersion: "7.58.12", items: [ROOT_STABLE_ITEM] };
    const bytes = `${JSON.stringify(legacy)}\n`;
    await writeFile(path, bytes);
    const repository = new FilesystemPublicApiRepository(async (...args) => { calls.push(args); await assertSchema(...args); });
    const result = await repository.readReleasedBaseline(root, policy);
    assert.deepEqual(calls, [["package-public-api-baseline/v1", legacy, "public-api-baseline"]]);
    assert.deepEqual(result.entrypoints, [{ exportPath: ".", items: [ROOT_STABLE_ITEM] }]);
    assert.equal(await readFile(path, "utf8"), bytes);
  });
});

test("Public API baseline schema rejection preserves the file and creates no temporary directory", async () => {
  await withPublicApiFixture(async (root) => {
    const policy = packagePolicy(), path = join(root, policy.releasedBaselinePath), calls = [];
    const before = await readFile(path), entries = await readdir(dirname(path));
    const failure = new Error("baseline schema rejected");
    const repository = new FilesystemPublicApiRepository(async (...args) => { calls.push(args); throw failure; });
    const snapshot = currentBaseline();
    await assert.rejects(repository.writeReleasedBaseline(root, policy, snapshot), (error) => error === failure);
    assert.deepEqual(calls, [["package-public-api-baseline/v1", snapshot, "public-api-baseline-promotion"]]);
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(await readdir(dirname(path)), entries);
  });
});

test("Public API baseline promotion retains canonical bytes through the injected schema validator", async () => {
  await withPublicApiFixture(async (root) => {
    const policy = packagePolicy(), calls = [], snapshot = currentBaseline();
    const repository = new FilesystemPublicApiRepository(async (...args) => { calls.push(args); await assertSchema(...args); });
    await repository.writeReleasedBaseline(root, policy, snapshot);
    assert.deepEqual(calls, [["package-public-api-baseline/v1", snapshot, "public-api-baseline-promotion"]]);
    assert.equal(await readFile(join(root, policy.releasedBaselinePath), "utf8"), `${JSON.stringify(snapshot, null, 2)}\n`);
  });
});
