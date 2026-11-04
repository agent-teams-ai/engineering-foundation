import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./pack-test-support.mjs";

/** Reuse a consumer already installed by the ordinary artifact custody harness. */
export async function verifyInstalledKnownFileContract(input: {
  readonly consumerRoot: string;
  readonly packageVersion: string;
  readonly repositoryRoot: string;
}): Promise<void> {
  const root = await mkdtemp(join(input.consumerRoot, ".known-file-contract-"));
  try {
    const fixture = await readFile(
      join(input.repositoryRoot, "packages/repository-mutation/tests/public-contract.ts"),
      "utf8",
    );
    // Source tests resolve the same public root through their declared package
    // boundary; the disposable consumer must resolve its installed package export.
    const sourceImport = 'from "../dist/index.js"';
    assert.equal(fixture.split(sourceImport).length, 2, "fixture must have one public-root import");
    await writeFile(
      join(root, "public-contract.ts"),
      fixture.replace(sourceImport, 'from "@agent-teams/repository-mutation"'),
    );
    await writeFile(
      join(root, "probe.ts"),
      `
import assert from "node:assert/strict";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCompatibleKnownFileInputs, assertInertKnownFileInputs, assertKnownFileInputBudgets, assertOwnedKnownFilePlan } from "./public-contract.ts";
const installed = await realpath(join(process.argv[3]!, "node_modules"));
const manifestPath = await realpath(fileURLToPath(import.meta.resolve("@agent-teams/repository-mutation/package.json")));
assert.ok(manifestPath.startsWith(installed + sep), "installed package must not resolve to a workspace/link fallback");
const manifest: { name?: unknown; version?: unknown } = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(manifest.name, "@agent-teams/repository-mutation");
assert.equal(manifest.version, process.argv[2]);
const entry = await realpath(fileURLToPath(import.meta.resolve("@agent-teams/repository-mutation")));
assert.ok(entry.startsWith(installed + sep));
const rejections = assertInertKnownFileInputs();
assertCompatibleKnownFileInputs();
assertKnownFileInputBudgets();
await mkdir("repository");
await assertOwnedKnownFilePlan(join(process.cwd(), "repository"));
console.log(JSON.stringify({ outcome: "passed", rejections, platform: process.platform }));
`,
    );
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          allowImportingTsExtensions: true,
          erasableSyntaxOnly: true,
          exactOptionalPropertyTypes: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          noUncheckedIndexedAccess: true,
          strict: true,
          target: "ES2024",
          types: ["node"],
          typeRoots: [join(input.repositoryRoot, "node_modules/@types")],
          verbatimModuleSyntax: true,
        },
        files: ["probe.ts", "public-contract.ts"],
      }),
    );
    const compilerRoot = join(input.repositoryRoot, "node_modules/typescript");
    const compiler: unknown = JSON.parse(
      await readFile(join(compilerRoot, "package.json"), "utf8"),
    );
    assert.ok(compiler !== null && typeof compiler === "object" && "version" in compiler);
    assert.equal(compiler.version, "7.0.2");
    await runCommand(
      process.execPath,
      [join(compilerRoot, "bin/tsc"), "--project", "tsconfig.json"],
      root,
    );
    const result: unknown = await runCommand(
      process.execPath,
      ["probe.ts", input.packageVersion, input.consumerRoot],
      root,
    );
    assert.ok(
      result !== null && typeof result === "object" && "stdout" in result && "stderr" in result,
    );
    assert.ok(typeof result.stdout === "string");
    const report: unknown = JSON.parse(result.stdout);
    assert.ok(
      report !== null &&
        typeof report === "object" &&
        "outcome" in report &&
        "rejections" in report,
    );
    assert.equal(report.outcome, "passed");
    assert.equal(report.rejections, 16);
    assert.equal(result.stderr, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
