import assert from "node:assert/strict";
import { qualityFixtureRecord } from "../../../scripts/quality-command-report.ts";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyPinnedToolchain } from "./copied-toolchain.mjs";
import { sourceRoot, main, compilerProject } from "./source-observation-fixture.ts";
import { qualifyNativeRoutes } from "./source-native-route-cases.ts";
import {
  runQualityCli,
  qualityReport,
  type QualityTextPut,
  type QualityCliInvoke,
  type QualityFixtureProfile,
} from "./quality-cli-fixture.ts";

export async function assertPublicQualityChecks({
  root,
  put,
  profile,
  scripts,
  lintBytes,
}: {
  root: string;
  put: QualityTextPut;
  profile: QualityFixtureProfile;
  scripts: Readonly<Record<string, string>>;
  lintBytes: string;
}) {
  // Exercise the built public command host with neutral topology and real schema/policy readers.
  await put("package.json", JSON.stringify({ name: "fixture-root", private: true, scripts }));
  await put("pnpm-workspace.yaml", "packages: ['packages/contexts/*']\n");
  const rootConfig = await writePublicQualityAuthorities(put);
  const cli = fileURLToPath(
    new URL("../../../packages/engineering-foundation/dist/cli.js", import.meta.url),
  );
  const invoke: QualityCliInvoke = (args, consumerRoot = root) =>
    runQualityCli(cli, consumerRoot, args);
  const staticResult = await invoke(["check", "quality.source-coverage"]);
  assert.equal(staticResult.code, 0, staticResult.stdout || staticResult.stderr);
  assert.equal(qualityReport(staticResult.stdout).outcome, "passed");
  const { nativePath, nativeProfile, nativeScript, nativeScripts } = await qualifyNativeRoutes({
    root,
    put,
    invoke,
    profile,
    scripts,
  });
  await assertInheritedPublicLintRules({ put, invoke, lintBytes });
  for (const compilerProjects of [
    [],
    null,
    ["missing.json"],
    [compilerProject, compilerProject],
    ["../outside.json"],
  ]) {
    await put(
      "toolchain.config.json",
      JSON.stringify({ typecheck: { projects: compilerProjects } }),
    );
    const invalid = await invoke(["check", "quality.source-coverage"]);
    assert.equal(invalid.code, 2, invalid.stdout || invalid.stderr);
    assert.notEqual(qualityReport(invalid.stdout).outcome, "passed");
  }
  await put(
    "toolchain.config.json",
    JSON.stringify({ typecheck: { projects: [compilerProject] } }),
  );
  const absentTools = await invoke(["quality", "check", "--scope-only"]);
  assert.equal(absentTools.code, 2, absentTools.stdout || absentTools.stderr);
  const failure = qualityReport(absentTools.stdout);
  assert.equal(failure.outcome, "invalid-input");
  assert.equal(failure.capabilities[0].problem!.code, "QUALITY_TOOLCHAIN_INVALID");
  assert.deepEqual(failure.capabilities[0].diagnostics, []);
  const devDependencies = await copyPinnedToolchain(root);
  await put(
    "package.json",
    JSON.stringify({ name: "fixture-root", private: true, scripts, devDependencies }),
  );
  await put(`${sourceRoot}/owned.d.ts`, "export declare const declared: number;\n");
  await put(`${sourceRoot}/build.mjs`, "export const build = () => 1;\n");
  await put(nativePath, "int helper(void) { return 0; }\n");
  await put(nativeScript, "throw new Error('native execution belongs to the consumer gate');\n");
  await put("quality.yaml", JSON.stringify(nativeProfile));
  await put(
    "package.json",
    JSON.stringify({
      name: "fixture-root",
      private: true,
      scripts: nativeScripts,
      devDependencies,
    }),
  );
  const scoped = await invoke(["quality", "check", "--scope-only"]);
  assert.equal(
    scoped.code,
    0,
    scoped.stdout || scoped.stderr || `code=${scoped.code};budget=30000`,
  );
  for (const args of [
    ["quality", "check", "--scope-only"],
    ["quality", "check"],
  ]) {
    const aliased = await invoke(args, `${root}-alias`);
    assert.equal(aliased.code, 0, aliased.stdout || aliased.stderr);
    assert.equal(qualityReport(aliased.stdout).outcome, "passed");
  }
  await assertPublicCompilerContexts({ root, put, invoke });
  const full = await invoke(["quality", "check"]);
  assert.equal(full.code, 0, full.stdout || full.stderr);
  await Promise.all([rm(join(root, nativePath)), rm(join(root, nativeScript))]);
  await put("quality.yaml", JSON.stringify(profile));
  await put(
    "package.json",
    JSON.stringify({ name: "fixture-root", private: true, scripts, devDependencies }),
  );
  await put(
    `${sourceRoot}/build.mjs`,
    Array.from({ length: 501 }, (_, index) => `export const value${index} = ${index};`).join("\n") +
      "\n",
  );
  const javascriptBad = await invoke(["quality", "check"]);
  assert.equal(javascriptBad.code, 1, javascriptBad.stdout || javascriptBad.stderr);
  assert.ok(
    qualityReport(javascriptBad.stdout).capabilities[0].diagnostics.some(
      ({ location, evidence }) =>
        location.path === `${sourceRoot}/build.mjs` &&
        evidence.some(({ value }) => value === "eslint(max-lines)"),
    ),
    javascriptBad.stdout,
  );
  await put(`${sourceRoot}/build.mjs`, "export const build = () => 1;\n");
  const javascriptGood = await invoke(["quality", "check"]);
  assert.equal(javascriptGood.code, 0, javascriptGood.stdout || javascriptGood.stderr);
  await put(main, "export const value = Promise.resolve(1);\nPromise.resolve(2);\n");
  const bad = await invoke(["quality", "check"]);
  assert.equal(bad.code, 1, bad.stdout || bad.stderr);
  const findings = qualityReport(bad.stdout).capabilities[0].diagnostics;
  assert.ok(
    findings.some(
      ({ location, evidence }) =>
        location.path === main &&
        evidence.some(({ value }) => value === "typescript(no-floating-promises)"),
    ),
    bad.stdout,
  );
  await put(main, "export const value = Promise.resolve(1);\nvoid Promise.resolve(2);\n");
  const corrected = await invoke(["quality", "check"]);
  assert.equal(corrected.code, 0, corrected.stdout || corrected.stderr);
  await put("foundation.config.yaml", JSON.stringify({ ...rootConfig, schemaVersion: 1 }));
  assert.equal(
    (await invoke(["quality", "check"])).code,
    2,
    "immutable root v1 must reject the new activation",
  );
}

