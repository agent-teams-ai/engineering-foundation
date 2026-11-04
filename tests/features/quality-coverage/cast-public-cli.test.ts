import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import {
  runQualityCli,
  qualityReport,
  type QualityFixturePut,
  type QualityFixtureProfile,
} from "./quality-cli-fixture.ts";
import {
  cli,
  repository,
  governedDistFixture,
  preparePublicCastFixture,
} from "./source-cast-fixture.ts";
import type { QualityFixtureReport } from "../../../scripts/quality-command-report.ts";

async function assertUnreadableGovernedSource({
  t,
  root,
  dist,
  path,
  invoke,
}: {
  t: TestContext;
  root: string;
  dist: string;
  path: string;
  invoke: () => Promise<{ code: number; report: QualityFixtureReport }>;
}): Promise<void> {
  await t.test(
    "unreadable declared directory rejects after a real EACCES probe",
    async (permission) => {
      await chmod(join(root, dist), 0);
      try {
        let denied;
        try {
          await readdir(join(root, dist));
        } catch (error) {
          denied = error instanceof Error && "code" in error ? error.code : undefined;
        }
        if (denied === undefined) {
          permission.skip("process bypasses directory permissions");
          return;
        }
        assert.equal(denied, "EACCES");
        const rejected = await invoke();
        assert.equal(rejected.code, 2, JSON.stringify(rejected));
        assert.equal(rejected.report.capabilities[0].problem!.code, "SOURCE_DIRECTORY_UNAVAILABLE");
        assert.ok(rejected.report.capabilities[0].problem!.message.includes(dist));
      } finally {
        await chmod(join(root, dist), 0o755);
      }
    },
  );
  await t.test(
    "unreadable declared file rejects as invalid input after EACCES",
    async (permission) => {
      await chmod(join(root, path), 0);
      try {
        let denied;
        try {
          await readFile(join(root, path));
        } catch (error) {
          denied = error instanceof Error && "code" in error ? error.code : undefined;
        }
        if (denied === undefined) {
          permission.skip("process bypasses file permissions");
          return;
        }
        assert.equal(denied, "EACCES");
        const rejected = await invoke();
        assert.equal(rejected.code, 2, JSON.stringify(rejected));
        assert.equal(rejected.report.outcome, "invalid-input");
        assert.equal(
          rejected.report.capabilities[0].diagnostics.length,
          0,
          "unreadable observed input cannot become compiler coverage evidence",
        );
      } finally {
        await chmod(join(root, path), 0o644);
      }
    },
  );
}

async function assertLegacyProfileRejected(
  put: QualityFixturePut,
  invoke: () => Promise<{ code: number; report: QualityFixtureReport }>,
  profile: QualityFixtureProfile,
): Promise<void> {
  assert.equal(
    createHash("sha256")
      .update(
        await readFile(
          join(
            repository,
            "packages/engineering-foundation/schemas/quality-source-coverage/v1.schema.json",
          ),
        ),
      )
      .digest("hex"),
    "a5987fbc1d0686dc260aa2b7cc062aa2d0581de7deb1d7739b4d1d8cf1f76fb9",
  );
  await put("toolchain.config.json", { typecheck: { projects: ["config/production.json"] } });
  await put("quality.yaml", { ...profile, schemaVersion: 1, bridgeAdmissionsPath: "bridges.json" });
  const v1Admission = await invoke();
  assert.equal(v1Admission.code, 2, JSON.stringify(v1Admission.report));
  assert.equal(v1Admission.report.outcome, "invalid-input");
  assert.equal(v1Admission.report.capabilities[0].capabilityConfigSchemaVersion, 1);
}

