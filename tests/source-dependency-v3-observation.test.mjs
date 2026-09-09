import assert from "node:assert/strict";
import { mkdir, opendir, readFile, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { sourceDependencyAdapters, sourceTopologyAdapters } from "./support/capability-adapters.mjs";
import { createWorkspaceInventoryReader, foundationPackageRoot, loadCapabilityConfig, runSourceCapability, signalThatFailsAfterConfiguration } from "./helpers/source-dependency-v2-fixture.mjs";
import {
  inspectV3Topology, saveV3Policy, withV3Fixture, writeV3File,
} from "./helpers/source-dependency-v3-fixture.mjs";

const expectedOwners = [
  { rootPath: ".", sourcePaths: ["tooling/task/src/index.ts"] },
  { rootPath: "packages/contexts/supply", sourcePaths: ["packages/contexts/supply/src/index.ts"] },
  { rootPath: "packages/domain", sourcePaths: ["packages/domain/src/index.ts"] },
];

function owners(topology) {
  return topology.packages.map(({ rootPath, sourcePaths }) => ({ rootPath, sourcePaths }))
    .toSorted((left, right) => left.rootPath < right.rootPath ? -1 : 1);
}

test("v3 redundant containers and reversed enumeration retain unique source ownership", async () => {
  await withV3Fixture(async (root, policy) => {
    const observations = [];
    const budgetPaths = ["package.json", "packages/domain/package.json",
      "packages/contexts/supply/package.json", ...expectedOwners.flatMap(({ sourcePaths }) => sourcePaths)];
    const exactByteBudget = (await Promise.all(budgetPaths.map((path) => readFile(join(root, path)))))
      .reduce((total, bytes) => total + bytes.byteLength, 0);
    for (const selectors of [
      ["packages", "packages/contexts"],
      ["packages/contexts", "packages"],
      ["packages/domain", "packages/contexts", "packages"],
    ]) {
      policy.packageRoots = selectors;
      await saveV3Policy(root, policy);
      const directories = new Map();
      const topology = await inspectV3Topology(root, {
        fileSystem: {
          async opendir(path) {
            const entries = [];
            for await (const entry of await opendir(path)) {
              entries.push(entry);
            }
            return { async *[Symbol.asyncIterator]() { yield* entries.toReversed(); } };
          },
        },
        hooks: { afterDirectoryRead(path) {
          directories.set(path, (directories.get(path) ?? 0) + 1);
        } },
        limits: { maxSourceFiles: 3, maxTotalSourceBytes: exactByteBudget },
      });
      assert.deepEqual(owners(topology), expectedOwners);
      assert.equal(topology.sourceFiles.length, 3);
      assert.equal(new Set(topology.sourceFiles.map(({ path }) => path)).size, 3);
      assert.ok([...directories.values()].every((count) => count === 1), JSON.stringify([...directories]));
      observations.push(topology.sourceFiles);
    }
    assert.deepEqual(observations[0], observations[1]);
    assert.deepEqual(observations[0], observations[2]);
  });
});

for (const [limits, code] of [
  [{ maxDirectoryEntries: 1 }, "SOURCE_DISCOVERY_LIMIT_EXCEEDED"],
  [{ maxManifestFiles: 1 }, "WORKSPACE_LIMIT_EXCEEDED"],
  [{ maxSourceFiles: 2 }, "SOURCE_FILE_LIMIT_EXCEEDED"],
  [{ maxSourceFileBytes: 1024 }, "SOURCE_FILE_INVALID"],
  [{ maxTotalSourceBytes: 4096 }, "SOURCE_TOTAL_BYTES_EXCEEDED"],
]) {
  test(`v3 bounded overlap refuses ${Object.keys(limits)[0]}`, async () => {
    await withV3Fixture(async (root, policy) => {
      assert.deepEqual(owners(await inspectV3Topology(root)), expectedOwners);
      policy.packageRoots.push("packages/domain");
      await saveV3Policy(root, policy);
      if (limits.maxSourceFileBytes !== undefined || limits.maxTotalSourceBytes !== undefined) {
        await writeV3File(root, "tooling/task/src/index.ts", `/*${"x".repeat(8192)}*/\n`);
      }
      await assert.rejects(() => inspectV3Topology(root, { limits }),
        (error) => error?.problem?.code === code);
    });
  });
}

for (const owner of ["tooling/task", "packages/domain"]) {
  for (const placement of ["above", "below"]) {
  for (const mutation of [
    { name: "@fixture/changed" }, { dependencies: {} }, { exports: null },
    { unknown: true }, { type: "commonjs" }, "whitespace", "remove",
  ]) {
    test(`v3 ${placement} ${owner} marker observation rejects ${JSON.stringify(mutation)}`, async () => {
      await withV3Fixture(async (root, policy) => {
        const scope = placement === "above" ? `${owner}/marker` : `${owner}/src/scoped`;
        const path = `${scope}/package.json`;
        if (placement === "above") {
          const index = policy.governedRoots.indexOf(`${owner}/src`);
          policy.governedRoots[index] = `${scope}/src`;
          policy.boundaries[index].roots = [`${scope}/src`];
          policy.boundaries[index].entrypoints = [`${scope}/src/index.ts`];
          await rm(join(root, owner, "src"), { recursive: true });
          await writeV3File(root, `${scope}/src/index.ts`, "export {};\n");
          await saveV3Policy(root, policy);
        }
        await writeV3File(root, path, { type: "module" });
        if (placement === "below") {
          await writeV3File(root, `${scope}/index.ts`, "export {};\n");
        }
        await inspectV3Topology(root);
        const reader = createWorkspaceInventoryReader();
        let mutated = false;
        await assert.rejects(() => inspectV3Topology(root, {
          inventoryReader: {
            discoverManifestPathsFromManifest: (...args) => reader.discoverManifestPathsFromManifest(...args),
            async readFromManifestPaths(...args) {
              const inventory = await reader.readFromManifestPaths(...args);
              if (mutation === "remove") {
                await rm(join(root, path));
              } else {
                await writeV3File(root, path, mutation === "whitespace"
                  ? '{ "type" : "module" }\n' : { type: "module", ...mutation });
              }
              mutated = true;
              return inventory;
            },
          },
        }), (error) => error?.problem?.code === "SOURCE_FILESYSTEM_CHANGED");
        assert.equal(mutated, true, "the marker must be mutated after its initial observation");
      });
    });
  }
}

}

test("v3 root declaration bytes cannot change after inventory observation", async () => {
  await withV3Fixture(async (root) => {
    await inspectV3Topology(root);
    const reader = createWorkspaceInventoryReader();
    let mutated = false;
    await assert.rejects(() => inspectV3Topology(root, {
      inventoryReader: {
        discoverManifestPathsFromManifest: (...args) => reader.discoverManifestPathsFromManifest(...args),
        async readFromManifestPaths(...args) {
          const inventory = await reader.readFromManifestPaths(...args);
          const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
          manifest.dependencies = { "outside-policy": "1.0.0" };
          await writeV3File(root, "package.json", manifest);
          mutated = true;
          return inventory;
        },
      },
    }), (error) => error?.problem?.code === "SOURCE_FILESYSTEM_CHANGED");
    assert.equal(mutated, true);
  });
});

test("v3 cancellation during root discovery never yields a successful snapshot", async () => {
  await withV3Fixture(async (root) => {
    await inspectV3Topology(root);
    const controller = new AbortController();
    let cancelled = false;
    await assert.rejects(() => inspectV3Topology(root, {
      hooks: { afterDirectoryRead(path) {
        if (path === "tooling/task/src") {
          cancelled = true;
          controller.abort();
        }
      } },
    }, controller.signal), (error) => error?.problem?.code === "EXECUTION_CANCELLED");
    assert.equal(cancelled, true);
  });
});

for (const path of [
  "tooling/package.json", "tooling/task/package.json",
  "tooling/task/src/package.json", "tooling/task/src/new.ts",
]) {
  test(`v3 newly added observation at ${path} invalidates the snapshot`, async () => {
    await withV3Fixture(async (root) => {
      await inspectV3Topology(root);
      const reader = createWorkspaceInventoryReader();
      let mutated = false;
      await assert.rejects(() => inspectV3Topology(root, {
        inventoryReader: {
          discoverManifestPathsFromManifest: (...args) => reader.discoverManifestPathsFromManifest(...args),
          async readFromManifestPaths(...args) {
            const inventory = await reader.readFromManifestPaths(...args);
            await writeV3File(root, path, path.endsWith(".ts")
              ? "export {};\n" : { name: "@fixture/late-owner" });
            mutated = true;
            return inventory;
          },
        },
      }), (error) => error?.problem?.code === "SOURCE_FILESYSTEM_CHANGED");
      assert.equal(mutated, true);
    });
  });
}

for (const owner of [".", "packages/domain"]) {
  for (const mutation of [
    { name: "@fixture/fence" }, { dependencies: {} }, { exports: null },
    { unknown: true }, { type: "commonjs" }, "whitespace", "remove", "add",
  ]) {
    test(`v3 ${owner} generated target rejects marker mutation ${JSON.stringify(mutation)}`, async (t) => {
      await withV3Fixture(async (root) => {
        const distRoot = process.env.FOUNDATION_DIST_ROOT ?? join(foundationPackageRoot, "dist");
        const { generatedOutputFilesystemIsSafe } = await import(pathToFileURL(join(distRoot,
          "capabilities/source-dependencies/adapters/outbound/node/generated-output-filesystem.js")).href);
        const directory = owner === "." ? "dist/scoped" : `${owner}/dist/scoped`;
        const marker = join(root, directory, "package.json");
        await writeV3File(root, `${directory}/package.json`, { type: "module" });
        if (mutation === "add") { await rm(marker); }
        const input = {
          consumerRoot: root, packageRoot: owner,
          target: `${directory}/missing.js`, enforceManifestFences: true,
        };
        assert.equal(generatedOutputFilesystemIsSafe(input), true);
        const original = fs.lstatSync;
        let mutated = false;
        t.mock.method(fs, "lstatSync", function (path, ...args) {
          if (!mutated && path === join(root, input.target)) {
            mutated = true;
            if (mutation === "remove") {
              fs.unlinkSync(marker);
            } else {
              fs.writeFileSync(marker, mutation === "whitespace" ? '{ "type" : "module" }\n'
                : JSON.stringify(mutation === "add" ? { type: "module" }
                  : { type: "module", ...mutation }));
            }
          }
          return original.call(fs, path, ...args);
        });
        syncBuiltinESMExports();
        try {
          assert.equal(generatedOutputFilesystemIsSafe(input), false,
            "a stable positive cannot authorize a changed marker or observed absence");
          assert.equal(mutated, true);
        } finally {
          t.mock.restoreAll();
          syncBuiltinESMExports();
        }
      });
    });
  }
}

for (const replacement of ["directory", "symlink", "root-name", "manifest-identity"]) {
  test(`v3 inventory bracket rejects replaced ${replacement}`, async () => {
    await withV3Fixture(async (root) => {
      await inspectV3Topology(root);
      const reader = createWorkspaceInventoryReader();
      let mutated = false;
      await assert.rejects(() => inspectV3Topology(root, {
        inventoryReader: {
          discoverManifestPathsFromManifest: (...args) => reader.discoverManifestPathsFromManifest(...args),
          async readFromManifestPaths(...args) {
            const inventory = await reader.readFromManifestPaths(...args);
            if (replacement === "root-name" || replacement === "manifest-identity") {
              const path = join(root, "package.json");
              const bytes = await readFile(path, "utf8");
              if (replacement === "manifest-identity") {
                await rename(path, `${path}.original`);
                await writeV3File(root, "package.json", bytes);
              } else {
                await writeV3File(root, "package.json", {
                  ...JSON.parse(bytes), name: "@fixture/replaced-root",
                });
              }
            } else {
              const path = join(root, "tooling/task/src");
              await rename(path, `${path}-original`);
              if (replacement === "symlink") {
                await symlink(`${path}-original`, path, "dir");
              } else {
                await writeV3File(root, "tooling/task/src/index.ts", "export const value = 1;\n");
              }
            }
            mutated = true;
            return inventory;
          },
        },
      }), (error) => error?.problem?.code === "SOURCE_FILESYSTEM_CHANGED");
      assert.equal(mutated, true);
    });
  });
}

test("v3 reports requested version through cancellation and unexpected failure", async () => {
  await withV3Fixture(async (root) => {
    const controller = new AbortController();
    controller.abort();
    for (const [signal, outcome, code] of [
      [controller.signal, "cancelled", "EXECUTION_CANCELLED"],
      [signalThatFailsAfterConfiguration(), "failed", "UNEXPECTED_FAILURE"],
    ]) {
      const report = await runSourceCapability(root, signal);
      assert.equal(report.capabilityConfigSchemaVersion, 3);
      assert.equal(report.outcome, outcome);
      assert.equal(report.problem.code, code);
    }
  });
});

test("v3 overlapping selectors parse each source exactly once through the real analyzer", async () => {
  await withV3Fixture(async (root, policy) => {
    const distRoot = process.env.FOUNDATION_DIST_ROOT ?? join(foundationPackageRoot, "dist");
    const load = (path) => import(pathToFileURL(join(distRoot,
      "capabilities/source-dependencies", path)).href);
    const [{ analyzeSourceDependencies }, { OxcSourceDependencyParser }, { NodeSourceDependencyResolver }] =
      await Promise.all([
        load("application/use-cases/analyze-source-dependencies.js"),
        load("adapters/outbound/oxc/oxc-source-dependency-parser.js"),
        load("adapters/outbound/node/node-source-dependency-resolver.js"),
      ]);
    policy.boundaries.at(-1).allow.packages = ["@fixture/domain"];
    await writeV3File(root, "tooling/task/src/index.ts", 'import "@fixture/domain";\nimport "node:fs";\n');
    const graphs = [];
    for (const selectors of [
      ["packages", "packages/contexts"],
      ["packages/contexts", "packages/domain", "packages"],
    ]) {
      policy.packageRoots = selectors;
      await saveV3Policy(root, policy);
      const parser = new OxcSourceDependencyParser();
      const parsed = [];
      const resolved = [];
      const resolver = new NodeSourceDependencyResolver();
      const diagnostics = await analyzeSourceDependencies({
        consumerRoot: root,
        policy: await loadCapabilityConfig(root, "architecture/foundation/source-dependencies.yaml"),
      }, {
        ...sourceDependencyAdapters(),
        topologyInspector: { inspect: () => inspectV3Topology(root) },
        resolver: { resolve(input) {
          const result = resolver.resolve(input);
          resolved.push({ reference: input.reference, result });
          return result;
        } },
        parser: { parse(file) { parsed.push(file.path); return parser.parse(file); } },
      });
      assert.deepEqual(diagnostics.map(({ ruleId }) => ruleId), [
        "architecture.source-dependencies.forbidden-builtin-dependency",
      ]);
      assert.equal(resolved.length, 2);
      graphs.push({ resolved, diagnostics });
      assert.deepEqual(parsed.toSorted(), expectedOwners.flatMap(({ sourcePaths }) => sourcePaths).toSorted());
    }
    assert.deepEqual(graphs[0], graphs[1]);
  });
});

for (const candidate of ["tooling/package.json", "tooling/task/src/index.ts"]) {
  test(`v3 cancellation during contained read of ${candidate} preserves cancellation`, async () => {
    await withV3Fixture(async (root) => {
      await writeV3File(root, "tooling/package.json", { type: "module" });
      await inspectV3Topology(root);
      const controller = new AbortController();
      const files = sourceTopologyAdapters().fileReader;
      let cancelled = false;
      await assert.rejects(() => inspectV3Topology(root, {
        fileSystem: { async readContainedFile(input) {
          const bytes = await files.read(input);
          if (input.candidate === join(root, candidate)) {
            cancelled = true;
            controller.abort();
          }
          return bytes;
        } },
      }, controller.signal), (error) => error?.problem?.code === "EXECUTION_CANCELLED");
      assert.equal(cancelled, true);
    });
  });
}

test("v3 refuses replacement of the consumer root after inventory", async () => {
  await withV3Fixture(async (root) => {
    await inspectV3Topology(root);
    const reader = createWorkspaceInventoryReader();
    let moved = false;
    try {
      await assert.rejects(() => inspectV3Topology(root, {
        inventoryReader: {
          discoverManifestPathsFromManifest: (...args) => reader.discoverManifestPathsFromManifest(...args),
          async readFromManifestPaths(...args) {
            const inventory = await reader.readFromManifestPaths(...args);
            await rename(root, `${root}-original`);
            moved = true;
            await mkdir(root);
            return inventory;
          },
        },
      }), (error) => error?.problem?.code === "SOURCE_FILESYSTEM_CHANGED");
      assert.equal(moved, true);
    } finally {
      if (moved) {
        await rm(root, { force: true, recursive: true });
        await rename(`${root}-original`, root);
      }
    }
  });
});
