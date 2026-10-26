import {
  assertUnknownCastRejected,
  assertTypecheckPassed,
  assertMissingTypeDiagnostic,
  qualifyLintProtections,
  qualifyMissingDeclaration,
  qualifyMissingInstalledOxlint,
} from "./packed-quality-lint-protections.ts";
import { writeQualityLayout } from "./packed-quality-layout.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { runCommand } from "./pack-test-support.mjs";
import {
  inspectCompressedTarArchive,
  readRegularArchive,
  sha256,
} from "./pack-artifact-archive.mjs";
import { copyInstalledClosure } from "./pack-quality-closure.mjs";
import { qualifyPackedQualityAssets } from "./pack-quality-assets.ts";

export { copyInstalledClosure };

/** Reuse the installed archive closure in an isolated consumer, never the source installation. */
export async function assertInstalledQualityArtifact({ consumerRoot, artifact }) {
  const bytes = await readRegularArchive(artifact.archivePath);
  assert.equal(sha256(bytes), artifact.sha256, "Packed quality archive identity changed");
  const installed = await realpath(
    join(consumerRoot, "node_modules/@agent-teams/engineering-foundation"),
  );
  const entries = inspectCompressedTarArchive(bytes, artifact.packageName).entries;
  for (const entry of entries) {
    if (entry.type !== "0") {
      continue;
    }
    assert.ok(entry.name.startsWith("package/"));
    const suffix = entry.name.slice("package/".length);
    const path = join(installed, suffix);
    const relativePath = relative(installed, path);
    assert.ok(!isAbsolute(relativePath) && relativePath.split(/[\\/]/u)[0] !== "..");
    assert.ok((await readFile(path)).equals(entry.data), "Installed candidate differs: " + suffix);
  }
}

export async function testPackedQualityCoverage({ consumerRoot, artifact }) {
  await assertInstalledQualityArtifact({ consumerRoot, artifact });
  const installed = join(consumerRoot, "node_modules/@agent-teams/engineering-foundation");
  for (const id of ["foundation-config/v3", "quality-format-coverage/v1"]) {
    const expected = await readFile(join(installed, `schemas/${id}.schema.json`), "utf8");
    const actual = await runCommand(
      process.execPath,
      [join(installed, "dist/cli.js"), "schema", id],
      consumerRoot,
    );
    assert.equal(actual.stdout, expected, `Installed public schema load differs: ${id}`);
  }
  const flat = await qualifyLayout({ consumerRoot, nested: false, artifact });
  const nested = await qualifyLayout({ consumerRoot, nested: true, artifact });
  return { outcome: "passed", consumers: [flat, nested] };
}

