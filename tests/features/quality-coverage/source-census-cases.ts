import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyQualityCensus,
  checkStaticQualityCoverage,
  qualitySourceLanguage,
} from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";
import { mapQualityTopology } from "../../../packages/engineering-foundation/dist/features/quality-coverage/adapters/profile-input.js";
import {
  fixture,
  moduleRoot,
  sourceRoot,
  main,
  topology,
  authority,
  censusReader,
} from "./source-observation-fixture.ts";
function registerOwnershipCases(): void {
  void test("independent nested/private census includes untracked and unclassified source without Git or workspace selection", async (t) => {
    const { put, census } = await fixture(t);
    await put("pnpm-workspace.yaml", "packages: ['packages/public/*']\n");
    await put(`${sourceRoot}/fixtures/production.test.ts`, "export const production = true;\n");
    await put(`${moduleRoot}/new-root/hidden.ts`, "export const hidden = true;\n");
    await put(`${moduleRoot}/tests/fixture.ts`, "export const fixture = true;\n");
    await put("packages/new-private/package.json", '{"name":"new-private","private":true}');
    await put("packages/new-private/src/new.mts", "export const extra = true;\n");
    const observed = await census();
    const classified = classifyQualityCensus({
      ...observed,
      topology,
      authority,
      suppressionRoots: [sourceRoot],
    });
    assert.deepEqual(classified.unclassifiedPackages, ["packages/new-private/package.json"]);
    assert.deepEqual(
      classified.sources.map(({ path }) => path),
      [
        `${moduleRoot}/new-root/hidden.ts`,
        `${sourceRoot}/fixtures/production.test.ts`,
        main,
        "packages/new-private/src/new.mts",
      ],
    );
    assert.ok(classified.sources[0]);
    assert.deepEqual(classified.sources[0].owners, []);
    assert.ok(classified.sources[1]);
    assert.deepEqual(classified.sources[1].owners, ["worker"]);
    const report = await checkStaticQualityCoverage(
      { consumerRoot: "/unused", configPath: "quality.yaml" },
      {
        read: async () => ({
          ...classified,
          routes: [],
          requiredRoutes: [],
          requiredSettings: [],
          requiredSettingObservations: [],
          settings: [],
        }),
      },
    );
    assert.equal(report.outcome, "violations");
    assert.ok(
      report.diagnostics.some(
        ({ ruleId, location }) =>
          ruleId === "quality.source-coverage.source-classification" &&
          location.path === "packages/new-private/src/new.mts",
      ),
    );
    assert.equal(qualitySourceLanguage("packages/new-private/src/new.mts"), "typescript");
  });

  void test("development ownership classifies external build tooling without hiding production or native source", async (t) => {
    const { put, census } = await fixture(t);
    const scriptsRoot = `${moduleRoot}/scripts`;
    const scripts = [
      "copy-runtime-assets.mjs",
      "docker-custody-init/build.mjs",
      "run-postgres-qualification.mjs",
      "dispatch-source-loader.mjs",
      "require-postgres-qualification.mjs",
      "build-native-helper.mjs",
    ].map((name) => `${scriptsRoot}/${name}`);
    for (const path of scripts) {
      await put(path, "export const build = () => 1;\n");
    }
    const observed = await census();
    const tooling = { id: "tooling", roots: [scriptsRoot], dependencyMode: "development" as const };
    const classify = (
      boundaries: Parameters<typeof classifyQualityCensus>[0]["authority"]["boundaries"],
      input = observed,
    ) =>
      classifyQualityCensus({
        ...input,
        topology,
        authority: { ...authority, boundaries },
        suppressionRoots: [sourceRoot, scriptsRoot],
      });
    assert.deepEqual(
      classify([...authority.boundaries, tooling]).sources.map(({ path }) => path),
      [main],
    );
    const ownershipCases: readonly [
      Parameters<typeof classifyQualityCensus>[0]["authority"]["boundaries"],
      readonly string[],
    ][] = [
      [authority.boundaries, []],
      [[...authority.boundaries, { id: "tooling", roots: [scriptsRoot] }], []],
      [[...authority.boundaries, { ...tooling, dependencyMode: "runtime" }], ["tooling"]],
    ];
    for (const [boundaries, expectedOwners] of ownershipCases) {
      const result = classify(boundaries);
      for (const path of scripts) {
        assert.deepEqual(
          result.sources.find((source) => source.path === path)?.owners,
          expectedOwners,
          path,
        );
      }
    }
    assert.ok(scripts[0]);
    const ambiguous = classify([
      ...authority.boundaries,
      tooling,
      { id: "other", roots: [scripts[0]], dependencyMode: "development" },
    ]);
    assert.deepEqual(ambiguous.sources.find(({ path }) => path === scripts[0])?.owners, []);
    const production = classify([
      { ...authority.boundaries[0], dependencyMode: "development" },
      tooling,
    ]);
    assert.deepEqual(
      production.sources.map(({ path }) => path),
      [main],
    );
    assert.ok(production.sources[0]);
    assert.deepEqual(production.sources[0].owners, ["worker"]);
    const native = `${scriptsRoot}/helper.c`;
    await put(native, "int helper(void) { return 0; }\n");
    const withNative = classify([...authority.boundaries, tooling], await census());
    assert.deepEqual(withNative.sources.find(({ path }) => path === native)?.owners, ["tooling"]);
    const report = await checkStaticQualityCoverage(
      { consumerRoot: "/unused", configPath: "quality.yaml" },
      {
        read: async () => ({
          ...withNative,
          routes: [],
          requiredRoutes: [],
          requiredSettings: [],
          requiredSettingObservations: [],
          settings: [],
        }),
      },
    );
    assert.ok(
      report.diagnostics.some(
        ({ ruleId, location }) =>
          ruleId === "quality.source-coverage.native-route" && location.path === native,
      ),
    );
  });
}

