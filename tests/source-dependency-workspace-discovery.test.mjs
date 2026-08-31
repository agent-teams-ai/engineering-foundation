import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  addWorkspacePackage,
  configProblem,
  inspectV2Topology,
  runSourceCapability,
  sourceArchitectureConfig,
  sourceConfigPath,
  withCopiedFixture,
  withTemporaryDirectory,
} from "./helpers/source-dependency-v2-fixture.mjs";

async function addPackageSourceFiles(consumerRoot, paths) {
  for (const path of paths) {
    await writeFile(
      join(consumerRoot, "packages", "app", path),
      "export const siblingSource = true;\n",
      "utf8",
    );
  }
}

test("v2 closes sibling-source escapes deterministically while v1 stays unchanged", async () => {
  const run = (paths) =>
    withCopiedFixture("v2-valid", async (consumerRoot) => {
      await addPackageSourceFiles(consumerRoot, paths);
      return runSourceCapability(consumerRoot);
    });
  const first = await run(["zeta.ts", "alpha.js"]);
  const second = await run(["alpha.js", "zeta.ts"]);
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.deepEqual(
    first.diagnostics.map(({ ruleId, subject }) => ({ ruleId, subject })),
    [
      {
        ruleId: "architecture.source-dependencies.unclassified-source-file",
        subject: "packages/app/alpha.js",
      },
      {
        ruleId: "architecture.source-dependencies.unclassified-source-file",
        subject: "packages/app/zeta.ts",
      },
    ],
  );
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const configPath = sourceConfigPath(consumerRoot);
    const config = await readFile(configPath, "utf8");
    await mkdir(join(consumerRoot, "packages", "app", "decoy"));
    await writeFile(
      join(consumerRoot, "packages", "app", "decoy", "index.ts"),
      "export {};\n",
      "utf8",
    );
    await writeFile(
      configPath,
      config.replaceAll("packages/app/src", "packages/app/decoy"),
      "utf8",
    );
    assert.deepEqual(
      (await runSourceCapability(consumerRoot)).diagnostics.map(({ subject }) => subject),
      ["packages/app/src/index.ts"],
    );
  });
  await withCopiedFixture("valid", async (consumerRoot) => {
    await addPackageSourceFiles(consumerRoot, ["outside-governed.ts"]);
    assert.equal((await runSourceCapability(consumerRoot)).outcome, "passed");
  });
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await writeFile(join(consumerRoot, "root-tool.ts"), "export {};\n", "utf8");
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.outcome, "passed");
    assert.equal(JSON.stringify(report).includes("root-tool.ts"), false);
  });
});

