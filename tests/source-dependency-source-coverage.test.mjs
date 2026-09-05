import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, opendir, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
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
  assert.equal(report.outcome, ["passed", "violations", "invalid-input"][expectedStatus]);
  assert.equal(report.capabilities.length, 1);
  return report.capabilities[0];
}

const boundarySelections = [
  { name: "v1", schemaVersion: 1 },
  { name: "v2 collection", schemaVersion: 2, packageRoots: ["packages"] },
  { name: "v2 individual", schemaVersion: 2, packageRoots: ["packages/app", "packages/core"] },
  { name: "v2 collection without globs", schemaVersion: 2, packageRoots: ["packages"], noGlobs: true },
  { name: "v2 individual without globs", schemaVersion: 2, packageRoots: ["packages/app", "packages/core"], noGlobs: true },
  { name: "v1 root package", schemaVersion: 1, rootPackage: true },
];
const generatedSourceRoutes = ["coverage", "dist", "coverage/nested/dist", "dist/nested/coverage"];

function sourceBoundary(id, root, packages = []) {
  return {
    id, roots: [root], entrypoints: [`${root}/index.ts`],
    allow: { boundaries: [], packages, builtins: ["node:path"], runtimeReferences: [] },
  };
}

async function withBoundaryFixture(selection, callback) {
  const withFixture = selection.rootPackage ? withTemporaryDirectory
    : (run) => withCopiedFixture("v2-valid", run);
  await withFixture(async (consumerRoot) => {
    const appRoot = selection.rootPackage ? "." : "packages/app";
    const src = posix.join(appRoot, "src");
    const policy = {
      schemaVersion: selection.schemaVersion,
      workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
      ...(selection.packageRoots === undefined ? {} : { packageRoots: selection.packageRoots }),
      governedRoots: selection.rootPackage ? [src] : [appRoot, "packages/core/src"],
      boundaries: [sourceBoundary("app.surface", src, selection.rootPackage ? [] : ["@fixture/core"])],
    };
    if (selection.rootPackage) {
      await writeSourceFixture(consumerRoot, "package.json", JSON.stringify({
        name: "@fixture/root", version: "0.0.0", private: true, type: "module",
        exports: { ".": "./dist/index.js" },
      }));
      await writeSourceFixture(consumerRoot, `${src}/index.ts`);
    } else {
      policy.boundaries.push(sourceBoundary("core.surface", "packages/core/src"));
    }
    if (selection.rootPackage || selection.noGlobs) {
      await writeSourceFixture(consumerRoot, "pnpm-workspace.yaml", "{}\n");
    }
    await writeSourceFixture(consumerRoot, "foundation.config.yaml", JSON.stringify({
      schemaVersion: 1, project: { id: "boundary-source-fixture" },
      capabilities: { "architecture.source-dependencies": { configPath: "architecture/foundation/source-dependencies.yaml" } },
    }));
    const save = () => writeSourceFixture(consumerRoot,
      "architecture/foundation/source-dependencies.yaml", `${JSON.stringify(policy)}\n`);
    await save();
    await callback({ consumerRoot, appRoot, src, policy, save });
  });
}

function assertForbiddenSource(report, path) {
  assert.deepEqual(report.diagnostics.map(({ ruleId, location }) => ({ ruleId, path: location.path })), [
    { ruleId: "architecture.source-dependencies.forbidden-package-dependency", path },
    { ruleId: "architecture.source-dependencies.undeclared-external-dependency", path },
  ]);
}

// The finite relation matrix is: generated directory equals/ancestors B; B is
// a directory or file; E is inside B or another root of that same boundary.
// Broad parent B alone keeps package output pruned (separate control below).
for (const selection of boundarySelections) {
  for (const route of generatedSourceRoutes) {
    test(`${selection.name} CLI governed scope discovers explicit boundary ${route}`, async () => {
      await withBoundaryFixture(selection, async ({ consumerRoot, appRoot, src, policy, save }) => {
        const root = posix.join(appRoot, route);
        const path = `${root}/hidden.ts`;
        const sibling = posix.join(appRoot, route.startsWith("coverage") ? "dist" : "coverage");
        if (selection.rootPackage) {
          // The immutable schemas reject literal '.'. V1 can govern named
          // directories owned by the root manifest without governing '.'.
          policy.governedRoots = [src, route.split("/")[0]];
        }
        // V1 already scans all of its broad governed root, including output.
        if (selection.schemaVersion === 2) {
          await writeSourceFixture(consumerRoot, `${sibling}/generated.ts`, 'import "outside-policy";\n');
        }
        for (const relationship of ["directory", "entrypoint", "file"]) {
          policy.boundaries[0].roots = [src, relationship === "file" ? path : root];
          policy.boundaries[0].entrypoints = [relationship === "directory" ? `${src}/index.ts` : path];
          await save();
          await writeSourceFixture(consumerRoot, path, 'import "node:path";\n');
          const positive = checkWithCli(consumerRoot, 0);
          assert.equal(positive.capabilityConfigSchemaVersion, selection.schemaVersion);
          assert.deepEqual(positive.diagnostics, []);
          if (selection.schemaVersion === 2) {
            const topology = await inspectV2Topology(consumerRoot);
            assert.deepEqual(topology.packages.flatMap(({ sourcePaths }) => sourcePaths).toSorted(),
              [path, `${src}/index.ts`, ...(selection.rootPackage ? [] : ["packages/core/src/index.ts"])].toSorted());
          }
          await writeSourceFixture(consumerRoot, path, 'import "outside-policy";\n');
          assertForbiddenSource(checkWithCli(consumerRoot, 1), path);
        }
      });
    });
  }
}