async function qualifyLayout({ consumerRoot, nested, artifact }) {
  const root = join(
    dirname(consumerRoot),
    nested ? "quality coverage nested consumer" : "quality coverage flat consumer",
  );
  await mkdir(root, { recursive: true });
  const physicalRoot = await realpath(root);
  await copyInstalledClosure(join(consumerRoot, "node_modules"), join(root, "node_modules"));
  await assertInstalledQualityArtifact({ consumerRoot: root, artifact });
  if (!nested) {
    const schema = join(
      root,
      "node_modules/@agent-teams/engineering-foundation/schemas/foundation-config/v2.schema.json",
    );
    const original = await readFile(schema);
    try {
      await writeFile(schema, "{}\n");
      await assert.rejects(assertInstalledQualityArtifact({ consumerRoot: root, artifact }), {
        code: "ERR_ASSERTION",
        message: "Installed candidate differs: schemas/foundation-config/v2.schema.json",
      });
    } finally {
      await writeFile(schema, original);
    }
    await assertInstalledQualityArtifact({ consumerRoot: root, artifact });
  }
  const put = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(
      join(root, path),
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
  };
  const devDependencies = {};
  for (const name of ["@agent-teams/engineering-foundation", "stack-toolchain"]) {
    const manifestPath = await realpath(join(root, "node_modules", name, "package.json"));
    const suffix = relative(physicalRoot, manifestPath);
    assert.ok(
      !isAbsolute(suffix) && !suffix.startsWith(".."),
      `Packed dependency escapes consumer: ${name}`,
    );
    devDependencies[name] = JSON.parse(await readFile(manifestPath, "utf8")).version;
  }
  const { moduleRoot, sourceRoot, main, scripts, activation } = await writeQualityLayout({
    nested,
    devDependencies,
    put,
  });
  const cli = join(root, "node_modules/@agent-teams/engineering-foundation/dist/cli.js");
  const invoke = async (args, code = 0) => {
    let result;
    try {
      result = {
        code: 0,
        ...(await runCommand(
          process.execPath,
          [cli, ...args, "--consumer", root, "--format", "json"],
          root,
        )),
      };
    } catch (error) {
      result = error;
    }
    assert.equal(result.code, code, result.stdout || result.stderr || result.message);
    return JSON.parse(result.stdout);
  };
  assert.equal((await invoke(["check", "quality.source-coverage"])).outcome, "passed");
  assert.equal((await invoke(["quality", "check", "--scope-only"])).outcome, "passed");
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  const tuple = "export const values = [1, 2] as unknown as readonly [number, number];\n";
  await put(main, tuple);
  const castRejected = await invoke(["quality", "check"], 1);
  assertUnknownCastRejected(castRejected, main);
  const expression = "[1, 2] as unknown as readonly [number, number]";
  const start = tuple.indexOf(expression);
  await put(
    "tests/tuple-rejection.test.mjs",
    `import assert from "node:assert/strict";\nimport test from "node:test";\ntest("tuple representation preserves order and duplicates", () => {\n  assert.deepEqual([[1], [1, 2]].flat(), [1, 1, 2]);\n  assert.notDeepEqual([[1], [1, 2]].flat(), [1, 2]);\n});\n`,
  );
  await runCommand(process.execPath, ["--test", "tests/tuple-rejection.test.mjs"], root);
  await put("bridges.json", {
    schemaVersion: 1,
    bridges: [
      {
        path: main,
        start,
        end: start + expression.length,
        sha256: createHash("sha256").update(expression).digest("hex"),
        rationale: "Exact tuple representation retains array order and duplicate values.",
        rejectingTest: "tests/tuple-rejection.test.mjs",
      },
    ],
  });
  const qualified = JSON.parse(await readFile(join(root, "quality.yaml"), "utf8"));
  await put("quality.yaml", {
    ...qualified,
    schemaVersion: 4,
    bridgeAdmissionsPath: "bridges.json",
  });
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await put("bridges.json", { schemaVersion: 1, bridges: [] });
  assert.equal((await invoke(["quality", "check"], 1)).outcome, "violations");
  await put("quality.yaml", qualified);
  await put(main, "export const value = 1;\n");
  await put(main, "export const value = 1;\nPromise.resolve(2);\n");
  const rejected = await invoke(["quality", "check"], 1);
  assert.ok(
    rejected.capabilities[0].diagnostics.some(
      ({ location, evidence }) =>
        location.path === main &&
        evidence.some(({ value }) => value === "typescript(no-floating-promises)"),
    ),
  );
  await put(
    main,
    "export const value = 1;\n// eslint-disable-next-line typescript/no-floating-promises\nPromise.resolve(2);\n",
  );
  const disabled = await invoke(["quality", "check"], 1);
  assert.ok(
    disabled.capabilities[0].diagnostics.some(({ evidence }) =>
      evidence.some(
        ({ kind, value }) => kind === "tool-rule" && value === "typescript(no-floating-promises)",
      ),
    ),
  );
  await put(main, "export const value = 1;\nvoid Promise.resolve(2);\n");
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  if (nested) {
    await qualifyPackedQualityAssets({ root, put, invoke, sourceRoot, boundaryId: "worker" });
    await qualifyNestedRejections({
      root,
      put,
      invoke,
      main,
      sourceRoot,
      moduleRoot,
      scripts,
      devDependencies,
      activation,
      invokeTypecheck: () => invokeInstalledTypecheck(root),
    });
  }
  return {
    outcome: "passed",
    consumerRoot: root,
    foundationVersion: devDependencies["@agent-teams/engineering-foundation"],
  };
}