test("v2 retains the root manifest as inventory evidence without governing it", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await mkdir(join(consumerRoot, "tools", "src"), { recursive: true });
    await mkdir(join(consumerRoot, "tools", "src", "hidden"), {
      recursive: true,
    });
    await writeFile(
      join(consumerRoot, "tools", "src", "index.ts"),
      'import { coreValue } from "@fixture/core";\nexport const tool = coreValue;\n',
      "utf8",
    );
    const rootManifestPath = join(consumerRoot, "package.json");
    const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8"));
    rootManifest.dependencies = { "@fixture/core": "workspace:*" };
    await writeFile(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\n`, "utf8");
    await Promise.all([
      writeFile(
        join(consumerRoot, "tools", "src", "hidden", "package.json"),
        '{"name":"@fixture/hidden","version":"0.0.0"}\n',
        "utf8",
      ),
      writeFile(
        join(consumerRoot, "tools", "src", "hidden", "index.ts"),
        'import "outside-policy";\nexport const hidden = true;\n',
        "utf8",
      ),
    ]);
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.outcome, "passed");
    const topology = await inspectV2Topology(consumerRoot);
    assert.deepEqual(
      topology.inventory.packages.map(({ rootPath }) => rootPath),
      [".", "packages/app", "packages/core"],
    );
    assert.deepEqual(
      topology.packages.map(({ rootPath, sourcePaths }) => ({ rootPath, sourcePaths })),
      [
        { rootPath: "packages/app", sourcePaths: ["packages/app/src/index.ts"] },
        { rootPath: "packages/core", sourcePaths: ["packages/core/src/index.ts"] },
      ],
    );
    assert.deepEqual(
      topology.sourceFiles.map(({ path }) => path),
      [
        "packages/app/src/index.ts",
        "packages/core/src/index.ts",
      ],
    );

  });
});

test("v2 package roots are independent of pnpm workspace glob selection", async () => {
  for (const workspaceManifest of [
    "{}\n",
    "packages: []\n",
    'packages:\n  - "packages/missing-*"\n  - "!../outside"\n',
  ]) {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      await writeFile(
        join(consumerRoot, "pnpm-workspace.yaml"),
        workspaceManifest,
        "utf8",
      );

      const report = await runSourceCapability(consumerRoot);
      assert.equal(report.outcome, "passed");
      const topology = await inspectV2Topology(consumerRoot);
      assert.deepEqual(
        topology.packages.map(({ rootPath, sourcePaths }) => ({ rootPath, sourcePaths })),
        [
          { rootPath: "packages/app", sourcePaths: ["packages/app/src/index.ts"] },
          { rootPath: "packages/core", sourcePaths: ["packages/core/src/index.ts"] },
        ],
      );
    });
  }
});

test("v2 rejects pnpm-selected workspace packages outside closed packageRoots", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await mkdir(join(consumerRoot, "tools", "core"), { recursive: true });
    await writeFile(
      join(consumerRoot, "tools", "core", "package.json"),
      '{"name":"@fixture/core","version":"1.0.0"}\n',
      "utf8",
    );
    await writeFile(
      join(consumerRoot, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n  - "tools/*"\n',
      "utf8",
    );
    const configuredCoreManifest = join(consumerRoot, "packages", "core", "package.json");
    const configuredCore = JSON.parse(await readFile(configuredCoreManifest, "utf8"));
    configuredCore.name = "@fixture/configured-core";
    await writeFile(
      configuredCoreManifest,
      `${JSON.stringify(configuredCore, null, 2)}\n`,
      "utf8",
    );
    const appManifestPath = join(consumerRoot, "packages", "app", "package.json");
    const appManifest = JSON.parse(await readFile(appManifestPath, "utf8"));
    appManifest.dependencies = { "@fixture/core": "^1.0.0" };
    await writeFile(appManifestPath, `${JSON.stringify(appManifest, null, 2)}\n`, "utf8");

    const report = await runSourceCapability(consumerRoot);
    assert.deepEqual(
      { code: report.problem?.code, phase: report.problem?.phase },
      {
        code: "WORKSPACE_PACKAGE_OUTSIDE_PACKAGE_ROOTS",
        phase: "source-workspace-topology",
      },
    );
  });
});

test("v2 honors pnpm negative patterns and preserves true external dependencies", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await mkdir(join(consumerRoot, "tools", "excluded"), { recursive: true });
    await writeFile(
      join(consumerRoot, "tools", "excluded", "package.json"),
      '{"name":"external-tool","version":"1.0.0"}\n',
      "utf8",
    );
    await writeFile(
      join(consumerRoot, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n  - "tools/*"\n  - "!tools/*"\n',
      "utf8",
    );
    const appManifestPath = join(consumerRoot, "packages", "app", "package.json");
    const appManifest = JSON.parse(await readFile(appManifestPath, "utf8"));
    appManifest.dependencies = { "external-tool": "1.0.0" };
    await writeFile(appManifestPath, `${JSON.stringify(appManifest, null, 2)}\n`, "utf8");
    await writeFile(
      join(consumerRoot, "packages", "app", "src", "index.ts"),
      'import tool from "external-tool";\nexport { tool };\n',
      "utf8",
    );
    const configPath = sourceConfigPath(consumerRoot);
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        '        - "@fixture/core"',
        '        - "@fixture/core"\n        - external-tool',
      ),
      "utf8",
    );

    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.outcome, "passed", JSON.stringify(report, null, 2));
  });
});

test("v2 bounds pnpm-selected workspace closure discovery", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const toolsRoot = join(consumerRoot, "tools");
    await mkdir(toolsRoot);
    for (let offset = 0; offset < 5_000; offset += 100) {
      await Promise.all(
        Array.from({ length: 100 }, async (_, index) => {
          const packageRoot = join(toolsRoot, `tool-${offset + index}`);
          await mkdir(packageRoot);
          await writeFile(
            join(packageRoot, "package.json"),
            `${JSON.stringify({ name: `tool-${offset + index}`, version: "1.0.0" })}\n`,
            "utf8",
          );
        }),
      );
    }
    await writeFile(
      join(consumerRoot, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n  - "tools/*"\n',
      "utf8",
    );

    const report = await runSourceCapability(consumerRoot);
    assert.deepEqual(
      { code: report.problem?.code, phase: report.problem?.phase },
      { code: "WORKSPACE_LIMIT_EXCEEDED", phase: "workspace-discovery" },
    );
  });
});

test("v2 source closure prunes fixed non-source directories", async () => {
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
    assert.equal(report.outcome, "passed");
    assert.equal(JSON.stringify(report).includes("ignored.ts"), false);
  });
});

test("v2 rejects hostile, aliased, and overlapping package roots", async () => {
  await withTemporaryDirectory(async (consumerRoot) => {
    const hostileRoots = [
      "packages/*",
      "../outside",
      "/absolute",
      "C:relative",
      "C:/absolute",
      "//server/share",
      "\\\\server\\share",
      "packages/con",
      "packages/name:stream",
      "packages/trailing.",
      "packages/trailing ",
    ];
    for (const [index, packageRoot] of hostileRoots.entries()) {
      const problem = await configProblem(
        consumerRoot,
        `hostile-package-root-${index}.yaml`,
        sourceArchitectureConfig(2).replace("  - packages\n", `  - ${JSON.stringify(packageRoot)}\n`),
      );
      assert.ok(
        problem?.code === "SCHEMA_INVALID" ||
          problem?.code === "SOURCE_ARCHITECTURE_CONFIG_INVALID",
        packageRoot,
      );
    }
    const overlap = await configProblem(
      consumerRoot,
      "overlapping-package-roots.yaml",
      sourceArchitectureConfig(2).replace(
        "packageRoots:\n  - packages\n",
        "packageRoots:\n  - packages\n  - packages/app\n",
      ),
    );
    assert.equal(overlap?.code, "SOURCE_ARCHITECTURE_CONFIG_INVALID");
    for (const [index, [left, right]] of [
      ["packages/App", "packages/app"],
      ["packages/caf\u00e9", "packages/cafe\u0301"],
    ].entries()) {
      const first = await configProblem(
        consumerRoot,
        `aliased-package-roots-${index}-a.yaml`,
        sourceArchitectureConfig(2).replace(
          "packageRoots:\n  - packages\n",
          `packageRoots:\n  - ${JSON.stringify(left)}\n  - ${JSON.stringify(right)}\n`,
        ),
      );
      const second = await configProblem(
        consumerRoot,
        `aliased-package-roots-${index}-b.yaml`,
        sourceArchitectureConfig(2).replace(
          "packageRoots:\n  - packages\n",
          `packageRoots:\n  - ${JSON.stringify(right)}\n  - ${JSON.stringify(left)}\n`,
        ),
      );
      assert.equal(first?.code, "SOURCE_ARCHITECTURE_CONFIG_INVALID");
      assert.deepEqual(first, second);
    }
  });
});

function changedIdentity(metadata) {
  return {
    ctimeMs: metadata.ctimeMs,
    dev: metadata.dev,
    ino: typeof metadata.ino === "bigint" ? metadata.ino + 1n : metadata.ino + 1,
    mode: metadata.mode,
    mtimeMs: metadata.mtimeMs,
    size: metadata.size,
    isDirectory: () => metadata.isDirectory(),
    isFile: () => metadata.isFile(),
    isSymbolicLink: () => metadata.isSymbolicLink(),
  };
}

test("v2 uses one workspace snapshot and enforces bounded cancellable discovery", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    let workspaceReads = 0;
    const topology = await inspectV2Topology(consumerRoot, {
      workspaceManifestLoader: async () => {
        workspaceReads += 1;
        return { packages: ["packages/*"] };
      },
    });
    assert.equal(workspaceReads, 1);
    assert.equal(topology.inventory.packages.length, 3);

    for (const [limits, code] of [
      [{ maxDirectoryEntries: 1 }, "SOURCE_DISCOVERY_LIMIT_EXCEEDED"],
      [{ maxManifestFiles: 1 }, "WORKSPACE_LIMIT_EXCEEDED"],
      [{ maxSourceFiles: 1 }, "SOURCE_FILE_LIMIT_EXCEEDED"],
    ]) {
      await assert.rejects(
        () => inspectV2Topology(consumerRoot, { limits }),
        (error) => error?.problem?.code === code,
      );
    }

    const controller = new AbortController();
    let observedSignal;
    await assert.rejects(
      () =>
        inspectV2Topology(
          consumerRoot,
          {
            fileSystem: {
              opendir: async (path, signal) => {
                observedSignal = signal;
                return opendir(path);
              },
            },
            hooks: {
              afterDirectoryRead(repositoryPath) {
                if (repositoryPath === "packages") {
                  controller.abort();
                }
              },
            },
          },
          controller.signal,
        ),
      (error) => error?.problem?.code === "EXECUTION_CANCELLED",
    );
    assert.equal(observedSignal, controller.signal);
  });
});

test("v2 reports cancellation when aborting during directory open", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const controller = new AbortController();
    let observedSignal;
    await assert.rejects(
      () =>
        inspectV2Topology(
          consumerRoot,
          {
            fileSystem: {
              opendir: async (_path, signal) => {
                observedSignal = signal;
                controller.abort();
                throw new Error("directory open interrupted");
              },
            },
          },
          controller.signal,
        ),
      (error) => error?.problem?.code === "EXECUTION_CANCELLED",
    );
    assert.equal(observedSignal, controller.signal);
  });
});

test("v2 closes the directory iterator when aborting during iterator next", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const controller = new AbortController();
    let observedSignal;
    let iteratorReturned = false;
    await assert.rejects(
      () =>
        inspectV2Topology(
          consumerRoot,
          {
            fileSystem: {
              opendir: async (_path, signal) => {
                observedSignal = signal;
                return {
                  [Symbol.asyncIterator]() {
                    return {
                      async next() {
                        controller.abort();
                        throw new Error("directory iteration interrupted");
                      },
                      async return() {
                        iteratorReturned = true;
                        return { done: true, value: undefined };
                      },
                    };
                  },
                };
              },
            },
          },
          controller.signal,
        ),
      (error) => error?.problem?.code === "EXECUTION_CANCELLED",
    );
    assert.equal(observedSignal, controller.signal);
    assert.equal(iteratorReturned, true);
  });
});

test("v2 fails closed on deterministic directory identity replacement", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const canonicalRoot = await realpath(consumerRoot);
    const replacedPath = join(canonicalRoot, "packages", "app");
    let replaceIdentity = false;
    await assert.rejects(
      () =>
        inspectV2Topology(consumerRoot, {
          fileSystem: {
            lstat: async (path) => {
              const metadata = await lstat(path, { bigint: true });
              return replaceIdentity && path === replacedPath
                ? changedIdentity(metadata)
                : metadata;
            },
            stat: async (path) => {
              const metadata = await stat(path, { bigint: true });
              return replaceIdentity && path === replacedPath
                ? changedIdentity(metadata)
                : metadata;
            },
          },
          hooks: {
            afterDirectoryRead(repositoryPath) {
              if (repositoryPath === "packages/app/src") {
                replaceIdentity = true;
              }
            },
          },
        }),
      (error) => error?.problem?.code === "SOURCE_FILESYSTEM_CHANGED",
    );
  });
});

test("v2 reports cancellation during final filesystem revalidation", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await mkdir(join(consumerRoot, "packages", "final", "src"), {
      recursive: true,
    });
    await Promise.all([
      writeFile(
        join(consumerRoot, "packages", "final", "package.json"),
        '{"name":"@fixture/final","version":"0.0.0","private":true}\n',
        "utf8",
      ),
      writeFile(
        join(consumerRoot, "packages", "final", "src", "index.ts"),
        "export const finalSource = true;\n",
        "utf8",
      ),
    ]);
    const configPath = sourceConfigPath(consumerRoot);
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${config.trimEnd()}\n  - id: final.surface\n    roots:\n      - packages/final/src/index.ts\n    entrypoints:\n      - packages/final/src/index.ts\n    allow:\n      boundaries: []\n      packages: []\n      builtins: []\n      runtimeReferences: []\n`.replace(
        "governedRoots:\n",
        "governedRoots:\n  - packages/final/src\n",
      ),
      "utf8",
    );

    const canonicalRoot = await realpath(consumerRoot);
    const finalBoundaryPath = join(
      canonicalRoot,
      "packages",
      "final",
      "src",
      "index.ts",
    );
    const controller = new AbortController();
    let finalBoundaryStats = 0;
    await assert.rejects(
      () =>
        inspectV2Topology(
          consumerRoot,
          {
            fileSystem: {
              stat: async (path) => {
                const metadata = await stat(path, { bigint: true });
                if (path === finalBoundaryPath) {
                  finalBoundaryStats += 1;
                  if (finalBoundaryStats === 2) {
                    controller.abort();
                  }
                }
                return metadata;
              },
            },
          },
          controller.signal,
        ),
      (error) => error?.problem?.code === "EXECUTION_CANCELLED",
    );
    assert.equal(finalBoundaryStats, 2);
  });
});