test("CLI parent boundary roots preserve output pruning and fail closed on excluded entrypoints", async () => {
  for (const selection of boundarySelections.filter(({ noGlobs, rootPackage, name }) => !noGlobs && !rootPackage && !name.includes("individual"))) {
    for (const route of ["coverage", "dist"]) {
      await withBoundaryFixture(selection, async ({ consumerRoot, appRoot, policy, save }) => {
        const path = posix.join(appRoot, route, "hidden.ts");
        policy.boundaries[0].roots = [appRoot];
        await save();
        await writeSourceFixture(consumerRoot, path, 'import "node:path";\n');
        assert.deepEqual(checkWithCli(consumerRoot, 0).diagnostics, []);
        await writeSourceFixture(consumerRoot, path, 'import "outside-policy";\n');
        if (selection.schemaVersion === 1) {
          assertForbiddenSource(checkWithCli(consumerRoot, 1), path);
        } else {
          assert.deepEqual(checkWithCli(consumerRoot, 0).diagnostics, []);
        }
        policy.boundaries[0].entrypoints = [path];
        await save();
        for (const forbidden of [false, true]) {
          await writeSourceFixture(consumerRoot, path, forbidden ? 'import "outside-policy";\n' : 'import "node:path";\n');
          const report = checkWithCli(consumerRoot, selection.schemaVersion === 1 && !forbidden ? 0 : 1);
          if (selection.schemaVersion === 2) {
            assert.deepEqual(report.diagnostics.map(({ ruleId }) => ruleId),
              ["architecture.source-dependencies.invalid-boundary-entrypoint"]);
          } else if (forbidden) {
            assertForbiddenSource(report, path);
          }
        }
      });
    }
  }
});

test("CLI boundary roots cannot expand governed or selected package scope", async () => {
  for (const selection of [boundarySelections[0], boundarySelections[1]]) {
    const relationships = selection.schemaVersion === 1 ? ["sibling", "parent"] : ["sibling", "parent", "outside-selection"];
    for (const relationship of relationships) {
      await withBoundaryFixture(selection, async ({ consumerRoot, policy, save }) => {
        const root = relationship === "outside-selection" ? "tools/coverage" : "packages/app/coverage";
        const path = `${root}/hidden.ts`;
        policy.governedRoots = [relationship === "outside-selection" ? "tools" : "packages/app/src", "packages/core/src"];
        policy.boundaries[0].roots = [relationship === "parent" ? "packages/app" : root];
        policy.boundaries[0].entrypoints = [path];
        await save();
        for (const forbidden of [false, true]) {
          await writeSourceFixture(consumerRoot, path, forbidden ? 'import "outside-policy";\n' : 'import "node:path";\n');
          const report = checkWithCli(consumerRoot, 2);
          assert.equal(report.problem.code, relationship === "outside-selection"
            ? "SOURCE_ROOT_OUTSIDE_WORKSPACE" : "SOURCE_ARCHITECTURE_CONFIG_INVALID");
          assert.deepEqual(report.diagnostics, []);
        }
      });
    }
  }
});