void test("public quality check reopens declared production and runtime dist source", async (t) => {
  const { root, put, invoke } = await governedDistFixture(t);
  const src = "packages/worker/src";
  const dist = "packages/worker/dist";
  const path = `${dist}/escape.ts`;
  const clean =
    'interface Trusted { readonly marker: "trusted" }\nexport const value: Trusted = { marker: "trusted" };\n';
  const bridge =
    'interface Trusted { readonly marker: "trusted" }\nexport const value = "unsafe" as unknown as Trusted;\n';
  const allow = { boundaries: [], packages: [], builtins: [], runtimeReferences: [] };
  const source = {
    schemaVersion: 2,
    workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
    packageRoots: ["packages"],
    governedRoots: [src, dist],
    boundaries: [{ id: "worker", roots: [src], entrypoints: [`${src}/main.ts`], allow }],
  };
  const topology = {
    schemaVersion: 1,
    censusRoots: ["packages"],
    packageRoots: [".", "packages/worker"],
    sourceRoots: [src],
    testRoots: ["packages/worker/tests"],
    excludedRoots: [],
    toolingFiles: [],
  };
  for (const [name, sourceRoot, roots, dependencyMode] of [
    ["runtime directory", src, [dist], "runtime"],
    ["runtime file with default mode", src, [path], undefined],
    ["production directory with development owner", dist, [dist], "development"],
  ] as const) {
    await t.test(name, async () => {
      await put("topology.json", {
        ...topology,
        sourceRoots: [sourceRoot],
      });
      await put("source.yaml", {
        ...source,
        boundaries: [
          ...source.boundaries,
          {
            id: "dist-source",
            roots,
            entrypoints: [path],
            allow,
            ...(dependencyMode === undefined ? {} : { dependencyMode }),
          },
        ],
      });
      await put(path, clean);
      const valid = await invoke(["check", "architecture.source-dependencies"]);
      assert.deepEqual(
        { code: valid.code, outcome: valid.report.outcome },
        { code: 0, outcome: "passed" },
        JSON.stringify(valid),
      );
      const counterpart = await invoke();
      assert.deepEqual(
        { code: counterpart.code, outcome: counterpart.report.outcome },
        { code: 0, outcome: "passed" },
        JSON.stringify(counterpart),
      );
      await put(path, bridge);
      const rejected = await invoke();
      assert.equal(rejected.code, 1, JSON.stringify(rejected));
      assert.equal(rejected.report.outcome, "violations");
      assert.ok(
        rejected.report.capabilities[0].diagnostics.some(
          ({ ruleId, location }) =>
            ruleId === "quality.source-coverage.explicit-unknown" && location.path === path,
        ),
        JSON.stringify(rejected),
      );
      assert.deepEqual(await invoke(), rejected, "diagnostics remain deterministic");
      assert.equal(
        (await invoke(["quality", "check", "--scope-only"])).code,
        0,
        "scope does not run bridge policy",
      );
    });
  }
  await put("topology.json", topology);
  await put("source.yaml", {
    ...source,
    boundaries: [
      ...source.boundaries,
      { id: "dist-source", roots: [dist], entrypoints: [path], allow, dependencyMode: "runtime" },
    ],
  });
  await put(path, clean);
  await assertUnreadableGovernedSource({ t, root, dist, path, invoke });
  await put(path, bridge);
  await put("source.yaml", { ...source, governedRoots: [src] });
  const generated = await invoke();
  assert.deepEqual(
    { code: generated.code, outcome: generated.report.outcome },
    { code: 0, outcome: "passed" },
    JSON.stringify(generated),
  );
  await put("source.yaml", {
    ...source,
    boundaries: [
      ...source.boundaries,
      { id: "dist-source", roots: [dist], entrypoints: [path], allow, dependencyMode: "runtime" },
    ],
  });
  await rm(join(root, dist), { recursive: true });
  const missing = await invoke();
  assert.equal(missing.code, 2, JSON.stringify(missing));
  assert.equal(missing.report.capabilities[0].problem!.code, "SOURCE_DIRECTORY_UNAVAILABLE");
  assert.ok(missing.report.capabilities[0].problem!.message.includes(dist));
});

