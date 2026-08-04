import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  check,
  withPublicApiFixture,
} from "./support/capability-fixtures.mjs";
import {
  ROOT_STABLE_ITEM,
  configureV2PublicApiFixture,
} from "./support/public-api-fixtures.mjs";
import { mapReleasedBaseline } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-baseline-mapper.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
  "cli.js",
);
const stagingDirectoryPrefix = ".agent-teams-public-api-stage-";

async function stagingDirectories() {
  return new Set(
    (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith(stagingDirectoryPrefix)
    ),
  );
}

async function assertNoNewStagingDirectories(previous) {
  const current = await stagingDirectories();
  assert.deepEqual(
    [...current].filter((entry) => !previous.has(entry)),
    [],
  );
}

function v1Baseline() {
  return {
    schemaVersion: 1,
    packageName: "@fixture/public-api",
    packageVersion: "1.2.3",
    extractorVersion: "7.58.12",
    items: [ROOT_STABLE_ITEM],
  };
}

test("does not coerce missing baseline item fields into literal undefined strings", () => {
  const item = { ...ROOT_STABLE_ITEM };
  delete item.parentKind;
  const baseline = { ...v1Baseline(), items: [item] };
  assert.throws(
    () =>
      mapReleasedBaseline(baseline, {
        packageName: "@fixture/public-api",
        packageRoot: "packages/library",
        manifestPath: "packages/library/package.json",
        declarationEntryPoint: "packages/library/dist/index.d.ts",
        tsconfigPath: "packages/library/tsconfig.json",
        releasedBaselinePath: "architecture/public-api/public-api.json",
        approvedBreakingChanges: [],
      }),
    /parentKind must be a string/u,
  );
});

test("rejects a schema v1 baseline under an active schema v2 policy", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    await configureV2PublicApiFixture(consumerRoot);
    const baselinePath = join(consumerRoot, "architecture", "public-api", "public-api.json");
    await writeFile(
      baselinePath,
      `${JSON.stringify(v1Baseline(), null, 2)}\n`,
      "utf8",
    );

    const result = check(consumerRoot);
    assert.equal(result.result.status, 2);
    assert.equal(
      result.report.capabilities[0].problem?.code,
      "PUBLIC_API_BASELINE_INVALID",
    );
  });
});

test("migrates a v1 baseline only through release promotion with an unchanged root API", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    await configureV2PublicApiFixture(consumerRoot);
    const baselinePath = join(consumerRoot, "architecture", "public-api", "public-api.json");
    await writeFile(baselinePath, `${JSON.stringify(v1Baseline(), null, 2)}\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [cliPath, "public-api-promote-release", "--consumer", consumerRoot, "--json"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const promoted = JSON.parse(await readFile(baselinePath, "utf8"));
    assert.equal(promoted.schemaVersion, 2);
    assert.deepEqual(
      promoted.entrypoints.map(({ exportPath }) => exportPath),
      [".", "./local-mode"],
    );
  });
});

test("rejects release migration when the previously governed root API drifted", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    await configureV2PublicApiFixture(consumerRoot);
    const baselinePath = join(consumerRoot, "architecture", "public-api", "public-api.json");
    await writeFile(baselinePath, `${JSON.stringify(v1Baseline(), null, 2)}\n`, "utf8");
    await writeFile(
      join(consumerRoot, "packages", "library", "dist", "index.d.ts"),
      "export declare function stable(value: number): string;\n",
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [cliPath, "public-api-promote-release", "--consumer", consumerRoot, "--json"],
      { encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PUBLIC_API_BASELINE_MIGRATION_ROOT_DRIFT/u);
    assert.equal(JSON.parse(await readFile(baselinePath, "utf8")).schemaVersion, 1);
  });
});

test("rejects symlinked public API extraction inputs before staging", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const declarationPath = join(consumerRoot, "packages", "library", "dist", "index.d.ts");
    const externalPath = join(consumerRoot, "external-declaration.d.ts");
    await writeFile(externalPath, "export declare function stable(value: string): string;\n", "utf8");
    await unlink(declarationPath);
    await symlink(externalPath, declarationPath);

    const result = check(consumerRoot);
    assert.equal(result.result.status, 2);
    assert.equal(
      result.report.capabilities[0].problem?.code,
      "PUBLIC_API_PATH_SYMLINK_PROHIBITED",
    );
  });
});

test("extracts from a staged package snapshot when the original declaration mutates", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const packageDirectory = join(consumerRoot, "packages", "library");
    const declarationPath = join(packageDirectory, "dist", "index.d.ts");
    const watcherPath = join(consumerRoot, "mutate-after-stage.mjs");
    const readyPath = join(packageDirectory, "watcher-ready");
    const mutatedPath = join(packageDirectory, "watcher-mutated");
    await writeFile(
      watcherPath,
      `import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
const stageParent = process.argv[2];
const readyPath = process.argv[3];
const target = process.argv[4];
const mutatedPath = process.argv[5];
await writeFile(readyPath, "ready");
for (let attempt = 0; attempt < 5000; attempt += 1) {
  const names = await readdir(stageParent);
  const stage = names.find((name) => name.startsWith(".agent-teams-public-api-stage-"));
  if (stage !== undefined) {
    try {
      await stat(join(stageParent, stage, "packages", "library", "dist", "index.d.ts"));
      await writeFile(target, "export declare function stable(value: number): string;\\n");
      await writeFile(mutatedPath, "mutated");
      process.exit(0);
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 1));
}
process.exit(1);
`,
      "utf8",
    );
    const watcher = spawn(process.execPath, [
      watcherPath,
      tmpdir(),
      readyPath,
      declarationPath,
      mutatedPath,
    ]);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await readFile(readyPath, "utf8");
        break;
      } catch {
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }
    }

    const result = check(consumerRoot);
    const watcherExit = await new Promise((resolve) => {
      watcher.once("exit", resolve);
    });
    assert.equal(watcherExit, 0);
    assert.equal(await readFile(mutatedPath, "utf8"), "mutated");
    assert.match(await readFile(declarationPath, "utf8"), /value: number/u);
    assert.equal(result.result.status, 0);
  });
});

test("resolves strict package-local declaration dependencies without retaining staging files", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const stagesBefore = await stagingDirectories();
    const packageDirectory = join(consumerRoot, "packages", "library");
    const dependencyStore = join(
      consumerRoot,
      ".pnpm-store",
      "stage-only-dependency"
    );
    const installedDependency = join(
      packageDirectory,
      "node_modules",
      "@fixture",
      "stage-only-dependency"
    );
    await mkdir(dependencyStore, { recursive: true });
    await writeFile(
      join(dependencyStore, "package.json"),
      '{"name":"@fixture/stage-only-dependency","types":"./index.d.ts"}\n',
      "utf8",
    );
    await writeFile(
      join(dependencyStore, "index.d.ts"),
      "export interface StageOnlyDependency { readonly label: string; }\n",
      "utf8",
    );
    await mkdir(dirname(installedDependency), { recursive: true });
    await symlink(
      dependencyStore,
      installedDependency,
      process.platform === "win32" ? "junction" : "dir",
    );
    const tsconfigPath = join(packageDirectory, "tsconfig.json");
    const tsconfig = JSON.parse(await readFile(tsconfigPath, "utf8"));
    tsconfig.include = ["dist/*.d.ts"];
    await writeFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`, "utf8");
    await writeFile(
      join(packageDirectory, "dist", "dependency-import.d.ts"),
      'import type { StageOnlyDependency } from "@fixture/stage-only-dependency";\ndeclare const dependency: StageOnlyDependency;\nexport {};\n',
      "utf8",
    );

    const result = check(consumerRoot);
    assert.equal(result.result.status, 0, JSON.stringify(result.report));
    await assertNoNewStagingDirectories(stagesBefore);
  });
});

