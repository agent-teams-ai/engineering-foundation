import { qualitySessionFixture } from "./quality-session-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { symlink } from "node:fs/promises";
import {
  classifyQualityCensus,
  checkStaticQualityCoverage,
  qualitySourceLanguage,
} from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";
import {
  qualityScriptCommand,
  qualityString,
} from "../../../packages/engineering-foundation/dist/features/quality-coverage/adapters/profile-input.js";
import {
  fixture,
  moduleRoot,
  sourceRoot,
  main,
  topology,
  authority,
} from "./source-observation-fixture.ts";
export function registerDiscoveryCases(): void {
  void test("native and unknown files inside owned source cannot disappear at discovery", async (t) => {
    const { put, census } = await fixture(t);
    await put(`${sourceRoot}/README.md`, "# Source documentation\n");
    for (const name of ["native.c", "native.h", "unknown.future"]) {
      await put(`${sourceRoot}/${name}`, "source input\n");
    }
    const observed = await census();
    const classified = classifyQualityCensus({
      ...observed,
      topology,
      authority,
      suppressionRoots: [sourceRoot],
    });
    assert.ok(observed.filePaths.includes(`${sourceRoot}/README.md`));
    assert.ok(!classified.sources.some(({ path }) => path === `${sourceRoot}/README.md`));
    const report = await checkStaticQualityCoverage(
      { consumerRoot: "/unused", configPath: "quality.yaml" },
      {
        read: async () =>
          qualitySessionFixture({
            ...classified,
            routes: [],
            requiredRoutes: [],
            requiredSettings: [],
            requiredSettingObservations: [],
            settings: [],
          }),
      },
    );
    for (const name of ["native.c", "native.h", "unknown.future"]) {
      assert.ok(observed.filePaths.includes(`${sourceRoot}/${name}`));
      const expectedRule = name === "unknown.future" ? "source-language" : "native-route";
      assert.ok(
        report.diagnostics.some(
          ({ ruleId, location }) =>
            ruleId === `quality.source-coverage.${expectedRule}` &&
            location.path === `${sourceRoot}/${name}`,
        ),
      );
    }
  });

  void test("declared compiler JSON does not hide adjacent files or independently discovered source", async (t) => {
    const { put, census } = await fixture(t);
    const config = `${sourceRoot}/tsconfig.json`;
    const adjacent = `${sourceRoot}/data.json`;
    const protectedPaths = [
      main,
      ...["build.mjs", "helper.c", "helper.h"].map((name) => `${sourceRoot}/${name}`),
    ];
    for (const path of [config, adjacent, ...protectedPaths]) {
      await put(path, "{}\n");
    }
    const observed = await census();
    const input = {
      ...observed,
      topology,
      authority,
      suppressionRoots: [sourceRoot],
      compilerProjects: [config, ...protectedPaths],
    };
    const classified = classifyQualityCensus(input);
    assert.ok(observed.filePaths.includes(config));
    assert.deepEqual(classified.compilerConfigPaths, [config]);
    assert.ok(!classified.sources.some(({ path }) => path === config));
    for (const path of [adjacent, ...protectedPaths]) {
      assert.ok(
        classified.sources.some((source) => source.path === path),
        path,
      );
    }
    const report = await checkStaticQualityCoverage(
      { consumerRoot: "/unused", configPath: "quality.yaml" },
      {
        read: async () =>
          qualitySessionFixture({
            ...classified,
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
          ruleId === "quality.source-coverage.source-language" && location.path === adjacent,
      ),
    );
    const explicit = classifyQualityCensus({
      ...input,
      sourcePaths: [...observed.sourcePaths, config],
    });
    assert.ok(explicit.sources.some(({ path }) => path === config));
    assert.deepEqual(explicit.compilerConfigPaths, []);
  });

  void test("native package roots outside src require consumer classification", async (t) => {
    const { put, census } = await fixture(t);
    const native = `${moduleRoot}/native/helper.c`;
    const header = `${moduleRoot}/native/helper.h`;
    const harness = `${moduleRoot}/tests/harness.c`;
    for (const path of [native, header, harness]) {
      await put(path, "/* source */\n");
    }
    const observed = await census();
    const input = { ...observed, topology, authority, suppressionRoots: [sourceRoot] };
    const unclassified = classifyQualityCensus(input);
    assert.deepEqual(
      unclassified.sources.map(({ path }) => path),
      [native, header, main],
    );
    assert.notEqual(unclassified.sources[0], undefined);
    assert.deepEqual(unclassified.sources[0].owners, []);
    const nativeRoot = `${moduleRoot}/native`;
    const classified = classifyQualityCensus({
      ...input,
      topology: { ...topology, sourceRoots: [...topology.sourceRoots, nativeRoot] },
      authority: {
        ...authority,
        boundaries: [...authority.boundaries, { id: "native", roots: [nativeRoot] }],
      },
      suppressionRoots: [sourceRoot, nativeRoot],
    });
    assert.notEqual(classified.sources[0], undefined);
    assert.deepEqual(classified.sources[0].owners, ["native"]);
    assert.equal(classified.sources[0].suppressionCovered, true);
    assert.ok(!classified.sources.some(({ path }) => path === harness));
  });

  registerDeclarationAndSymlinkCases();
}

function registerDeclarationAndSymlinkCases(): void {
  void test("owned TypeScript declarations remain in the independent production census", async (t) => {
    const { put, census } = await fixture(t);
    const declarations = [
      `${sourceRoot}/public.d.ts`,
      `${sourceRoot}/public.d.mts`,
      `${sourceRoot}/public.d.cts`,
    ];
    for (const declaration of declarations) {
      await put(declaration, "export declare const value: number;\n");
    }
    const classified = classifyQualityCensus({
      ...(await census()),
      topology,
      authority,
      suppressionRoots: [sourceRoot],
    });
    assert.deepEqual(
      classified.sources.map(({ path }) => path),
      [main, ...declarations].toSorted(),
    );
    for (const declaration of declarations) {
      const source = classified.sources.find(({ path }) => path === declaration);
      assert.deepEqual(source?.owners, ["worker"]);
      assert.equal(source.suppressionCovered, true);
      assert.equal(qualitySourceLanguage(declaration), "typescript");
    }
    for (const extension of ["ts", "tsx", "mts", "cts"]) {
      assert.equal(qualitySourceLanguage(`${sourceRoot}/entry.${extension}`), "typescript");
    }
  });

  void test("pure module markers cannot hide nested dist source and source symlinks reject", async (t) => {
    const { root, put, census } = await fixture(t);
    await put(`${moduleRoot}/dist/output.js`, "export const built = 1;\n");
    await put(`${sourceRoot}/marker/package.json`, '{"type":"module"}');
    const nested = `${sourceRoot}/marker/dist/source.ts`;
    await put(nested, "export const source = 1;\n");
    assert.deepEqual((await census()).sourcePaths, [main, nested]);
    await symlink(join(root, main), join(root, sourceRoot, "linked.ts"));
    await assert.rejects(census(), /symbolic link/u);
  });
}

export function registerTopologyCases(): void {
  void test("package script command bounds use UTF-8 bytes without widening profile paths", () => {
    assert.equal(qualityScriptCommand("a".repeat(16384)).length, 16384);
    assert.equal(qualityScriptCommand("é".repeat(8192)).length, 8192);
    assert.equal(qualityScriptCommand("a".repeat(2061)).length, 2061);
    for (const value of [undefined, null, 1, {}, "", "a".repeat(16385), "é".repeat(8192) + "a"]) {
      assert.throws(() => qualityScriptCommand(value), /16384 UTF-8 bytes/u);
    }
    assert.equal(qualityString("a".repeat(1024)).length, 1024);
    assert.throws(() => qualityString("a".repeat(1025)), /bounded nonempty string/u);
  });
}
