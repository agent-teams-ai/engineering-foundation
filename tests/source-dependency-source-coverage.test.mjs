import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, opendir, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { addWorkspacePackage, foundationPackageRoot, inspectV2Topology, runSourceCapability, sourceConfigPath, withCopiedFixture, withTemporaryDirectory } from "./helpers/source-dependency-v2-fixture.mjs";

const distRoot = process.env.FOUNDATION_DIST_ROOT ?? join(foundationPackageRoot, "dist");
const { discoverSourceWorkspacePaths } = await import(pathToFileURL(join(distRoot,
  "capabilities/source-dependencies/adapters/outbound/node/selected-package-source-discovery.js")).href);

async function governExplicitSourceRoot(consumerRoot, root, schemaVersion = 2) {
  const configPath = sourceConfigPath(consumerRoot);
  const config = await readFile(configPath, "utf8");
  const governed = config.replace("governedRoots:\n", `governedRoots:\n  - ${root}\n`)
    .replace("  - id: app.surface\n    roots:\n", `  - id: app.surface\n    roots:\n      - ${root}\n`);
  await writeFile(configPath, schemaVersion === 2 ? governed : governed
    .replace("schemaVersion: 2", "schemaVersion: 1")
    .replace("packageRoots:\n  - packages\n", ""), "utf8");
  await writeFile(join(consumerRoot, "foundation.config.yaml"),
    "schemaVersion: 1\nproject:\n  id: explicit-source-root-fixture\ncapabilities:\n  architecture.source-dependencies:\n    configPath: architecture/foundation/source-dependencies.yaml\n", "utf8");
}

function checkWithCli(consumerRoot, expectedStatus) {
  const result = spawnSync(process.execPath, [join(distRoot, "cli.js"), "check",
    "--consumer", consumerRoot, "--format", "json"], {
    cwd: consumerRoot, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.equal(result.status, expectedStatus, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.coverage, "full");
  assert.equal(report.outcome, expectedStatus === 0 ? "passed" : "violations");
  assert.equal(report.capabilities.length, 1);
  return report.capabilities[0];
}

for (const root of ["coverage", "dist", "coverage/nested/dist", "dist/nested/coverage"]) {
  for (const schemaVersion of [1, 2]) {
    test(`v${schemaVersion} CLI analyzes explicitly governed ${root} and excludes generated siblings`, async () => {
      await withCopiedFixture("v2-valid", async (consumerRoot) => {
        const governed = `packages/app/${root}`;
        const path = `${governed}/hidden.ts`;
        const sibling = root.startsWith("coverage") ? "dist" : "coverage";
        await governExplicitSourceRoot(consumerRoot, governed, schemaVersion);
        await writeSourceFixture(consumerRoot, `packages/app/${sibling}/generated.ts`, 'import "outside-policy";\n');
        await writeSourceFixture(consumerRoot, path, 'import "@fixture/core";\n');
        const positive = checkWithCli(consumerRoot, 0);
        assert.equal(positive.capabilityConfigSchemaVersion, schemaVersion);
        assert.deepEqual(positive.diagnostics, []);
        await writeSourceFixture(consumerRoot, path, 'import "outside-policy";\n');
        const negative = checkWithCli(consumerRoot, 1);
        assert.equal(negative.capabilityConfigSchemaVersion, schemaVersion);
        assert.deepEqual(negative.diagnostics.map(({ ruleId, location }) => ({ ruleId, path: location.path })), [
          { ruleId: "architecture.source-dependencies.forbidden-package-dependency", path },
          { ruleId: "architecture.source-dependencies.undeclared-external-dependency", path },
        ]);
      });
    });
  }
}

test("discovery traverses explicit generated-name roots and ancestors without opening generated siblings or metadata", async () => {
  for (const root of ["coverage", "dist", "coverage/nested/dist", "dist/nested/coverage"]) {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      const governed = `packages/app/${root}`;
      const path = `${governed}/hidden.ts`;
      const sibling = root.startsWith("coverage") ? "dist" : "coverage";
      await writeSourceFixture(consumerRoot, path);
      await writeSourceFixture(consumerRoot, `packages/app/${sibling}/generated.ts`, 'import "outside-policy";\n');
      await writeSourceFixture(consumerRoot, "packages/app/coverage-extra/visible.ts");
      for (const metadata of [".git", "node_modules"]) {
        await writeSourceFixture(consumerRoot, `${governed}/${metadata}/hidden.ts`, 'import "outside-policy";\n');
      }
      const visited = [];
      const discovered = await discoverSourceWorkspacePaths(await realpath(consumerRoot), {
        repositoryRoots: ["packages"],
        governedRoots: [governed, `${governed}/.git`, `${governed}/node_modules`],
        hooks: { afterDirectoryRead: (repositoryPath) => { visited.push(repositoryPath); } },
      });
      assert.deepEqual(discovered.sourcePaths, [
        "packages/app/coverage-extra/visible.ts", path, "packages/app/src/index.ts", "packages/core/src/index.ts",
      ].toSorted());
      assert.equal(visited.includes(`packages/app/${sibling}`), false);
      assert.equal(visited.some((directory) => directory.endsWith("/.git") || directory.endsWith("/node_modules")), false);
    });
  }
});