test("v2 rejects unavailable roots and roots outside selected packages", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const configPath = sourceConfigPath(consumerRoot);
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replaceAll("packages/core/src", "packages/core/missing"),
      "utf8",
    );
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.problem.code, "SOURCE_DIRECTORY_UNAVAILABLE");
  });
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await mkdir(join(consumerRoot, "tools", "src"), { recursive: true });
    await Promise.all([
      writeFile(
        join(consumerRoot, "tools", "package.json"),
        '{"name":"@fixture/unselected-tools","version":"0.0.0"}\n',
        "utf8",
      ),
      writeFile(
        join(consumerRoot, "tools", "src", "index.ts"),
        "export const tool = true;\n",
        "utf8",
      ),
    ]);
    const configPath = sourceConfigPath(consumerRoot);
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replaceAll("packages/core/src", "tools/src"),
      "utf8",
    );
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.problem.code, "SOURCE_ROOT_OUTSIDE_WORKSPACE");
  });
});

test("v2 rejects boundary roots inside nested unselected packages", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await mkdir(join(consumerRoot, "tools", "excluded", "src"), {
      recursive: true,
    });
    await Promise.all([
      writeFile(
        join(consumerRoot, "tools", "excluded", "package.json"),
        '{"name":"@fixture/excluded-tools","version":"0.0.0"}\n',
        "utf8",
      ),
      writeFile(
        join(consumerRoot, "tools", "excluded", "src", "index.ts"),
        "export const excludedTool = true;\n",
        "utf8",
      ),
    ]);
    const configPath = sourceConfigPath(consumerRoot);
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config
        .replace("  - packages/core/src", "  - tools")
        .replaceAll("packages/core/src", "tools/excluded/src"),
      "utf8",
    );

    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.problem.code, "SOURCE_ROOT_OUTSIDE_WORKSPACE");
  });
});

