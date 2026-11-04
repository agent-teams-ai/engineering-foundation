import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runQualityCommand } from "./packed-quality-command.ts";
import { qualityFixtureRecord } from "./quality-command-report.ts";
import {
  assertTypecheckPassed,
  assertMissingTypeDiagnostic,
} from "./packed-quality-lint-protections.ts";
import type {
  FixtureTypecheckResult,
  FixtureTypecheckInvoke,
  QualityFixtureInvoke,
} from "./packed-quality-lint-protections.ts";
import type { FixturePut } from "./packed-quality-layout.ts";

/** Runs the actual installed Toolchain CLI with the existing bounded runner. */
export async function invokeInstalledTypecheck(root: string): Promise<FixtureTypecheckResult> {
  const result = await runQualityCommand(
    [
      join(root, "node_modules/stack-toolchain/dist/cli.js"),
      "typecheck",
      "--config",
      "toolchain.config.json",
      "--json",
    ],
    root,
  );
  return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
}

export async function qualifyExternalDeclaration({
  root,
  put,
  invoke,
  invokeTypecheck,
  main,
  compilerConfig,
}: {
  root: string;
  put: FixturePut;
  invoke: QualityFixtureInvoke;
  invokeTypecheck: FixtureTypecheckInvoke;
  main: string;
  compilerConfig: Record<string, unknown>;
}): Promise<void> {
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
      compilerOptions: {
        ...qualityFixtureRecord(compilerConfig["compilerOptions"]),
        types: ["quality-fixture"],
      },
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