test("explicit generated-name roots still consume discovery source budgets", async () => {
  for (const root of ["coverage", "dist/nested/coverage"]) {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      const governed = `packages/app/${root}`;
      const options = { repositoryRoots: ["packages"], governedRoots: [governed], limits: { maxSourceFiles: 2 } };
      const canonicalRoot = await realpath(consumerRoot);
      await discoverSourceWorkspacePaths(canonicalRoot, options);
      await writeSourceFixture(consumerRoot, `${governed}/hidden.ts`);
      await assert.rejects(() => discoverSourceWorkspacePaths(canonicalRoot, options),
        (error) => error?.problem?.code === "SOURCE_FILE_LIMIT_EXCEEDED");
    });
  }
});

test("explicit generated-name traversal retains symlink evidence and rejects directory replacement", async (t) => {
  if (process.platform === "win32") {
    t.skip("portable symlink qualification runs on POSIX");
    return;
  }
  await withTemporaryDirectory(async (outsideRoot) => {
    for (const root of ["coverage", "dist/nested/coverage"]) {
      await withCopiedFixture("v2-valid", async (consumerRoot) => {
        const governed = `packages/app/${root}`;
        const absolutePath = join(consumerRoot, governed);
        await writeSourceFixture(consumerRoot, `${governed}/safe.ts`);
        await symlink(outsideRoot, join(absolutePath, "linked"), "dir");
        let readOutside = false;
        const canonicalRoot = await realpath(consumerRoot);
        const options = {
          repositoryRoots: ["packages"], governedRoots: [governed],
          fileSystem: { opendir: async (directoryPath) => {
            if ((await realpath(directoryPath)).startsWith(outsideRoot)) {
              readOutside = true;
            }
            return opendir(directoryPath);
          } },
        };
        const discovered = await discoverSourceWorkspacePaths(canonicalRoot, options);
        assert.deepEqual(discovered.symbolicLinkPaths, [`${governed}/linked`]);
        await assert.rejects(() => discoverSourceWorkspacePaths(canonicalRoot, {
          ...options,
          hooks: { async afterDirectoryRead(repositoryPath) {
            if (repositoryPath === governed) {
              await rename(absolutePath, `${absolutePath}-before-replacement`);
              await symlink(outsideRoot, absolutePath, "dir");
            }
          } },
        }), (error) => error?.problem?.code === "SOURCE_FILESYSTEM_CHANGED");
        assert.equal(readOutside, false);
      });
    }
  });
});

test("v2 analyzes governed nested coverage and dist source while pruning metadata and dependencies", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    for (const directory of [".git", "coverage", "dist", "node_modules"]) {
      const ignoredRoot = join(
        consumerRoot,
        "packages",
        "app",
        "src",
        directory,
      );
      await mkdir(ignoredRoot, { recursive: true });
      await writeFile(
        join(ignoredRoot, "ignored.ts"),
        'import "outside-policy";\n',
        "utf8",
      );
    }
    if (process.platform !== "win32") {
      await symlink(
        join(consumerRoot, "packages", "app", "src"),
        join(
          consumerRoot,
          "packages",
          "app",
          "src",
          "node_modules",
          "linked-source",
        ),
        "dir",
      );
    }
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.outcome, "violations");
    assert.deepEqual(
      report.diagnostics
        .filter(({ location }) => location.path.endsWith("/ignored.ts"))
        .map(({ location, ruleId }) => ({ path: location.path, ruleId })),
      [
        {
          path: "packages/app/src/coverage/ignored.ts",
          ruleId: "architecture.source-dependencies.forbidden-package-dependency",
        },
        {
          path: "packages/app/src/dist/ignored.ts",
          ruleId: "architecture.source-dependencies.forbidden-package-dependency",
        },
        {
          path: "packages/app/src/coverage/ignored.ts",
          ruleId: "architecture.source-dependencies.undeclared-external-dependency",
        },
        {
          path: "packages/app/src/dist/ignored.ts",
          ruleId: "architecture.source-dependencies.undeclared-external-dependency",
        },
      ],
    );
    assert.equal(JSON.stringify(report).includes("src/.git/ignored.ts"), false);
    assert.equal(JSON.stringify(report).includes("src/node_modules/ignored.ts"), false);
  });
});

