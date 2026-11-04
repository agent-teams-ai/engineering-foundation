import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { QualifiedArchiveRecord } from "./package-artifact-custody.mts";
import { runCommand } from "./pack-test-support.mjs";

/** Install the qualified archive as this public API consumer's direct dependency. */
export async function verifyPackedKnownFileContract(input: {
  readonly artifact: QualifiedArchiveRecord;
  readonly temporaryRoot: string;
  readonly repositoryRoot: string;
  readonly packageManager: string;
  readonly runPnpm: (args: readonly string[], cwd: string) => Promise<unknown>;
}): Promise<void> {
  assert.equal(input.artifact.packageName, "@agent-teams/repository-mutation");
  const root = await mkdtemp(join(input.temporaryRoot, "known-file-contract-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "known-file-contract-packed-test",
        private: true,
        type: "module",
        packageManager: input.packageManager,
        devDependencies: {
          [input.artifact.packageName]: pathToFileURL(input.artifact.archivePath).href,
        },
      }),
    );
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    await input.runPnpm(
      ["install", "--offline", "--ignore-scripts", "--strict-peer-dependencies"],
      root,
    );
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
      ["probe.ts", input.artifact.packageVersion, root],
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