async function qualifyNestedRejections({
  root,
  put,
  invoke,
  main,
  sourceRoot,
  moduleRoot,
  scripts,
  devDependencies,
  activation,
  invokeTypecheck,
}) {
  const qualityProfile = JSON.parse(await readFile(join(root, "quality.yaml"), "utf8"));
  await put("quality.yaml", { ...qualityProfile, nativeChecks: [] });
  const missingNative = await invoke(["quality", "check"], 1);
  for (const extension of ["c", "h"]) {
    assert.ok(
      missingNative.capabilities[0].diagnostics.some(
        ({ ruleId, location }) =>
          ruleId === "quality.source-coverage.native-route" &&
          location.path === `${moduleRoot}/native/helper.${extension}`,
      ),
    );
  }
  await put("quality.yaml", qualityProfile);
  // Keep the declared root available so this control reaches the stale mapping.
  const nativeFiles = ["helper.c", "helper.h"];
  for (const file of nativeFiles) {
    await rename(
      join(root, moduleRoot, "native", file),
      join(root, `${file}.qualification-backup`),
    );
  }
  try {
    const staleNative = await invoke(["check", "quality.source-coverage"], 2);
    assert.match(staleNative.capabilities[0].problem.message, /no current native source/u);
  } finally {
    for (const file of nativeFiles) {
      await rename(
        join(root, `${file}.qualification-backup`),
        join(root, moduleRoot, "native", file),
      );
    }
  }
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await put(main, 'export const value: number = JSON.parse("1");\n');
  const unsafe = await invoke(["quality", "check"], 1);
  assert.ok(
    unsafe.capabilities[0].diagnostics.some(
      ({ location, evidence }) =>
        location.path === main &&
        evidence.some(({ value }) => value === "typescript(no-unsafe-assignment)"),
    ),
  );
  await put(main, "export const value: number = 1;\n");
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await qualifyLintProtections({ root, put, invoke, main, moduleRoot, sourceRoot });
  const compilerConfig = JSON.parse(await readFile(join(root, "config/production.json"), "utf8"));
  await put("config/production.json", { ...compilerConfig, exclude: [`../${main}`] });
  const missingContext = await invoke(["quality", "check", "--scope-only"], 1);
  assert.ok(
    missingContext.capabilities[0].diagnostics.some(
      ({ ruleId, location }) =>
        ruleId === "quality.source-coverage.type-context" && location.path === main,
    ),
  );
  await put("config/production.json", compilerConfig);
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await qualifyMissingDeclaration({ root, put, invoke, invokeTypecheck, sourceRoot, main });
  await put(main, "export const value: number = 1;\n");
  await qualifyExternalDeclaration({ root, put, invoke, invokeTypecheck, main, compilerConfig });
  const newSource = `${sourceRoot}/new-untracked.ts`;
  await put(newSource, "export const added = 1;\n");
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await put(newSource, "export const added = 1;\nPromise.resolve(2);\n");
  const addedViolation = await invoke(["quality", "check"], 1);
  assert.ok(
    addedViolation.capabilities[0].diagnostics.some(
      ({ location, evidence }) =>
        location.path === newSource &&
        evidence.some(({ value }) => value === "typescript(no-floating-promises)"),
    ),
  );
  await rm(join(root, newSource));
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  const unknownPackage = "packages/contexts/new-private";
  await put(`${unknownPackage}/package.json`, {
    name: "@fixture/new-private",
    private: true,
    type: "module",
  });
  await put(`${unknownPackage}/src/main.ts`, "export const added = 1;\n");
  const unknownScope = await invoke(["quality", "check", "--scope-only"], 1);
  assert.ok(
    unknownScope.capabilities[0].diagnostics.some(
      ({ ruleId, location }) =>
        ruleId === "quality.source-coverage.source-package" &&
        location.path === `${unknownPackage}/package.json`,
    ),
  );
  await rm(join(root, unknownPackage), { recursive: true });
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  for (const [path, code, outcome] of [
    ["quality.yaml", 2, "invalid-input"],
    ["config/production.json", 2, "invalid-input"],
  ]) {
    await rename(join(root, path), join(root, `${path}.qualification-backup`));
    try {
      const missingInput = await invoke(["quality", "check"], code);
      assert.equal(missingInput.outcome, outcome);
      assert.equal(missingInput.capabilities[0].diagnostics.length, 0);
    } finally {
      await rename(join(root, `${path}.qualification-backup`), join(root, path));
    }
    assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  }
  await qualifyMissingInstalledOxlint({ root, invoke });
  for (const terminal of [
    undefined,
    "true",
    "echo quality check",
    "true || pnpm quality:scope",
    scripts["quality:scope"],
  ]) {
    await put("package.json", {
      name: "quality-packed-consumer",
      private: true,
      type: "module",
      scripts: { ...scripts, "lint:typed": terminal },
      devDependencies,
    });
    const missingRoute = await invoke(["quality", "check"], 1);
    assert.ok(
      missingRoute.capabilities[0].diagnostics.some(
        ({ ruleId, location }) =>
          ruleId === "quality.source-coverage.required-route" && location.path === "package.json",
      ),
    );
  }
  await put("package.json", {
    name: "quality-packed-consumer",
    private: true,
    type: "module",
    scripts,
    devDependencies,
  });
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await put("foundation.config.yaml", { ...activation, capabilities: {} });
  assert.equal((await invoke(["quality", "check"], 2)).outcome, "invalid-input");
}