test("v2 excludes actual package generated roots and does not treat non-source assets as graph nodes", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await writeFile(join(consumerRoot, "pnpm-workspace.yaml"), "{}\n", "utf8");
    for (const directory of ["coverage", "dist"]) {
      const generatedRoot = join(consumerRoot, "packages", "app", directory);
      await mkdir(generatedRoot, { recursive: true });
      await writeFile(
        join(generatedRoot, "generated.ts"),
        'import "outside-policy";\n',
        "utf8",
      );
    }
    const assetRoot = join(consumerRoot, "packages", "app", "assets");
    await mkdir(assetRoot);
    await writeFile(join(assetRoot, "catalog.json"), '{"kind":"fixture"}\n', "utf8");

    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.outcome, "passed", JSON.stringify(report, null, 2));
    const topology = await inspectV2Topology(consumerRoot);
    const app = topology.packages.find(({ name }) => name === "@fixture/app");
    assert.deepEqual(app?.sourcePaths, ["packages/app/src/index.ts"]);
    assert.equal(JSON.stringify(topology).includes("catalog.json"), false);
    assert.equal(JSON.stringify(topology).includes("generated.ts"), false);
    const coreRoot = join(consumerRoot, "packages", "core");
    const coreManifest = JSON.parse(await readFile(join(coreRoot, "package.json"), "utf8"));
    assert.equal(coreManifest.exports["."], "./dist/index.js");
    await assert.rejects(stat(join(coreRoot, "dist", "index.js")), { code: "ENOENT" });
  });
});

test("v2 development source admits a missing own dist reference without treating dist as source evidence", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const configPath = sourceConfigPath(consumerRoot);
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        "  - id: app.surface\n",
        "  - id: app.surface\n    dependencyMode: development\n",
      ),
      "utf8",
    );
    await writeFile(
      join(consumerRoot, "packages", "app", "src", "index.ts"),
      'import { coreValue } from "@fixture/core";\nimport generated from "../dist/generated.js";\nexport const appValue = [coreValue, generated];\n',
      "utf8",
    );

    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.outcome, "passed", JSON.stringify(report, null, 2));
    assert.equal(
      await stat(join(consumerRoot, "packages", "app", "dist")).then(
        () => true,
        () => false,
      ),
      false,
    );
  });
});

async function writeSourceFixture(consumerRoot, path, source = "export const value = true;\n") {
  const absolutePath = join(consumerRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, source, "utf8");
}

test("v1 and v2 analyze allowed and forbidden nested source and script entrypoints", async () => {
  for (const fixture of ["valid", "v2-valid"]) {
    for (const root of ["src", "scripts"]) {
      await withCopiedFixture(fixture, async (consumerRoot) => {
        const appRoot = join(consumerRoot, "packages", "app");
        if (root === "scripts") {
          await rename(join(appRoot, "src"), join(appRoot, root));
          const manifestPath = join(appRoot, "package.json");
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          manifest.scripts = { check: "node scripts/coverage/check.mjs" };
          await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
        }
        const paths = [
          `packages/app/${root}/coverage/check.mjs`,
          `packages/app/${root}/feature/dist/deep/coverage/check.ts`,
        ];
        for (const path of paths) {
          await writeSourceFixture(consumerRoot, path, 'import "@fixture/core";\n');
        }
        const configPath = sourceConfigPath(consumerRoot);
        const config = await readFile(configPath, "utf8");
        // The original v1 app.surface forbids core; authorize this positive edge explicitly.
        const allowedConfig = fixture === "valid"
          ? config.replace("      packages: []", '      packages:\n        - "@fixture/core"')
          : config;
        await writeFile(configPath, allowedConfig
          .replaceAll("packages/app/src", `packages/app/${root}`)
          .replace(`packages/app/${root}/index.ts`, paths[0]), "utf8");
        const positive = await runSourceCapability(consumerRoot);
        assert.equal(positive.outcome, "passed", JSON.stringify(positive));

        for (const path of paths) {
          await writeSourceFixture(consumerRoot, path, 'import "outside-policy";\n');
        }
        const negative = await runSourceCapability(consumerRoot);
        assert.equal(negative.outcome, "violations", JSON.stringify(negative));
        assert.deepEqual(
          negative.diagnostics
            .filter(({ ruleId }) => ruleId === "architecture.source-dependencies.forbidden-package-dependency")
            .map(({ location }) => location.path),
          paths,
        );
      });
    }
  }
});

