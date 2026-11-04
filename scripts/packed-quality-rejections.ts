import assert from "node:assert/strict";
import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { qualityFixtureRecord } from "./quality-command-report.ts";
import {
  qualifyLintProtections,
  qualifyMissingDeclaration,
  qualifyMissingInstalledOxlint,
} from "./packed-quality-lint-protections.ts";
import { qualifyExternalDeclaration } from "./packed-quality-typecheck.ts";
import type {
  QualityFixtureInvoke,
  FixtureTypecheckInvoke,
} from "./packed-quality-lint-protections.ts";
import type { FixturePut } from "./packed-quality-layout.ts";

export async function qualifyNestedRejections({
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
}: {
  root: string;
  put: FixturePut;
  invoke: QualityFixtureInvoke;
  main: string;
  sourceRoot: string;
  moduleRoot: string;
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  activation: Record<string, unknown>;
  invokeTypecheck: FixtureTypecheckInvoke;
}): Promise<void> {
  await qualifyNativeRoutes({ root, put, invoke, moduleRoot });
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
  const compilerConfig = qualityFixtureRecord(
    JSON.parse(await readFile(join(root, "config/production.json"), "utf8")),
  );
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
  ] as const) {
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

async function qualifyNativeRoutes({
  root,
  put,
  invoke,
  moduleRoot,
}: {
  root: string;
  put: FixturePut;
  invoke: QualityFixtureInvoke;
  moduleRoot: string;
}): Promise<void> {
  const qualityProfile = qualityFixtureRecord(
    JSON.parse(await readFile(join(root, "quality.yaml"), "utf8")),
  );
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
    assert.match(staleNative.capabilities[0].problem?.message ?? "", /no current native source/u);
  } finally {
    for (const file of nativeFiles) {
      await rename(
        join(root, `${file}.qualification-backup`),
        join(root, moduleRoot, "native", file),
      );
    }
  }
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
}