function registerTopologyOwnershipCases(): void {
  void test("runtime-owned adapters outside production roots remain in the authoritative census", () => {
    const path = "adapters/runtime/owned.mjs";
    const classified = classifyQualityCensus({
      sourcePaths: [path],
      filePaths: [path],
      manifestPaths: [],
      topology,
      authority: {
        ...authority,
        boundaries: [
          ...authority.boundaries,
          { id: "runtime-adapter", roots: ["adapters/runtime"], dependencyMode: "runtime" },
        ],
      },
      suppressionRoots: ["adapters/runtime"],
    });
    assert.deepEqual(classified.sources, [
      { path, owners: ["runtime-adapter"], suppressionCovered: true },
    ]);
  });

  void test("nested test and excluded roots take precedence over production roots", () => {
    const nestedTestRoot = `${sourceRoot}/tests`;
    const excludedRoot = `${sourceRoot}/generated`;
    const nestedTest = `${nestedTestRoot}/fixture.test.ts`;
    const excluded = `${excludedRoot}/generated.ts`;
    const excludedTestRoot = `${nestedTestRoot}/generated`;
    const excludedTest = `${excludedTestRoot}/fixture.test.ts`;
    const classified = classifyQualityCensus({
      sourcePaths: [main, nestedTest, excluded, excludedTest],
      filePaths: [main, nestedTest, excluded, excludedTest],
      manifestPaths: [],
      topology: {
        ...topology,
        excludedRoots: [excludedRoot, excludedTestRoot],
        modules: [{ ...topology.modules[0], testRoots: [nestedTestRoot] }],
      },
      authority,
      suppressionRoots: [sourceRoot],
    });
    assert.deepEqual(
      classified.sources.map(({ path }) => path),
      [main],
    );
    assert.deepEqual(classified.testPaths, [nestedTest]);
  });

  void test("nested application packages use exact production sources without promoting tests or scripts", async (t) => {
    const { root, put } = await fixture(t);
    const appRoot = "apps/app";
    const appSource = `${appRoot}/src`;
    const appMain = `${appSource}/main.ts`;
    const appTest = `${appRoot}/tests/main.test.ts`;
    const appScript = `${appRoot}/scripts/build.mjs`;
    for (const path of [appMain, appTest, appScript]) {
      await put(path, "export const value = 1;\n");
    }
    const profile = {
      schemaVersion: 1,
      authority: { id: "agent-teams.feature-module-standard", version: "v1" },
      scope: {
        workspaceContainers: ["packages"],
        productionRoots: [sourceRoot, appSource],
        productionModules: [
          { moduleRoot, sourceRoot, adoption: "pending" },
          { moduleRoot: appRoot, sourceRoot: appSource, adoption: "active" },
        ],
      },
      adoption: {
        applicationRoots: [appRoot],
        excludedRoots: [`${appRoot}/tests`],
        abstractLayout: { modules: [{ moduleRoot, sourceRoot, testRoot: `${moduleRoot}/tests` }] },
      },
    };
    const mapped = mapQualityTopology(profile, "source.yaml");
    assert.deepEqual(
      mapped.applicationRoots,
      [appRoot],
      "discovery retains application packages outside workspace containers",
    );
    assert.deepEqual(
      mapped.productionSourceRoots,
      [sourceRoot, appSource],
      "typed execution receives only production sources",
    );
    assert.deepEqual(
      mapped.modules.map(({ sourceRoot: path }) => path),
      [sourceRoot, appSource],
      "pending module sources remain covered",
    );
    assert.deepEqual(
      mapQualityTopology(
        {
          ...topology,
          schemaVersion: 1,
          standard: profile.authority,
          topology: { sourcePolicy: "source.yaml" },
        },
        "source.yaml",
      ),
      { ...topology, toolingFiles: [] },
      "flat source mappings remain unchanged",
    );
    const observed = await censusReader.read({
      consumerRoot: root,
      roots: [...mapped.productionRoots, ...mapped.applicationRoots],
    });
    assert.ok(
      observed.sourcePaths.includes(appTest),
      "independent discovery still sees application tests",
    );
    assert.ok(
      observed.sourcePaths.includes(appScript),
      "independent discovery still sees application scripts",
    );
    const classified = classifyQualityCensus({
      ...observed,
      topology: mapped,
      authority: {
        ...authority,
        boundaries: [
          ...authority.boundaries,
          { id: "app", roots: [appSource] },
          { id: "tooling", roots: [`${appRoot}/scripts`], dependencyMode: "development" },
        ],
      },
      suppressionRoots: [sourceRoot, appSource],
    });
    assert.deepEqual(
      classified.sources.map(({ path }) => path),
      [appMain, main],
    );
    assert.deepEqual(
      classified.sources.map(({ owners }) => owners),
      [["app"], ["worker"]],
    );
    assert.throws(
      () =>
        mapQualityTopology(
          { ...profile, scope: { ...profile.scope, productionRoots: [sourceRoot] } },
          "source.yaml",
        ),
      /application must map an existing production source root/u,
    );
  });
}

export function registerCensusCases(): void {
  registerOwnershipCases();
  registerTopologyOwnershipCases();
}