test("v2 discovers nested ungoverned scripts while v1 retains its governed-only universe", async () => {
  for (const fixture of ["valid", "v2-valid"]) {
    await withCopiedFixture(fixture, async (consumerRoot) => {
      const path = "packages/app/scripts/coverage/dist/hidden.mjs";
      await writeSourceFixture(consumerRoot, path, 'import "outside-policy";\n');
      const report = await runSourceCapability(consumerRoot);
      assert.equal(report.outcome, fixture === "valid" ? "passed" : "violations");
      assert.deepEqual(report.diagnostics.map(({ ruleId, subject }) => ({ ruleId, subject })),
        fixture === "valid" ? [] : [{
          ruleId: "architecture.source-dependencies.unclassified-source-file",
          subject: path,
        }]);
    });
  }
});

test("v2 bounds newly discovered nested source files and bytes", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const limits = { maxSourceFiles: 2, maxSourceFileBytes: 1024, maxTotalSourceBytes: 1024 };
    await inspectV2Topology(consumerRoot, { limits });
    await writeSourceFixture(consumerRoot, "packages/app/src/coverage/dist/budget.ts", " ".repeat(1025));
    for (const [limit, code] of [
      ["maxSourceFiles", "SOURCE_FILE_LIMIT_EXCEEDED"],
      ["maxSourceFileBytes", "SOURCE_FILE_INVALID"],
      ["maxTotalSourceBytes", "SOURCE_TOTAL_BYTES_EXCEEDED"],
    ]) {
      await assert.rejects(
        () => inspectV2Topology(consumerRoot, { limits: { [limit]: limits[limit] } }),
        (error) => error?.problem?.code === code,
      );
    }
  });
});

test("v2 rejects symlink escapes and replacement races in nested coverage and dist", async (t) => {
  if (process.platform === "win32") {
    t.skip("portable symlink qualification runs on POSIX");
    return;
  }
  await withTemporaryDirectory(async (outsideRoot) => {
    await writeFile(join(outsideRoot, "secret.ts"), 'import "outside-policy";\n', "utf8");
    for (const directory of ["coverage", "dist"]) {
      for (const replaceAfterRead of [false, true]) {
        await withCopiedFixture("v2-valid", async (consumerRoot) => {
          const path = `packages/app/src/${directory}`;
          const absolutePath = join(consumerRoot, path);
          if (replaceAfterRead) {
            await writeSourceFixture(consumerRoot, `${path}/safe.ts`);
          } else {
            await symlink(outsideRoot, absolutePath, "dir");
          }
          let readOutside = false;
          await assert.rejects(() => inspectV2Topology(consumerRoot, {
            fileSystem: {
              opendir: async (directoryPath) => {
                if ((await realpath(directoryPath)).startsWith(outsideRoot)) {
                  readOutside = true;
                }
                return opendir(directoryPath);
              },
            },
            hooks: {
              async afterDirectoryRead(repositoryPath) {
                if (replaceAfterRead && repositoryPath === path) {
                  await rename(absolutePath, `${absolutePath}-before-replacement`);
                  await symlink(outsideRoot, absolutePath, "dir");
                }
              },
            },
          }), (error) => error?.problem?.code === (replaceAfterRead
            ? "SOURCE_FILESYSTEM_CHANGED"
            : "SOURCE_SYMLINK_PROHIBITED"));
          assert.equal(readOutside, false);
        });
      }
    }
  });
});