test("CLI root manifest inventory does not select its generated-name source", async () => {
  await withBoundaryFixture(boundarySelections[1], async ({ consumerRoot, policy, save }) => {
    const path = "coverage/nested/dist/hidden.ts";
    for (const selected of [false, true]) {
      if (selected) {
        policy.governedRoots.push("coverage");
        policy.boundaries.push(sourceBoundary("root.surface", "coverage"));
        policy.boundaries.at(-1).entrypoints = [path];
      }
      await save();
      for (const source of ['import "node:path";\n', 'import "outside-policy";\n']) {
        await writeSourceFixture(consumerRoot, path, source);
        const report = checkWithCli(consumerRoot, selected ? 2 : 0);
        assert.deepEqual(report.diagnostics, []);
        if (selected) {
          assert.equal(report.problem.code, "SOURCE_ROOT_OUTSIDE_WORKSPACE");
        }
      }
    }
  });
});

test("CLI rejects literal root selection while the internal traversal retains root-package containment", async () => {
  for (const schemaVersion of [1, 2]) {
    const selection = { schemaVersion, rootPackage: true,
      ...(schemaVersion === 2 ? { packageRoots: ["."] } : {}) };
    await withBoundaryFixture(selection, async ({ consumerRoot, policy, save }) => {
      if (schemaVersion === 1) {
        policy.governedRoots = ["."];
      }
      await save();
      for (const source of ['import "node:path";\n', 'import "outside-policy";\n']) {
        await writeSourceFixture(consumerRoot, "src/index.ts", source);
        assert.equal(checkWithCli(consumerRoot, 2).problem.code, "SCHEMA_INVALID");
      }
      // '.' is an internal path identity, not a newly admitted wire value.
      await writeSourceFixture(consumerRoot, "coverage/nested/dist/hidden.ts");
      await writeSourceFixture(consumerRoot, "dist/generated.ts", 'import "outside-policy";\n');
      const discovered = await discoverSourceWorkspacePaths(await realpath(consumerRoot), {
        repositoryRoots: ["."], governedRoots: ["."], boundaryRoots: ["coverage/nested/dist/hidden.ts"],
      });
      assert.deepEqual(discovered.sourcePaths, ["coverage/nested/dist/hidden.ts", "src/index.ts"]);
    });
  }
});

test("CLI diagnostic fallback receives boundary roots for collection and individual package selections", async (t) => {
  if (process.platform === "win32") {
    t.skip("case-distinct directory qualification runs on POSIX");
    return;
  }
  const caseSensitive = await withTemporaryDirectory(async (root) => {
    await mkdir(join(root, "case"));
    try {
      await stat(join(root, "CASE"));
      return false;
    } catch (error) {
      assert.equal(error.code, "ENOENT");
      return true;
    }
  });
  if (!caseSensitive) {
    t.skip("case-distinct directory qualification requires a case-sensitive filesystem");
    return;
  }
  for (const selection of [boundarySelections[1], boundarySelections[2]]) {
    for (const route of generatedSourceRoutes) {
      await withBoundaryFixture(selection, async ({ consumerRoot, appRoot, src, policy, save }) => {
        const root = posix.join(appRoot, route);
        for (const spelling of ["A", "a"]) {
          await writeSourceFixture(consumerRoot, `${root}/${spelling}/package.json`,
            JSON.stringify({ name: `fixture-${spelling.toLowerCase()}`, version: "0.0.0" }));
        }
        await writeSourceFixture(consumerRoot, "pnpm-workspace.yaml",
          `packages:\n  - "packages/*"\n  - "${root}/*"\n`);
        for (const explicit of [false, true]) {
          policy.boundaries[0].roots = explicit ? [src, root] : [src];
          await save();
          assert.equal(checkWithCli(consumerRoot, 2).problem.code,
            explicit ? "SOURCE_PATH_CASE_COLLISION" : "PACKAGE_PATH_CASE_COLLISION");
        }
      });
    }
  }
});