test("preserves root tsconfig extends paths in the staged package sibling", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const packageDirectory = join(consumerRoot, "packages", "library");
    await writeFile(
      join(consumerRoot, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          target: "ES2024",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(packageDirectory, "tsconfig.json"),
      `${JSON.stringify({
        extends: "../../tsconfig.json",
        include: ["dist/index.d.ts"],
      }, null, 2)}\n`,
      "utf8",
    );

    const result = check(consumerRoot);

    assert.equal(result.result.status, 0, JSON.stringify(result.report));
  });
});

test("extracts from staged root compiler configuration after the source mutates", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const packageDirectory = join(consumerRoot, "packages", "library");
    const rootTsconfigPath = join(consumerRoot, "tsconfig.json");
    const watcherPath = join(consumerRoot, "mutate-root-tsconfig-after-stage.mjs");
    const readyPath = join(packageDirectory, "root-watcher-ready");
    await writeFile(
      rootTsconfigPath,
      `${JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          target: "ES2024",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(packageDirectory, "tsconfig.json"),
      `${JSON.stringify({
        extends: "../../tsconfig.json",
        include: ["dist/index.d.ts"],
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      watcherPath,
      `import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const stageParent = process.argv[2];
const readyPath = process.argv[3];
const target = process.argv[4];
await writeFile(readyPath, "ready");
for (let attempt = 0; attempt < 5000; attempt += 1) {
  const names = await readdir(stageParent);
  const stage = names.find((name) => name.startsWith(".agent-teams-public-api-stage-"));
  if (stage !== undefined) {
    try {
      const source = await readFile(join(stageParent, stage, "tsconfig.json"), "utf8");
      if (source.includes("ES2024")) {
        await writeFile(target, "{ invalid json");
        process.exit(0);
      }
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 1));
}
process.exit(1);
`,
      "utf8",
    );
    const watcher = spawn(process.execPath, [
      watcherPath,
      tmpdir(),
      readyPath,
      rootTsconfigPath,
    ]);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await readFile(readyPath, "utf8");
        break;
      } catch {
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }
    }

    const result = check(consumerRoot);
    const watcherExit = await new Promise((resolve) => {
      watcher.once("exit", resolve);
    });

    assert.equal(watcherExit, 0);
    assert.equal(await readFile(rootTsconfigPath, "utf8"), "{ invalid json");
    assert.equal(result.result.status, 0, JSON.stringify(result.report));
  });
});

test("cleans staged package input after API extraction fails", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const stagesBefore = await stagingDirectories();
    const packageDirectory = join(consumerRoot, "packages", "library");
    await writeFile(
      join(packageDirectory, "dist", "index.d.ts"),
      "export declare function stable(value:): string;\n",
      "utf8",
    );

    const result = check(consumerRoot);

    assert.notEqual(result.result.status, 0);
    await assertNoNewStagingDirectories(stagesBefore);
  });
});