test("v2 selects packages named coverage or dist without pnpm globs", async () => {
  for (const name of ["coverage", "dist"]) {
    for (const individualRoots of [false, true]) {
      await withCopiedFixture("v2-valid", async (consumerRoot) => {
        await writeFile(join(consumerRoot, "pnpm-workspace.yaml"), "{}\n", "utf8");
        await addWorkspacePackage(consumerRoot, name);
        const configPath = sourceConfigPath(consumerRoot);
        let config = await readFile(configPath, "utf8");
        if (individualRoots) {
          config = config.replace("  - packages\n", `  - packages/app\n  - packages/core\n  - packages/${name}\n`);
        }
        await writeFile(configPath, config, "utf8");
        const unclassified = await runSourceCapability(consumerRoot);
        assert.deepEqual(unclassified.diagnostics.map(({ ruleId, subject }) => ({ ruleId, subject })), [{
          ruleId: "architecture.source-dependencies.uncovered-workspace-package-root",
          subject: `packages/${name}`,
        }]);
        const root = `packages/${name}/src`;
        config = config.replace("governedRoots:\n", `governedRoots:\n  - ${root}\n`)
          .concat(`  - id: ${name}.surface\n    roots:\n      - ${root}\n    entrypoints:\n      - ${root}/index.ts\n    allow:\n      boundaries: []\n      packages: []\n      builtins: []\n      runtimeReferences: []\n`);
        await writeFile(configPath, config, "utf8");
        for (const output of ["coverage", "dist"]) {
          await writeSourceFixture(consumerRoot, `packages/${name}/${output}/generated.ts`, 'import "outside-policy";\n');
        }
        const classified = await runSourceCapability(consumerRoot);
        assert.equal(classified.outcome, "passed", JSON.stringify(classified));
        const sourcePaths = (await inspectV2Topology(consumerRoot)).packages
          .find(({ name: packageName }) => packageName === `@fixture/${name}`).sourcePaths;
        assert.deepEqual(sourcePaths, [`${root}/index.ts`]);
      });
    }
  }
});

test("v2 nested package type scopes cannot hide coverage or dist source", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const scope = "packages/app/src/scoped";
    await writeSourceFixture(consumerRoot, `${scope}/package.json`, '{"type":"module"}\n');
    const paths = [`${scope}/coverage/check.ts`, `${scope}/dist/check.mjs`];
    for (const path of paths) {
      await writeSourceFixture(consumerRoot, path, 'import "@fixture/core";\n');
    }
    const positive = await runSourceCapability(consumerRoot);
    assert.equal(positive.outcome, "passed", JSON.stringify(positive));
    for (const path of paths) {
      await writeSourceFixture(consumerRoot, path, 'import "outside-policy";\n');
    }
    const negative = await runSourceCapability(consumerRoot);
    assert.equal(negative.outcome, "violations", JSON.stringify(negative));
    assert.deepEqual(negative.diagnostics
      .filter(({ ruleId }) => ruleId === "architecture.source-dependencies.forbidden-package-dependency")
      .map(({ location }) => location.path), paths);
  });
});

test("full CLI fails forbidden nested source for v1 and v2 and preserves generated exports", async () => {
  for (const schemaVersion of [1, 2]) {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      await writeFile(join(consumerRoot, "foundation.config.yaml"),
        "schemaVersion: 1\nproject:\n  id: source-coverage-fixture\ncapabilities:\n  architecture.source-dependencies:\n    configPath: architecture/foundation/source-dependencies.yaml\n", "utf8");
      if (schemaVersion === 1) {
        const configPath = sourceConfigPath(consumerRoot);
        const config = await readFile(configPath, "utf8");
        await writeFile(configPath, config.replace("schemaVersion: 2", "schemaVersion: 1")
          .replace("packageRoots:\n  - packages\n", ""), "utf8");
      }
      const paths = ["packages/app/src/coverage/check.mjs", "packages/app/src/feature/dist/check.ts"];
      for (const forbidden of [false, true]) {
        for (const path of paths) {
          await writeSourceFixture(consumerRoot, path, forbidden
            ? 'import "outside-policy";\n'
            : 'import "@fixture/core";\n');
        }
        const report = checkWithCli(consumerRoot, forbidden ? 1 : 0);
        assert.equal(report.capabilityConfigSchemaVersion, schemaVersion);
        assert.deepEqual(report.diagnostics
          .filter(({ ruleId }) => ruleId === "architecture.source-dependencies.forbidden-package-dependency")
          .map(({ location }) => location.path), forbidden ? paths : []);
      }
    });
  }
});