test("boundary traversal preserves the exact selected universe and unopened excluded paths", async () => {
  for (const route of generatedSourceRoutes) {
    await withBoundaryFixture(boundarySelections[1], async ({ consumerRoot }) => {
      const root = `packages/app/${route}`;
      const path = `${root}/hidden.ts`;
      const sibling = route.startsWith("coverage") ? "dist" : "coverage";
      await writeSourceFixture(consumerRoot, path);
      const excluded = [`packages/app/${sibling}`, `${root}/.git`, `${root}/node_modules`, "tools/coverage"];
      for (const directory of excluded) {
        await writeSourceFixture(consumerRoot, `${directory}/hidden.ts`, 'import "outside-policy";\n');
      }
      const visited = [];
      const options = {
        repositoryRoots: ["packages"], governedRoots: ["packages/app", "packages/core/src", "tools"],
        boundaryRoots: [path.toUpperCase(), ...excluded.slice(1)],
        hooks: { afterDirectoryRead: (directory) => { visited.push(directory); } },
      };
      const discovered = await discoverSourceWorkspacePaths(await realpath(consumerRoot), options);
      assert.deepEqual(discovered.sourcePaths, [path, "packages/app/src/index.ts", "packages/core/src/index.ts"].toSorted());
      assert.equal(excluded.some((directory) => visited.includes(directory)), false);
      // A boundary outside governed scope, or a segment-prefix lookalike,
      // cannot reopen a package output root even in direct adapter calls.
      const ignored = await discoverSourceWorkspacePaths(await realpath(consumerRoot), {
        ...options, governedRoots: ["packages/app/src", "packages/core/src"],
        boundaryRoots: [path, "packages/app/coverage-extra", "packages/app/dist-extra"],
      });
      assert.deepEqual(ignored.sourcePaths, ["packages/app/src/index.ts", "packages/core/src/index.ts"]);
      const prefixOnly = await discoverSourceWorkspacePaths(await realpath(consumerRoot), {
        ...options, boundaryRoots: ["packages/app/coverage-extra", "packages/app/dist-extra"],
      });
      assert.deepEqual(prefixOnly.sourcePaths, ignored.sourcePaths);
    });
  }
});

test("CLI source-file boundary hints do not hide neighboring unclassified source", async () => {
  await withBoundaryFixture(boundarySelections[1], async ({ consumerRoot, policy, src, save }) => {
    const path = "packages/app/coverage/nested/dist/entry.ts";
    const neighbor = "packages/app/coverage/neighbor.ts";
    policy.boundaries[0].roots = [src, path];
    policy.boundaries[0].entrypoints = [path];
    await save();
    await writeSourceFixture(consumerRoot, path, 'import "node:path";\n');
    assert.deepEqual(checkWithCli(consumerRoot, 0).diagnostics, []);
    await writeSourceFixture(consumerRoot, neighbor);
    assert.deepEqual(checkWithCli(consumerRoot, 1).diagnostics.map(({ ruleId, location }) => ({ ruleId, path: location.path })),
      [{ ruleId: "architecture.source-dependencies.unclassified-source-file", path: neighbor }]);
  });
});

test("broad governed boundary routes retain source limits and symlink replacement protection", async (t) => {
  for (const route of ["coverage", "dist/nested/coverage"]) {
    await withBoundaryFixture(boundarySelections[1], async ({ consumerRoot, policy, src, save }) => {
      const root = `packages/app/${route}`;
      policy.boundaries[0].roots = [src, root];
      await save();
      await writeSourceFixture(consumerRoot, `${root}/hidden.ts`, " ".repeat(1025));
      for (const [limit, maximum, code] of [
        ["maxSourceFiles", 2, "SOURCE_FILE_LIMIT_EXCEEDED"],
        ["maxSourceFileBytes", 1024, "SOURCE_FILE_INVALID"],
        ["maxTotalSourceBytes", 1024, "SOURCE_TOTAL_BYTES_EXCEEDED"],
      ]) {
        await assert.rejects(() => inspectV2Topology(consumerRoot, { limits: { [limit]: maximum } }),
          (error) => error?.problem?.code === code);
      }
    });
  }
  await t.test("boundary route symlink escape and replacement", { skip: process.platform === "win32" }, async () => {
    await withTemporaryDirectory(async (outsideRoot) => {
      for (const replacement of [false, true]) {
        await withBoundaryFixture(boundarySelections[1], async ({ consumerRoot, policy, src, save }) => {
          const root = "packages/app/dist/nested/coverage";
          const absolutePath = join(consumerRoot, root);
          policy.boundaries[0].roots = [src, root];
          await save();
          await mkdir(dirname(absolutePath), { recursive: true });
          if (replacement) {
            await writeSourceFixture(consumerRoot, `${root}/safe.ts`);
          } else {
            await symlink(outsideRoot, absolutePath, "dir");
          }
          let readOutside = false;
          await assert.rejects(() => inspectV2Topology(consumerRoot, {
            fileSystem: { opendir: async (directory) => {
              if ((await realpath(directory)).startsWith(outsideRoot)) {
                readOutside = true;
              }
              return opendir(directory);
            } },
            hooks: { afterDirectoryRead: async (directory) => {
              if (replacement && directory === root) {
                await rename(absolutePath, `${absolutePath}-old`);
                await symlink(outsideRoot, absolutePath, "dir");
              }
            } },
          }), (error) => error?.problem?.code === (replacement ? "SOURCE_FILESYSTEM_CHANGED" : "SOURCE_DIRECTORY_ESCAPE"));
          assert.equal(readOutside, false);
        });
      }
    });
  });
});

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