void test("built public quality check rejects unknown chains and accepts exact evidence-bound bridges", async () => {
  const root = await mkdtemp(join(tmpdir(), "ef-331-public-quality-TEST-"));
  try {
    const put: QualityFixturePut = async (path, value) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, typeof value === "string" ? value : JSON.stringify(value));
    };
    const { main, sourceRoot, profile } = await preparePublicCastFixture(root, put);
    const cast =
      'interface Trusted { readonly marker: "trusted" }\nexport const value = "unsafe" as unknown as Trusted;\n';
    const invoke = async (entrypoint = cli, scopeOnly = false) => {
      const result = await runQualityCli(entrypoint, root, [
        "quality",
        "check",
        ...(scopeOnly ? ["--scope-only"] : []),
      ]);
      return { code: result.code, stdout: result.stdout, report: qualityReport(result.stdout) };
    };
    await put(`${sourceRoot}/baseline.mjs`, "export const javascriptValue = 1;\n");
    await put(main, cast);
    const unadmitted = await invoke();
    assert.equal(unadmitted.code, 1, JSON.stringify(unadmitted.report));
    assert.ok(
      unadmitted.report.capabilities[0].diagnostics.some(
        ({ ruleId, location }) =>
          ruleId === "quality.source-coverage.explicit-unknown" && location.path === main,
      ),
    );
    assert.equal((await invoke(cli, true)).code, 0);
    const tuple =
      "export const value = [[1], [1, 2]].flat() as unknown as readonly [number, number, number];\n";
    await put(main, tuple);
    const chain = "[[1], [1, 2]].flat() as unknown as readonly [number, number, number]";
    const start = tuple.indexOf(chain);
    const bridge = {
      path: main,
      start,
      end: start + chain.length,
      sha256: createHash("sha256").update(chain).digest("hex"),
      rationale: "Array.flat preserves tuple order and duplicates; readonly is type only.",
      rejectingTest: "tests/bridge-rejection.test.mjs",
    };
    await put(
      "tests/bridge-rejection.test.mjs",
      'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("flat tuple order and duplicates", () => {\n  assert.deepEqual([[1], [1, 2]].flat(), [1, 1, 2]);\n  assert.notDeepEqual([[1], [1, 2]].flat(), [1, 2]);\n});\n',
    );
    await promisify(execFile)(process.execPath, ["--test", "tests/bridge-rejection.test.mjs"], {
      cwd: root,
    });
    await put("bridges.json", { schemaVersion: 1, bridges: [bridge] });
    await assertLegacyProfileRejected(put, invoke, profile);
    await put("toolchain.config.json", { typecheck: { projects: ["config/production.json"] } });
    await put("quality.yaml", { ...profile, bridgeAdmissionsPath: "bridges.json" });
    assert.equal((await invoke()).code, 0);
    await put("bridges.json", {
      schemaVersion: 1,
      bridges: [{ ...bridge, rejectingTest: "tests/bridge-proof.json" }],
    });
    await put("tests/bridge-proof.json", { evidence: "independently audited test pointer" });
    assert.equal((await invoke()).code, 0);
    await put("bridges.json", { schemaVersion: 1, bridges: [bridge] });
    await put("bridges.json", { schemaVersion: 1, bridges: [bridge, bridge] });
    assert.equal((await invoke()).code, 2);
    await put("bridges.json", {
      schemaVersion: 1,
      bridges: [{ ...bridge, sha256: "0".repeat(64) }],
    });
    assert.equal((await invoke()).code, 2);
    await put("bridges.json", { schemaVersion: 1, bridges: [bridge] });
    const variants = [
      'type Alias = Trusted; export const value = (("unsafe" as /* bridge */ unknown)!) satisfies unknown as Alias;\n',
      'type Alias = Trusted; export const value = <Alias>(<unknown>"unsafe");\n',
      'type Alias = Trusted; export const value = ("unsafe" as (unknown)) as Alias;\n',
    ];
    for (const variant of variants) {
      await put(main, `interface Trusted { readonly marker: "trusted" }\n${variant}`);
      assert.equal((await invoke()).code, 2); // The old exact record is stale.
      await put("bridges.json", { schemaVersion: 1, bridges: [] });
      const rejectedVariant = await invoke();
      assert.equal(rejectedVariant.code, 1, JSON.stringify(rejectedVariant.report));
      assert.ok(
        rejectedVariant.report.capabilities[0].diagnostics.some(
          ({ ruleId }) => ruleId === "quality.source-coverage.explicit-unknown",
        ),
      );
      await put("bridges.json", { schemaVersion: 1, bridges: [bridge] });
    }
    await put("bridges.json", { schemaVersion: 1, bridges: [] });
    await put(main, "export const value = (1 as unknown) as unknown;\n");
    const widened = await invoke();
    assert.ok(
      !widened.report.capabilities[0].diagnostics.some(
        ({ ruleId }) => ruleId === "quality.source-coverage.explicit-unknown",
      ),
    );
    await put(
      main,
      'interface Trusted { readonly marker: "trusted" }\nexport const value: Trusted = { marker: "trusted" };\nPromise.resolve(1);\n',
    );
    const rejected = await invoke();
    assert.equal(rejected.code, 1);
    assert.ok(
      rejected.report.capabilities[0].diagnostics.some(
        ({ location, evidence }) =>
          location.path === main &&
          evidence.some(({ value }) => value === "typescript(no-floating-promises)"),
      ),
    );
    await put(
      main,
      'interface Trusted { readonly marker: "trusted" }\nexport const value: Trusted = { marker: "trusted" };\n',
    );
    assert.equal((await invoke()).code, 0);
    await put("toolchain.config.json", { typecheck: { projects: ["config/production.json"] } });
    await put("quality.yaml", profile);
    assert.equal((await invoke()).code, 0);
    await put("lint.json", {
      options: { respectEslintDisableDirectives: false, reportUnusedDisableDirectives: "error" },
      extends: [
        "./node_modules/stack-toolchain/presets/oxlint/type-aware.json",
        "./node_modules/stack-toolchain/presets/oxlint/maintainability.json",
      ],
      jsPlugins: ["./plugin.mjs"],
    });
    const unsupportedPlugin = await invoke();
    assert.equal(unsupportedPlugin.code, 2);
    assert.match(
      JSON.stringify(unsupportedPlugin.report),
      /Executable Oxlint plugins are outside this qualified configuration form/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("only installed language preset may disable type-only JavaScript assignments", async (t) => {
  const { inspectProtectedConfig } =
    await import("../../../packages/engineering-foundation/dist/features/quality-coverage/adapters/protected-config.js");
  const root = await mkdtemp(join(tmpdir(), "TEST-protected-js-preset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, "node_modules/stack-toolchain");
  await mkdir(join(installed, "presets/oxlint"), { recursive: true });
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(
    join(installed, "package.json"),
    JSON.stringify({ name: "stack-toolchain", exports: { "./package.json": "./package.json" } }),
  );
  const override = {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    rules: { "typescript/no-floating-promises": "off" },
  };
  const typed = {
    rules: { "typescript/no-floating-promises": "error" },
    options: { typeAware: true },
    overrides: [override],
  };
  const lint = {
    extends: ["./node_modules/stack-toolchain/presets/oxlint/type-aware.json"],
    options: { respectEslintDisableDirectives: false, reportUnusedDisableDirectives: "error" },
  };
  await writeFile(join(installed, "presets/oxlint/maintainability.json"), '{"rules":{}}');
  const put = async (value: unknown) =>
    writeFile(join(installed, "presets/oxlint/type-aware.json"), JSON.stringify(value));
  await put(typed);
  await writeFile(join(root, "lint.json"), JSON.stringify(lint));
  const reader = async (base: string, path: string) => {
    assert.ok(base.includes(root.split("/").at(-1)!));
    const value: unknown = JSON.parse(await readFile(join(base, path), "utf8"));
    return value;
  };
  for (const files of [["src.ts"], ["src.ts", "legacy.js"]]) {
    const result = await inspectProtectedConfig(root, "lint.json", reader, {
      files,
      production: files,
      tests: [],
    });
    assert.ok(result.settings.every((setting) => setting.actual !== "off"));
  }
  for (const bad of [
    { ...override, files: ["**/*.ts"] },
    { ...override, rules: { complexity: "off" } },
  ]) {
    await put({ ...typed, overrides: [bad] });
    await assert.rejects(
      inspectProtectedConfig(root, "lint.json", reader, {
        files: ["src.ts"],
        production: ["src.ts"],
        tests: [],
      }),
    );
  }
  await put(typed);
  await writeFile(join(root, "lint.json"), JSON.stringify({ ...lint, overrides: [override] }));
  await assert.rejects(
    inspectProtectedConfig(root, "lint.json", reader, {
      files: ["src.ts"],
      production: ["src.ts"],
      tests: [],
    }),
    /no observed files/u,
  );
  const active = await inspectProtectedConfig(root, "lint.json", reader, {
    files: ["src.ts", "legacy.js"],
    production: ["src.ts", "legacy.js"],
    tests: [],
  });
  assert.ok(
    active.settings.some((setting) => setting.actual === "off" && setting.expected === "error"),
  );
});