test("v2 reports source outside a package's declared boundary", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const configPath = sourceConfigPath(consumerRoot);
    const config = await readFile(configPath, "utf8");
    await mkdir(join(consumerRoot, "packages", "app", "src", "covered"));
    await writeFile(
      configPath,
      config.replace(
        "    roots:\n      - packages/app/src\n    entrypoints:\n      - packages/app/src/index.ts",
        "    roots:\n      - packages/app/src/covered\n    entrypoints: []",
      ),
      "utf8",
    );
    const report = await runSourceCapability(consumerRoot);
    assert.equal(
      report.diagnostics.some(
        ({ ruleId, subject }) =>
          ruleId === "architecture.source-dependencies.unclassified-source-file" &&
          subject === "packages/app/src/index.ts",
      ),
      true,
    );
  });
});

test("v2 rejects symlink escapes and duplicate realpaths", async (t) => {
  if (process.platform === "win32") {
    t.skip("portable symlink qualification runs on POSIX");
    return;
  }
  const outsideRoot = await mkdtemp(join(tmpdir(), "foundation-source-outside-"));
  try {
    await Promise.all([
      writeFile(join(outsideRoot, "index.ts"), "export const outside = true;\n", "utf8"),
      writeFile(
        join(outsideRoot, "package.json"),
        '{"name":"@fixture/outside","version":"0.0.0"}\n',
        "utf8",
      ),
    ]);
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      const sourceRoot = join(consumerRoot, "packages", "app", "src");
      await rm(sourceRoot, { recursive: true });
      await symlink(outsideRoot, sourceRoot, "dir");
      const report = await runSourceCapability(consumerRoot);
      assert.equal(report.problem.code, "SOURCE_DIRECTORY_ESCAPE");
      assert.equal(JSON.stringify(report).includes(outsideRoot), false);
    });
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      await symlink(outsideRoot, join(consumerRoot, "packages", "escaped"), "dir");
      const report = await runSourceCapability(consumerRoot);
      assert.equal(report.problem.code, "SOURCE_SYMLINK_PROHIBITED");
      assert.equal(JSON.stringify(report).includes(outsideRoot), false);
    });
  } finally {
    await rm(outsideRoot, { force: true, recursive: true });
  }
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const appRoot = join(consumerRoot, "packages", "app");
    await symlink(join(appRoot, "src"), join(appRoot, "source-alias"), "dir");
    const configPath = sourceConfigPath(consumerRoot);
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replaceAll("packages/app/src", "packages/app/source-alias"),
      "utf8",
    );
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.problem.code, "SOURCE_SYMLINK_PROHIBITED");
  });
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const appRoot = join(consumerRoot, "packages", "app");
    await symlink(join(appRoot, "src"), join(appRoot, "linked-source"), "dir");
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.problem.code, "SOURCE_SYMLINK_PROHIBITED");
  });
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const appRoot = join(consumerRoot, "packages", "app");
    await symlink(join(appRoot, "src"), join(appRoot, "source-alias"), "dir");
    const configPath = sourceConfigPath(consumerRoot);
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${config
        .replace(
          "  - packages/app/src\n",
          "  - packages/app/src\n  - packages/app/source-alias\n",
        )
        .trimEnd()}\n  - id: app.alias\n    roots:\n      - packages/app/source-alias\n    entrypoints:\n      - packages/app/source-alias/index.ts\n    allow:\n      boundaries: []\n      packages: []\n      builtins: []\n      runtimeReferences: []\n`,
      "utf8",
    );
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.problem.code, "SOURCE_ROOT_REALPATH_DUPLICATE");
    assert.equal(JSON.stringify(report).includes(consumerRoot), false);
  });
});

async function runDiscoveryOrderingFixture(names) {
  return withCopiedFixture("v2-valid", async (consumerRoot) => {
    for (const name of names) {
      await addWorkspacePackage(consumerRoot, name);
    }
    return (await runSourceCapability(consumerRoot)).diagnostics;
  });
}

test("v2 diagnostics are deterministic and package cycles still use the graph analyzer", async () => {
  const first = await runDiscoveryOrderingFixture(["zeta", "alpha"]);
  const second = await runDiscoveryOrderingFixture(["alpha", "zeta"]);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map(({ subject }) => subject),
    ["packages/alpha", "packages/zeta"],
  );

  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const manifestPath = join(consumerRoot, "packages", "core", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.dependencies = { "@fixture/app": "workspace:*" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(
      join(consumerRoot, "packages", "core", "src", "index.ts"),
      'import { appValue } from "@fixture/app";\nexport const coreValue = appValue;\n',
      "utf8",
    );
    const configPath = sourceConfigPath(consumerRoot);
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        "  - id: core.surface\n    roots:\n      - packages/core/src\n    entrypoints:\n      - packages/core/src/index.ts\n    allow:\n      boundaries: []\n      packages: []",
        '  - id: core.surface\n    roots:\n      - packages/core/src\n    entrypoints:\n      - packages/core/src/index.ts\n    allow:\n      boundaries: []\n      packages:\n        - "@fixture/app"',
      ),
      "utf8",
    );
    const report = await runSourceCapability(consumerRoot);
    assert.equal(
      report.diagnostics.some(
        ({ ruleId }) => ruleId === "architecture.source-dependencies.package-runtime-cycle",
      ),
      true,
    );
  });
});
