import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { lstat, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { FixturePut } from "./packed-quality-layout.ts";
export interface QualityFixtureReport {
  outcome: string;
  capabilities: readonly [
    {
      problem?: { readonly code: string; readonly message: string };
      diagnostics: readonly {
        ruleId: string;
        location: { path: string };
        evidence: readonly { kind: string; value: string }[];
      }[];
    },
  ];
}
export type QualityFixtureInvoke = (
  args: readonly string[],
  code?: number,
) => Promise<QualityFixtureReport>;
export async function qualifyLintProtections({
  root,
  put,
  invoke,
  main,
  moduleRoot,
  sourceRoot,
}: {
  root: string;
  put: FixturePut;
  invoke: QualityFixtureInvoke;
  main: string;
  moduleRoot: string;
  sourceRoot: string;
}): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(join(root, "lint.json"), "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  const lintConfig = Object.fromEntries(Object.entries(parsed));
  await put(".eslintignore", `${main}\n`);
  await put(`${moduleRoot}/.oxlintrc.json`, {
    ignorePatterns: ["**/*.ts"],
    options: { typeAware: false },
    rules: { "typescript/no-unsafe-assignment": "off" },
  });
  await put("lint.json", { ...lintConfig, ignorePatterns: [main] });
  await put(main, 'export const value: number = JSON.parse("1");\n');
  const excludedSource = await invoke(["quality", "check"], 1);
  assert.ok(
    excludedSource.capabilities[0].diagnostics.some(
      ({ ruleId, location }) =>
        location.path === main && ruleId === "quality.source-coverage.selection-mismatch",
    ),
  );
  // Config exclusions reject during selection; ignored files and nested config
  // cannot weaken the pinned invocation after that exclusion is repaired.
  await put("lint.json", lintConfig);
  const ignoredUnsafe = await invoke(["quality", "check"], 1);
  assert.ok(
    ignoredUnsafe.capabilities[0].diagnostics.some(
      ({ location, evidence }) =>
        location.path === main &&
        evidence.some(({ value }) => value === "typescript(no-unsafe-assignment)"),
    ),
  );
  await put(main, "export const value: number = 1;\n");
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await rm(join(root, ".eslintignore"));
  await rm(join(root, moduleRoot, ".oxlintrc.json"));
  await put("lint.json", lintConfig);
  for (const weakened of [
    { ...lintConfig, options: { typeAware: false } },
    { ...lintConfig, rules: { "typescript/no-floating-promises": "off" } },
    { ...lintConfig, rules: { "typescript/no-unsafe-assignment": "off" } },
  ]) {
    await put("lint.json", weakened);
    const protection = await invoke(["quality", "check"], 1);
    assert.ok(
      protection.capabilities[0].diagnostics.some(
        ({ ruleId, location }) =>
          ruleId === "quality.source-coverage.protected-setting" && location.path === "lint.json",
      ),
    );
    await put("lint.json", lintConfig);
    assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  }
  const misleadingTest = `${sourceRoot}/fixtures/production.test.ts`;
  await put(misleadingTest, "export const production = 1;\n");
  await put("lint.json", {
    ...lintConfig,
    overrides: [
      {
        files: ["**/*.test.ts"],
        rules: { "max-lines": ["error", { max: 800 }] },
      },
    ],
  });
  const productionOverride = await invoke(["quality", "check"], 1);
  assert.ok(
    productionOverride.capabilities[0].diagnostics.some(
      ({ ruleId, location }) =>
        ruleId === "quality.source-coverage.protected-setting" && location.path === "lint.json",
    ),
  );
  await put("lint.json", lintConfig);
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await rm(join(root, sourceRoot, "fixtures"), { recursive: true });
}

export interface FixtureTypecheckResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
export type FixtureTypecheckInvoke = () => Promise<FixtureTypecheckResult>;

export function assertTypecheckPassed(result: FixtureTypecheckResult): void {
  assert.equal(result.exitCode, 0, result.stdout || result.stderr);
  assert.match(result.stdout, /"status":"passed(?:-with-fallback)?"/u);
}

export function assertMissingTypeDiagnostic(
  result: FixtureTypecheckResult,
  diagnostic: RegExp,
): void {
  assert.equal(result.exitCode, 1, result.stdout || result.stderr);
  assert.match(result.stdout, /"code":"TOOLCHAIN_DIAGNOSTICS"/u);
  assert.match(result.stdout, diagnostic);
}

export async function qualifyMissingDeclaration({
  root,
  put,
  invoke,
  invokeTypecheck,
  sourceRoot,
  main,
}: {
  root: string;
  put: FixturePut;
  invoke: QualityFixtureInvoke;
  invokeTypecheck: FixtureTypecheckInvoke;
  sourceRoot: string;
  main: string;
}): Promise<void> {
  const declarationPath = `${sourceRoot}/owned.d.ts`;
  const declarationBytes = await readFile(join(root, declarationPath), "utf8");
  const mainBytes = await readFile(join(root, main), "utf8");
  try {
    await put(
      main,
      'import type { declared } from "./owned.js";\nexport const value: typeof declared = 1;\n',
    );
    assert.equal((await invoke(["quality", "check"])).outcome, "passed");
    assertTypecheckPassed(await invokeTypecheck());
    await rm(join(root, declarationPath));
    // Standalone lint owns inventory and lint rules; the installed Toolchain
    // owns missing-module diagnostics through its sequential checker chain.
    assert.equal((await invoke(["quality", "check"])).outcome, "passed");
    assertMissingTypeDiagnostic(await invokeTypecheck(), /TS2307[^\n]*owned\.js/u);
    await put(declarationPath, declarationBytes);
    assertTypecheckPassed(await invokeTypecheck());
    assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  } finally {
    await put(declarationPath, declarationBytes);
    await put(main, mainBytes);
  }
}

export function assertUnknownCastRejected(report: QualityFixtureReport, main: string): void {
  assert.ok(
    report.capabilities[0].diagnostics.some(
      ({ ruleId, location }) =>
        ruleId === "quality.source-coverage.explicit-unknown" && location.path === main,
    ),
  );
}

function assertCopiedToolTarget(closure: string, target: string): void {
  const suffix = relative(closure, target);
  assert.ok(
    suffix !== "" && !isAbsolute(suffix) && suffix.split(/[\\/]/u)[0] !== "..",
    "Missing-tool qualification target must stay strictly inside copied consumer node_modules",
  );
}

/** Targets only the copied installed dependency selected by Stack Toolchain. */
export async function qualifyMissingInstalledOxlint({
  root,
  invoke,
}: {
  readonly root: string;
  readonly invoke: QualityFixtureInvoke;
}): Promise<void> {
  const closure = await realpath(join(root, "node_modules"));
  const installedManifest = await realpath(join(closure, "stack-toolchain/package.json"));
  const selectedManifest = await realpath(
    createRequire(installedManifest).resolve("oxlint/package.json"),
  );
  const selectedRoot = dirname(selectedManifest);
  const rootAlias = join(closure, "oxlint");
  const aliasTarget = await realpath(rootAlias).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  for (const target of [
    installedManifest,
    selectedRoot,
    ...(aliasTarget === null ? [] : [aliasTarget]),
  ]) {
    assertCopiedToolTarget(closure, target);
  }
  const selected: unknown = JSON.parse(await readFile(selectedManifest, "utf8"));
  const stack: unknown = JSON.parse(await readFile(installedManifest, "utf8"));
  assert.ok(
    typeof selected === "object" &&
      selected !== null &&
      "name" in selected &&
      "version" in selected,
  );
  assert.ok(
    typeof stack === "object" &&
      stack !== null &&
      "dependencies" in stack &&
      typeof stack.dependencies === "object" &&
      stack.dependencies !== null &&
      "oxlint" in stack.dependencies,
  );
  assert.equal(selected.name, "oxlint");
  assert.equal(selected.version, stack.dependencies.oxlint);
  for (const path of [selectedRoot, ...(aliasTarget === null ? [] : [rootAlias])]) {
    await assert.rejects(lstat(`${path}.qualification-backup`), { code: "ENOENT" });
  }
  let aliasMoved = false;
  let selectedMoved = false;
  try {
    if (aliasTarget !== null && rootAlias !== selectedRoot) {
      await rename(rootAlias, `${rootAlias}.qualification-backup`);
      aliasMoved = true;
      assert.equal((await invoke(["quality", "check"])).outcome, "passed");
    }
    await rename(selectedRoot, `${selectedRoot}.qualification-backup`);
    selectedMoved = true;
    const missing = await invoke(["quality", "check"], 2);
    assert.equal(missing.outcome, "invalid-input");
    assert.equal(missing.capabilities[0].problem?.code, "QUALITY_TOOLCHAIN_INVALID");
    assert.match(missing.capabilities[0].problem?.message ?? "", /oxlint/u);
    assert.equal(missing.capabilities[0].diagnostics.length, 0);
  } finally {
    if (selectedMoved) {
      await rename(`${selectedRoot}.qualification-backup`, selectedRoot);
    }
    if (aliasMoved) {
      await rename(`${rootAlias}.qualification-backup`, rootAlias);
    }
  }
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
}
