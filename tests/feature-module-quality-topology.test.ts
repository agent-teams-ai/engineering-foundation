import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { projectQualitySourceTopology } from "../packages/feature-module-standard/dist/quality-topology.js";

const moduleRoot = "packages/contexts/worker";
const sourceRoot = `${moduleRoot}/src`;
const standard = (version: string) => ({ id: "agent-teams.feature-module-standard", version });
const flat = (version = "v1") => ({
  schemaVersion: 1,
  standard: standard(version),
  topology: { sourcePolicy: "source.yaml" },
  productionRoots: ["packages"],
  applicationRoots: [],
  excludedRoots: ["spikes"],
  modules: [{ root: moduleRoot, sourceRoot, testRoots: [`${moduleRoot}/tests`] }],
});
const nested = (version = "v1") => ({
  schemaVersion: 1,
  authority: standard(version),
  scope: {
    workspaceContainers: ["packages"],
    productionRoots: [sourceRoot],
    productionModules: [{ moduleRoot, sourceRoot, adoption: "pending" }],
  },
  adoption: {
    applicationRoots: [],
    excludedRoots: ["spikes"],
    abstractLayout: { modules: [{ moduleRoot, sourceRoot, testRoot: `${moduleRoot}/tests` }] },
  },
});

void test("FMS flat and nested v1/v1.1 project the same neutral topology without adopting sub-feature policy", () => {
  const subFeature = {
    features: [
      {
        id: "orders",
        root: `${sourceRoot}/features/orders`,
        features: [{ id: "discounts", root: `${sourceRoot}/features/orders/features/discounts` }],
        compositionContract: `${sourceRoot}/features/orders/composition/orders.contracts.ts`,
      },
    ],
  };
  const expected = {
    schemaVersion: 1,
    censusRoots: ["packages"],
    packageRoots: [".", moduleRoot],
    sourceRoots: [sourceRoot],
    testRoots: [`${moduleRoot}/tests`],
    excludedRoots: ["spikes"],
    toolingFiles: [],
  };
  for (const profile of [flat, nested]) {
    assert.deepEqual(projectQualitySourceTopology(profile(), "source.yaml"), expected);
    assert.deepEqual(
      projectQualitySourceTopology({ ...profile("v1.1"), ...subFeature }, "source.yaml"),
      expected,
    );
    for (const version of ["v1.2", "v2"]) {
      assert.throws(
        () => projectQualitySourceTopology(profile(version), "source.yaml"),
        /FMS v1 or v1\.1/u,
      );
    }
  }
  assert.throws(
    () =>
      projectQualitySourceTopology(
        { ...nested(), authority: { id: "other-standard", version: "v1" } },
        "source.yaml",
      ),
    /FMS v1 or v1\.1/u,
  );
});

void test("FMS projection preserves pending modules and exact application sources", () => {
  const profile = nested();
  const appRoot = "apps/app";
  const appSource = `${appRoot}/src`;
  const input = {
    ...profile,
    scope: {
      ...profile.scope,
      productionRoots: [sourceRoot, appSource],
      productionModules: [
        ...profile.scope.productionModules,
        { moduleRoot: appRoot, sourceRoot: appSource, adoption: "active" },
      ],
    },
    adoption: {
      ...profile.adoption,
      applicationRoots: [appRoot],
      excludedRoots: [`${appRoot}/tests`],
    },
  };
  const result = projectQualitySourceTopology(input, "source.yaml");
  assert.deepEqual(result.censusRoots, [appRoot, "packages"]);
  assert.deepEqual(result.packageRoots, [".", appRoot, moduleRoot]);
  assert.deepEqual(result.sourceRoots, [appSource, sourceRoot]);
  assert.deepEqual(result.excludedRoots, [`${appRoot}/tests`]);
  assert.throws(
    () =>
      projectQualitySourceTopology(
        { ...input, scope: { ...input.scope, productionRoots: [sourceRoot] } },
        "source.yaml",
      ),
    /application must map an existing production source root/u,
  );
  assert.throws(
    () =>
      projectQualitySourceTopology(
        {
          ...profile,
          adoption: {
            ...profile.adoption,
            abstractLayout: {
              modules: [{ moduleRoot, sourceRoot: "wrong/src", testRoot: "tests" }],
            },
          },
        },
        "source.yaml",
      ),
    /existing production module and its source root/u,
  );
});

void test("FMS source-policy linkage and exact generated provenance remain enforced", () => {
  assert.throws(
    () => projectQualitySourceTopology(flat(), "different.yaml"),
    /source-policy mapping differs/u,
  );
  const profile = flat();
  const generators = ["tools/generate.ts", `${sourceRoot}/main.ts`];
  const result = projectQualitySourceTopology(
    {
      ...profile,
      modules: profile.modules.map((entry) => ({
        ...entry,
        generatedRoots: generators.map((generator) => ({ root: "generated", generator })),
      })),
    },
    "source.yaml",
  );
  assert.deepEqual(result.toolingFiles, generators.toSorted());
  assert.deepEqual(
    result.sourceRoots,
    [sourceRoot],
    "a generator inside production does not remove its source protection",
  );
  assert.ok(Object.isFrozen(result));
  assert.ok(
    Object.values(result).every((value) => !Array.isArray(value) || Object.isFrozen(value)),
  );
  profile.productionRoots.push("other");
  assert.deepEqual(result.censusRoots, ["packages"]);
});

void test("FMS root-package projections remain portable neutral inputs", () => {
  const profile = flat();
  assert.deepEqual(
    projectQualitySourceTopology(
      {
        ...profile,
        productionRoots: ["."],
        modules: [{ root: ".", sourceRoot: "src", testRoots: ["tests"] }],
      },
      "source.yaml",
    ),
    {
      schemaVersion: 1,
      censusRoots: ["."],
      packageRoots: ["."],
      sourceRoots: ["src"],
      testRoots: ["tests"],
      excludedRoots: ["spikes"],
      toolingFiles: [],
    },
  );
  for (const roots of [["packages/*"], ["a".repeat(241)], ["packages/A", "packages/a"]]) {
    assert.throws(() =>
      projectQualitySourceTopology({ ...profile, productionRoots: roots }, "source.yaml"),
    );
  }
});

void test("FMS projection conforms to the separately owned Foundation neutral wire schema", async () => {
  const source = await readFile(
    new URL(
      "../packages/engineering-foundation/schemas/quality-source-topology/v1.schema.json",
      import.meta.url,
    ),
    "utf8",
  );
  const schema: unknown = JSON.parse(source);
  assert.ok(typeof schema === "object" && schema !== null && !Array.isArray(schema));
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
    Object.fromEntries(Object.entries(schema)),
  );
  for (const profile of [flat(), nested("v1.1")]) {
    assert.equal(
      validate(projectQualitySourceTopology(profile, "source.yaml")),
      true,
      JSON.stringify(validate.errors),
    );
  }
});