/** Runs only the actual installed Toolchain CLI with the existing bounded runner.
 * @returns {Promise<import("./packed-quality-lint-protections.ts").FixtureTypecheckResult>}
 */
export async function invokeInstalledTypecheck(root) {
  try {
    const result = await runCommand(
      process.execPath,
      [
        join(root, "node_modules/stack-toolchain/dist/cli.js"),
        "typecheck",
        "--config",
        "toolchain.config.json",
        "--json",
      ],
      root,
    );
    return { exitCode: 0, ...result };
  } catch (error) {
    if (
      !Number.isInteger(error.code) ||
      typeof error.stdout !== "string" ||
      typeof error.stderr !== "string"
    ) {
      throw error;
    }
    return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

export async function qualifyExternalDeclaration({
  root,
  put,
  invoke,
  invokeTypecheck,
  main,
  compilerConfig,
}) {
  const externalDeclaration = "node_modules/@types/quality-fixture/index.d.ts";
  const externalTypeBytes = "interface QualityFixtureValue { readonly value: number; }\n";
  const mainBytes = await readFile(join(root, main), "utf8");
  try {
    await put("node_modules/@types/quality-fixture/package.json", {
      name: "@types/quality-fixture",
      version: "1.0.0",
      types: "index.d.ts",
    });
    await put(externalDeclaration, externalTypeBytes);
    await put("config/production.json", {
      ...compilerConfig,
      compilerOptions: { ...compilerConfig.compilerOptions, types: ["quality-fixture"] },
    });
    await put(main, "export const value: QualityFixtureValue = { value: 1 };\n");
    assert.equal((await invoke(["quality", "check"])).outcome, "passed");
    assertTypecheckPassed(await invokeTypecheck());
    await rm(join(root, externalDeclaration));
    // Missing configured types prevents even nonsemantic inventory loading.
    const missingInventory = await invoke(["quality", "check"], 3);
    assert.equal(missingInventory.outcome, "failed");
    assert.equal(missingInventory.capabilities[0].diagnostics.length, 0);
    assertMissingTypeDiagnostic(await invokeTypecheck(), /TS2688[^\n]*quality-fixture/u);
    await put(externalDeclaration, externalTypeBytes);
    assertTypecheckPassed(await invokeTypecheck());
    assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  } finally {
    await put("config/production.json", compilerConfig);
    await put(main, mainBytes);
    await rm(join(root, "node_modules/@types/quality-fixture"), { recursive: true, force: true });
  }
}