async function writePublicQualityAuthorities(put: QualityTextPut) {
  await put(
    "source.yaml",
    JSON.stringify({
      schemaVersion: 3,
      workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
      packageRoots: ["packages/contexts"],
      governedRoots: [sourceRoot],
      boundaries: [
        {
          id: "worker",
          roots: [sourceRoot],
          entrypoints: [main],
          allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] },
        },
      ],
    }),
  );
  await put(
    "suppressions.yaml",
    JSON.stringify({
      schemaVersion: 1,
      governedRoots: [sourceRoot],
      nonWaivableRulePrefixes: [],
      waivers: [],
    }),
  );
  const rootConfig = {
    schemaVersion: 2,
    project: { id: "fixture" },
    capabilities: {
      "quality.source-coverage": { configPath: "quality.yaml" },
    },
  };
  await put("foundation.config.yaml", JSON.stringify(rootConfig));
  return rootConfig;
}

async function assertInheritedPublicLintRules({
  put,
  invoke,
  lintBytes,
}: {
  put: QualityTextPut;
  invoke: QualityCliInvoke;
  lintBytes: string;
}): Promise<void> {
  const lint = qualityFixtureRecord(JSON.parse(lintBytes));
  const strongerConfig = {
    ...lint,
    rules: {
      ...qualityFixtureRecord(lint["rules"]),
      "typescript/no-unsafe-type-assertion": "error",
    },
  };
  await put("lint.json", JSON.stringify(strongerConfig));
  const strongerResult = await invoke(["check", "quality.source-coverage"]);
  assert.equal(strongerResult.code, 0, strongerResult.stdout || strongerResult.stderr);
  await put("protected-base.json", JSON.stringify(strongerConfig));
  await put(
    "lint.json",
    JSON.stringify({
      extends: ["./protected-base.json"],
      overrides: [
        {
          files: [`${sourceRoot}/**`],
          rules: { "typescript/no-floating-promises": "off" },
        },
      ],
    }),
  );
  const weakenedGroup = await invoke(["check", "quality.source-coverage"]);
  assert.equal(weakenedGroup.code, 1, weakenedGroup.stdout || weakenedGroup.stderr);
  assert.ok(
    qualityReport(weakenedGroup.stdout).capabilities[0].diagnostics.some(
      ({ ruleId, location, subject }) =>
        ruleId === "quality.source-coverage.protected-setting" &&
        location.path === "lint.json" &&
        subject === "typescript/no-floating-promises",
    ),
  );
  await put("lint.json", lintBytes);
}

async function assertPublicCompilerContexts({
  root,
  put,
  invoke,
}: {
  root: string;
  put: QualityTextPut;
  invoke: QualityCliInvoke;
}): Promise<void> {
  const projectBytes = await readFile(join(root, compilerProject), "utf8");
  await put(
    compilerProject,
    JSON.stringify({
      ...qualityFixtureRecord(JSON.parse(projectBytes)),
      include: ["../missing/**/*.ts"],
    }),
  );
  const absentContext = await invoke(["quality", "check", "--scope-only"]);
  assert.equal(absentContext.code, 3, absentContext.stdout || absentContext.stderr);
  assert.equal(qualityReport(absentContext.stdout).outcome, "failed");
  assert.deepEqual(qualityReport(absentContext.stdout).capabilities[0].diagnostics, []);
  await put(compilerProject, `// Accepted compiler JSONC input\n${projectBytes}`);
  const validJsonc = await invoke(["quality", "check", "--scope-only"]);
  assert.equal(validJsonc.code, 0, validJsonc.stdout || validJsonc.stderr);
  await put(compilerProject, "{ invalid JSONC");
  const malformed = await invoke(["quality", "check", "--scope-only"]);
  assert.equal(malformed.code, 3, malformed.stdout || malformed.stderr);
  assert.equal(qualityReport(malformed.stdout).outcome, "failed");
  assert.deepEqual(qualityReport(malformed.stdout).capabilities[0].diagnostics, []);
  await put(compilerProject, `// Restored compiler JSONC input\n${projectBytes}`);
}
