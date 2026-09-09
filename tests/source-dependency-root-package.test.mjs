import assert from "node:assert/strict";
import test from "node:test";
import { join, normalize } from "node:path";
import { sourceConfigPath } from "./helpers/source-dependency-v2-fixture.mjs";
import { opendir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import {
  assertV3Problem, assertV3Rule, checkV3, inspectV3Topology, saveV3Policy,
  v3Boundary, withV3Fixture, writeV3File,
} from "./helpers/source-dependency-v3-fixture.mjs";

for (const rootOnly of [true, false]) {
  test(`v3 public CLI admits ${rootOnly ? "root-only" : "mixed nested"} source ownership`, async () => {
    await withV3Fixture((root) => checkV3(root), { rootOnly });
  });
}

for (const [name, mutate] of [
  ["unknown key", (policy) => { policy.rootScopes = []; }],
  ["missing selectors", (policy) => { delete policy.packageRoots; }],
  ["missing workspace", (policy) => { delete policy.workspace; }],
  ["empty selectors without opt-in", (policy) => {
    policy.packageRoots = [];
    delete policy.rootPackage;
  }],
  ["duplicate selectors", (policy) => { policy.packageRoots.push("packages"); }],
  ["dot governed root", (policy) => { policy.governedRoots[0] = "."; }],
  ["dot boundary root", (policy) => { policy.boundaries[0].roots = ["."]; }],
  ["dot entrypoint", (policy) => { policy.boundaries[0].entrypoints = ["."]; }],
]) {
  test(`v3 closed schema refuses ${name}`, async () => {
    await withV3Fixture(async (root, policy) => {
      checkV3(root);
      mutate(policy);
      await saveV3Policy(root, policy);
      assertV3Problem(root, "SCHEMA_INVALID");
    });
  });
}

test("v3 duplicate YAML keys cannot override root authority", async () => {
  await withV3Fixture(async (root) => {
    checkV3(root);
    await writeFile(sourceConfigPath(root), "schemaVersion: 3\nrootPackage: true\nrootPackage: false\n");
    const report = checkV3(root, "invalid-input", 2);
    assert.equal(report.problem.code, "YAML_INVALID");
    assert.equal(report.problem.phase, "source-architecture-config");
  });
});

for (const type of ["module", "commonjs"]) {
  test(`v3 selected ${type} marker remains a scope under redundant selectors and pnpm globs`, async () => {
    await withV3Fixture(async (root, policy) => {
      const scope = "packages/domain/src/scoped";
      await writeV3File(root, `${scope}/package.json`, { type });
      await writeV3File(root, `${scope}/index.ts`, "export {};\n");
      policy.packageRoots.push("packages/domain");
      await saveV3Policy(root, policy);
      await writeV3File(root, "pnpm-workspace.yaml",
        `packages:\n  - packages/*\n  - packages/contexts/*\n  - ${scope}\n`);
      checkV3(root);
      await writeV3File(root, `${scope}/index.ts`, 'import "node:fs";\n');
      assertV3Rule(root, "forbidden-builtin-dependency", `${scope}/index.ts`);
    });
  });
}

test("v3 root opt-in is required and must own a governed scope", async () => {
  await withV3Fixture(async (root, policy) => {
    checkV3(root);
    delete policy.rootPackage;
    await saveV3Policy(root, policy);
    assertV3Problem(root, "SOURCE_ROOT_OUTSIDE_WORKSPACE", "tooling/task/src");
    policy.rootPackage = true;
    policy.governedRoots.pop();
    policy.boundaries.pop();
    await saveV3Policy(root, policy);
    assertV3Problem(root, "SOURCE_ROOT_PACKAGE_SCOPE_EMPTY");
  });
});

test("v3 every selected root reaches the real parser and builtin policy", async () => {
  await withV3Fixture(async (root, policy) => {
    checkV3(root);
    for (const path of policy.governedRoots) {
      await writeV3File(root, `${path}/index.ts`, 'import "node:fs";\n');
      assertV3Rule(root, "forbidden-builtin-dependency", `${path}/index.ts`);
      await writeV3File(root, `${path}/index.ts`, "export const value = 1;\n");
    }
  });
});

for (const owner of ["tooling/task", "packages/domain"]) {
  for (const type of ["module", "commonjs"]) {
    for (const placement of ["above", "below"]) {
      test(`v3 ${type} marker ${placement} ${owner} source preserves ownership and nested output checks`, async () => {
        await withV3Fixture(async (root, policy) => {
          const scope = placement === "above" ? `${owner}/marker` : `${owner}/src/scoped`;
          // Above-start control uses a new explicitly governed source root.
          if (placement === "above") {
            policy.governedRoots.push(`${scope}/src`);
            policy.boundaries.push(v3Boundary("marker", `${scope}/src`));
            await writeV3File(root, `${scope}/src/index.ts`, "export {};\n");
            await saveV3Policy(root, policy);
          }
          await writeV3File(root, `${scope}/package.json`, { type });
          const source = placement === "above" ? `${scope}/src` : scope;
          const paths = [`${source}/coverage/check.ts`, `${source}/dist/check.mjs`];
          for (const path of paths) {
            await writeV3File(root, path, "export {};\n");
          }
          checkV3(root);
          for (const path of paths) {
            await writeV3File(root, path, 'import "node:fs";\n');
          }
          const report = assertV3Rule(root, "forbidden-builtin-dependency", paths[0]);
          assert.deepEqual(report.diagnostics.filter(({ ruleId }) =>
            ruleId.endsWith(".forbidden-builtin-dependency")).map(({ location }) => location.path), paths);
        });
      });
    }
  }
}

for (const fields of [
  { name: "@fixture/fence" }, { dependencies: {} }, { devDependencies: {} },
  { optionalDependencies: {} }, { peerDependencies: {} }, { exports: null },
  { scripts: {} }, { imports: {} }, { main: "index.js" }, { version: "1.0.0" },
  { packageManager: "pnpm@11.20.0" }, { bundleDependencies: [] },
  { bundledDependencies: [] }, { unknown: true },
]) {
  test(`v3 marker plus ${Object.keys(fields)[0]} is an ownership fence`, async () => {
    await withV3Fixture(async (root) => {
      const path = "tooling/task/src/scoped/package.json";
      await writeV3File(root, path, { type: "module" });
      await writeV3File(root, "tooling/task/src/scoped/index.ts", "export {};\n");
      checkV3(root);
      await writeV3File(root, path, { type: "module", ...fields });
      assertV3Problem(root, "WORKSPACE_PACKAGE_OUTSIDE_PACKAGE_ROOTS", path);
    });
  });
}

for (const path of ["tooling/package.json", "tooling/task/package.json", "tooling/task/src/package.json"]) {
  test(`v3 ancestor authority fences root scope at ${path}`, async () => {
    await withV3Fixture(async (root) => {
      checkV3(root);
      await writeV3File(root, path, {});
      assertV3Problem(root, "WORKSPACE_PACKAGE_OUTSIDE_PACKAGE_ROOTS", path);
    });
  });
}

test("v3 loose selector source cannot broaden root ownership", async () => {
  await withV3Fixture(async (root) => {
    checkV3(root);
    await writeV3File(root, "packages/loose.ts", "export {};\n");
    assertV3Problem(root, "SOURCE_OUTSIDE_PACKAGE", "packages/loose.ts");
  });
});

test("v3 selected package source outside governed roots remains unclassified", async () => {
  await withV3Fixture(async (root) => {
    checkV3(root);
    await writeV3File(root, "packages/domain/loose.ts", "export {};\n");
    assertV3Rule(root, "unclassified-source-file", "packages/domain/loose.ts");
  });
});

// V3 keeps direct-child selection while permitting redundant traversal starts.
for (const path of ["packages/new", "packages/contexts/new"]) {
  for (const sourceBearing of [false, true]) {
    test(`v3 discovers excluded ${sourceBearing ? "source-bearing" : "manifest-only"} ${path}`, async () => {
      await withV3Fixture(async (root) => {
        checkV3(root);
        await writeV3File(root, "pnpm-workspace.yaml",
          `packages:\n  - packages/*\n  - packages/contexts/*\n  - '!${path}'\n`);
        await writeV3File(root, `${path}/package.json`, { name: "@fixture/new", private: true });
        if (sourceBearing) {
          await writeV3File(root, `${path}/index.ts`, "export {};\n");
        }
        assertV3Rule(root, "uncovered-workspace-package-root", path);
      });
    });
  }
}

for (const path of ["packages/contexts/supply/deeper", "apps/new"]) {
  test(`v3 does not recursively select ${path}`, async () => {
    await withV3Fixture(async (root) => {
      checkV3(root);
      await writeV3File(root, `${path}/package.json`, { name: "@fixture/new", private: true });
      assertV3Problem(root, "WORKSPACE_PACKAGE_OUTSIDE_PACKAGE_ROOTS", `${path}/package.json`);
    });
  });
}

test("v3 recommended overlapping selection preserves nested direct-child meaning", async () => {
  await withV3Fixture(async (root, policy) => {
    const positive = checkV3(root);
    policy.packageRoots.reverse();
    await saveV3Policy(root, policy);
    assert.deepEqual(checkV3(root), positive);
    policy.packageRoots.push("packages/domain");
    await saveV3Policy(root, policy);
    assert.deepEqual(checkV3(root), positive);
    policy.packageRoots = ["packages"];
    await saveV3Policy(root, policy);
    assertV3Problem(root, "WORKSPACE_PACKAGE_OUTSIDE_PACKAGE_ROOTS", "packages/contexts/supply/package.json");
  });
});

for (const rootPackage of [false, null, "true", {}]) {
  test(`v3 rejects nonliteral root opt-in ${JSON.stringify(rootPackage)}`, async () => {
    await withV3Fixture(async (root, policy) => {
      checkV3(root);
      policy.rootPackage = rootPackage;
      await saveV3Policy(root, policy);
      assertV3Problem(root, "SCHEMA_INVALID");
    });
  });
}

for (const path of [".", "../packages", "packages/*", "packages\\domain"]) {
  test(`v3 refuses nonportable selector ${path}`, async () => {
    await withV3Fixture(async (root, policy) => {
      checkV3(root);
      policy.packageRoots = [path];
      await saveV3Policy(root, policy);
      assertV3Problem(root, "SCHEMA_INVALID");
    });
  });
}

test("v3 root package dependency declarations and allowlists are independent", async () => {
  await withV3Fixture(async (root, policy) => {
    const boundary = policy.boundaries.at(-1);
    const path = "tooling/task/src/index.ts";
    boundary.allow.packages = ["@fixture/domain"];
    await saveV3Policy(root, policy);
    await writeV3File(root, path, 'import "@fixture/domain";\n');
    checkV3(root);
    boundary.allow.packages = [];
    await saveV3Policy(root, policy);
    assertV3Rule(root, "forbidden-package-dependency", path);
    boundary.allow.packages = ["@fixture/domain"];
    await saveV3Policy(root, policy);
    await writeV3File(root, "package.json", { name: "@fixture/root", private: true, type: "module" });
    assertV3Rule(root, "undeclared-workspace-dependency", path);
  });
});

test("v3 child cannot borrow root dependency declarations", async () => {
  await withV3Fixture(async (root, policy) => {
    checkV3(root);
    policy.boundaries[1].allow.packages = ["@fixture/domain"];
    await saveV3Policy(root, policy);
    await writeV3File(root, "packages/contexts/supply/src/index.ts", 'import "@fixture/domain";\n');
    assertV3Rule(root, "undeclared-workspace-dependency", "packages/contexts/supply/src/index.ts");
  });
});

for (const [path, source] of [
  ["tooling/task/src/index.ts", 'import "../../../packages/domain/src/index.js";\n'],
  ["packages/domain/src/index.ts", 'import "../../../tooling/task/src/index.js";\n'],
]) {
  test(`v3 rejects cross-package relative import from ${path}`, async () => {
    await withV3Fixture(async (root) => {
      checkV3(root);
      await writeV3File(root, path, source);
      assertV3Rule(root, "cross-package-relative-import", path);
    });
  });
}

test("v3 root source outside the declared scopes is unobserved and cannot be imported", async () => {
  await withV3Fixture(async (root) => {
    await writeV3File(root, "tooling/outside.ts", 'import "node:fs";\n');
    checkV3(root);
    await writeV3File(root, "tooling/task/src/index.ts", 'import "../../outside.js";\n');
    assertV3Rule(root, "unresolved-local-import", "tooling/task/src/index.ts");
  });
});

for (const [owner, importer, specifier] of [
  [".", "tooling/task/src/index.ts", "../../../dist/scoped/index.js"],
  ["packages/domain", "packages/domain/src/index.ts", "../dist/scoped/index.js"],
]) {
  for (const type of ["module", "commonjs"]) {
    test(`v3 ${owner} development output keeps stable ${type} marker and refuses package authority`, async () => {
      await withV3Fixture(async (root, policy) => {
        const boundary = policy.boundaries.find(({ entrypoints }) => entrypoints.includes(importer));
        boundary.dependencyMode = "development";
        await saveV3Policy(root, policy);
        const outputRoot = owner === "." ? "dist/scoped" : `${owner}/dist/scoped`;
        await writeV3File(root, `${outputRoot}/package.json`, { type });
        await writeV3File(root, importer, `import "${specifier}";\n`);
        // A missing leaf is a lexical output candidate, never claimed as an artifact.
        checkV3(root);
        await writeV3File(root, `${outputRoot}/index.js`, "export {};\n");
        checkV3(root);
        boundary.dependencyMode = "runtime";
        await saveV3Policy(root, policy);
        assertV3Rule(root, "unresolved-local-import", importer);
        boundary.dependencyMode = "development";
        await saveV3Policy(root, policy);
        await writeV3File(root, `${outputRoot}/package.json`, { type, dependencies: {} });
        assertV3Rule(root, "unresolved-local-import", importer);
      });
    });
  }
}

test("v3 root boundaries preserve entrypoints, runtime separation and type cycles beneath markers", async () => {
  await withV3Fixture(async (root, policy) => {
    const first = policy.boundaries.at(-1);
    const second = v3Boundary("root.other", "tooling/other/src");
    second.allow.boundaries = [first.id];
    first.allow.boundaries = [second.id];
    policy.governedRoots.push("tooling/other/src");
    policy.boundaries.push(second);
    await writeV3File(root, "tooling/task/package.json", { type: "module" });
    await writeV3File(root, "tooling/other/package.json", { type: "module" });
    await writeV3File(root, "tooling/other/src/index.ts", "export type Value = string;\n");
    await writeV3File(root, "tooling/other/src/private.ts", "export type Value = string;\n");
    await writeV3File(root, "tooling/task/src/index.ts", 'import type { Value } from "../../other/src/index.js";\n');
    await saveV3Policy(root, policy);
    checkV3(root);
    first.allow.boundaries = [];
    await saveV3Policy(root, policy);
    assertV3Rule(root, "forbidden-boundary-dependency", "tooling/task/src/index.ts");
    first.allow.boundaries = [second.id];
    await saveV3Policy(root, policy);
    await writeV3File(root, "tooling/task/src/index.ts", 'import type { Value } from "../../other/src/private.js";\n');
    assertV3Rule(root, "cross-boundary-local-import-not-entrypoint", "tooling/task/src/index.ts");
    await writeV3File(root, "tooling/task/src/index.ts", 'export type { Value } from "../../other/src/index.js";\n');
    await writeV3File(root, "tooling/other/src/index.ts", 'export type { Value } from "../../task/src/index.js";\n');
    assertV3Rule(root, "boundary-type-only-cycle", "tooling/other/src/index.ts");
    await writeV3File(root, "tooling/other/src/index.ts", "export type Value = string;\n");
    second.dependencyMode = "development";
    await saveV3Policy(root, policy);
    assertV3Rule(root, "runtime-boundary-imports-development-boundary", "tooling/task/src/index.ts");
  });
});

for (const owner of ["tooling/task", "packages/domain"]) {
  test(`v3 ${owner} marker retains dependency kind and npm alias slot authority`, async () => {
    await withV3Fixture(async (root, policy) => {
      const path = `${owner}/src/scoped/index.ts`;
      const boundary = policy.boundaries.find(({ roots }) => roots.includes(`${owner}/src`));
      const manifestPath = owner === "tooling/task" ? "package.json" : `${owner}/package.json`;
      const name = owner === "tooling/task" ? "@fixture/root" : "@fixture/domain";
      await writeV3File(root, `${owner}/src/scoped/package.json`, { type: "module" });
      await writeV3File(root, manifestPath, {
        name, type: "module", devDependencies: { "fixture-slot": "npm:fixture-target@1.0.0" },
      });
      boundary.allow.packages = ["fixture-slot", "fixture-target"];
      boundary.dependencyMode = "development";
      await saveV3Policy(root, policy);
      await writeV3File(root, path, 'import "fixture-slot";\n');
      checkV3(root);
      boundary.dependencyMode = "runtime";
      await saveV3Policy(root, policy);
      assertV3Rule(root, "runtime-import-from-development-dependency", path);
      boundary.dependencyMode = "development";
      await saveV3Policy(root, policy);
      await writeV3File(root, path, 'import "fixture-target";\n');
      assertV3Rule(root, "undeclared-external-dependency", path);
    });
  });
}

test("v3 root mixed-mode exports require exact runtime boundary ownership", async () => {
  await withV3Fixture(async (root, policy) => {
    const runtime = policy.boundaries.at(-1);
    const development = v3Boundary("root.tests", "tooling/tests");
    development.dependencyMode = "development";
    runtime.packageExports = ["./task"];
    policy.governedRoots.push("tooling/tests");
    policy.boundaries.push(development);
    policy.boundaries[0].allow.packages = ["@fixture/root"];
    await writeV3File(root, "tooling/tests/index.ts", "export {};\n");
    await writeV3File(root, "package.json", {
      name: "@fixture/root", type: "module", exports: { "./task": "./dist/task.js" },
    });
    await writeV3File(root, "packages/domain/package.json", {
      name: "@fixture/domain", type: "module", dependencies: { "@fixture/root": "workspace:*" },
    });
    const importer = "packages/domain/src/index.ts";
    await writeV3File(root, importer, 'import "@fixture/root/task";\n');
    await saveV3Policy(root, policy);
    checkV3(root);
    delete runtime.packageExports;
    await saveV3Policy(root, policy);
    assertV3Rule(root, "runtime-boundary-imports-development-workspace-package", importer);
    runtime.packageExports = ["./stale"];
    await saveV3Policy(root, policy);
    assertV3Problem(root, "SOURCE_EXPORT_BOUNDARY_INVALID");
    runtime.packageExports = ["./task"];
    development.packageExports = ["./task"];
    await saveV3Policy(root, policy);
    assertV3Problem(root, "SOURCE_EXPORT_BOUNDARY_INVALID");
    delete development.packageExports;
    runtime.packageExports = ["./*"];
    await saveV3Policy(root, policy);
    assertV3Problem(root, "SCHEMA_INVALID");
  });
});

test("v3 nearest pure marker controls static TypeScript export conditions", async () => {
  await withV3Fixture(async (root, policy) => {
    const importer = "tooling/task/src/scoped/index.ts";
    policy.boundaries.at(-1).allow.packages = ["@fixture/domain"];
    await saveV3Policy(root, policy);
    await writeV3File(root, "packages/domain/package.json", {
      name: "@fixture/domain", type: "module",
      exports: { ".": { import: null, require: "./dist/index.cjs" } },
    });
    await writeV3File(root, importer, 'import value from "@fixture/domain";\nexport { value };\n');
    await writeV3File(root, "tooling/task/src/scoped/package.json", { type: "commonjs" });
    checkV3(root);
    await writeV3File(root, "tooling/task/src/scoped/package.json", { type: "module" });
    assertV3Rule(root, "package-subpath-not-exported", importer);
  });
});

for (const [name, mutate] of [
  ["case-equivalent selectors", (policy) => { policy.packageRoots.push("Packages"); }],
  ["overlapping governed roots", (policy) => { policy.governedRoots.push("tooling/task"); }],
  ["overlapping boundary roots", (policy) => { policy.boundaries.at(-1).roots.push("tooling/task/src/nested"); }],
]) {
  test(`v3 selection overlap does not authorize ${name}`, async () => {
    await withV3Fixture(async (root, policy) => {
      checkV3(root);
      mutate(policy);
      await saveV3Policy(root, policy);
      assertV3Problem(root, name === "overlapping boundary roots"
        ? "SOURCE_BOUNDARY_AMBIGUOUS" : "SOURCE_ARCHITECTURE_CONFIG_INVALID");
    });
  });
}

for (const specifier of [
  "../../../dist/con.js", "../../../dist/index.js:payload", "../../../dist/../secret.js",
  "../../../dist/%69ndex.js", "../../../dist/cafe\u0301.js", "../../../dist//index.js",
]) {
  test(`v3 root development output refuses noncanonical ${specifier}`, async () => {
    await withV3Fixture(async (root, policy) => {
      const importer = "tooling/task/src/index.ts";
      policy.boundaries.at(-1).dependencyMode = "development";
      await saveV3Policy(root, policy);
      await writeV3File(root, importer, 'import "../../../dist/index.js";\n');
      checkV3(root);
      await writeV3File(root, importer, `import ${JSON.stringify(specifier)};\n`);
      assertV3Rule(root, "unresolved-local-import", importer);
    });
  });
}

test("v3 one boundary cannot span the selected root and child package", async () => {
  await withV3Fixture(async (root, policy) => {
    checkV3(root);
    const child = policy.boundaries.shift();
    const rootBoundary = policy.boundaries.at(-1);
    rootBoundary.roots.push(...child.roots);
    rootBoundary.entrypoints.push(...child.entrypoints);
    await saveV3Policy(root, policy);
    assertV3Problem(root, "SOURCE_BOUNDARY_SPANS_PACKAGES");
  });
});

test("v3 root scope still rejects a source outside all boundaries", async () => {
  await withV3Fixture(async (root, policy) => {
    checkV3(root);
    policy.boundaries.at(-1).roots = ["tooling/task/src/index.ts"];
    await saveV3Policy(root, policy);
    checkV3(root);
    await writeV3File(root, "tooling/task/src/unclassified.ts", "export {};\n");
    assertV3Rule(root, "unclassified-source-file", "tooling/task/src/unclassified.ts");
  });
});

for (const [name, files, code] of [
  ["case source collision", ["Index.ts"], "SOURCE_PATH_CASE_COLLISION"],
  ["NFC-equivalent sources", ["café.ts", "cafe\u0301.ts"], "SOURCE_PATH_CASE_COLLISION"],
  ["device source", ["con.ts"], "SOURCE_DISCOVERY_PATH_INVALID"],
  ["alternate stream source", ["index.ts:payload"], "SOURCE_DISCOVERY_PATH_INVALID"],
]) {
  test(`v3 root scan rejects ${name}`, async (t) => {
    await withV3Fixture(async (root) => {
      checkV3(root);
      const directory = join(await realpath(root), "tooling/task/src");
      let observed = false;
      // The scanner contract covers enumerated names. NTFS streams and names
      // folded by the host filesystem cannot supply these directory entries.
      await assert.rejects(() => inspectV3Topology(root, {
        fileSystem: { async opendir(path) {
          const entries = [];
          for await (const entry of await opendir(path)) { entries.push(entry); }
          if (normalize(path) === normalize(directory)) {
            observed = true;
            const source = entries.find((entry) => entry.name === "index.ts");
            assert.ok(source);
            entries.push(...files.map((file) => Object.assign(Object.create(source), { name: file })));
          }
          return { async *[Symbol.asyncIterator]() { yield* entries; } };
        } },
      }), (error) => error?.problem?.code === code);
      assert.equal(observed, true, "the intended root source directory must be observed");

      // Retain the public CLI / real-filesystem assertion whenever the exact
      // fixture names coexist. Exclusive creation prevents case-fold overwrites.
      for (const file of files) {
        try {
          await writeFile(join(directory, file), "export {};\n", {
            flag: code === "SOURCE_PATH_CASE_COLLISION" ? "wx" : "w",
          });
        } catch (error) {
          if (error.code !== "EEXIST" || code !== "SOURCE_PATH_CASE_COLLISION") { throw error; }
        }
      }
      const names = await readdir(directory);
      if (["index.ts", ...files].every((file) => names.includes(file))) {
        assertV3Problem(root, code);
      } else {
        t.diagnostic("Host cannot enumerate the exact fixture names; scanner-port rejection asserted above.");
      }
    });
  });
}

for (const path of ["tooling/package.json", "tooling/task/package.json"]) {
  test(`v3 refuses malformed ancestor manifest ${path}`, async () => {
    await withV3Fixture(async (root) => {
      checkV3(root);
      await writeV3File(root, path, "{");
      assertV3Problem(root, "PACKAGE_MANIFEST_INVALID", path);
    });
  });
}

for (const [path, target, kind, code] of [
  ["tooling/package.json", "package.json", "file", "SOURCE_SYMLINK_PROHIBITED"],
  ["tooling/task/src/alias.ts", "tooling/task/src/index.ts", "file", "SOURCE_SYMLINK_PROHIBITED"],
  ["tooling/task/src/alias", "tooling/task/src", "dir", "SOURCE_SYMLINK_PROHIBITED"],
]) {
  test(`v3 refuses physical alias ${path}`, async () => {
    await withV3Fixture(async (root) => {
      checkV3(root);
      await symlink(join(root, target), join(root, path), kind);
      assertV3Problem(root, code);
    });
  });
}

test("v3 refuses a missing root source directory", async () => {
  await withV3Fixture(async (root) => {
    checkV3(root);
    await rm(join(root, "tooling/task/src"), { recursive: true });
    assertV3Problem(root, "SOURCE_DIRECTORY_UNAVAILABLE");
  });
});

for (const typeOnly of [false, true]) {
  test(`v3 marker-owned root and child retain ${typeOnly ? "type-only" : "runtime"} package cycles`, async () => {
    await withV3Fixture(async (root, policy) => {
      await writeV3File(root, "package.json", {
        name: "@fixture/root", type: "module", exports: { ".": "./tooling/task/src/index.ts" },
        dependencies: { "@fixture/domain": "workspace:*" },
      });
      await writeV3File(root, "packages/domain/package.json", {
        name: "@fixture/domain", type: "module", exports: { ".": "./src/index.ts" },
        dependencies: { "@fixture/root": "workspace:*" },
      });
      policy.boundaries[0].allow.packages = ["@fixture/root"];
      policy.boundaries.at(-1).allow.packages = ["@fixture/domain"];
      await writeV3File(root, "tooling/task/package.json", { type: "module" });
      await writeV3File(root, "packages/domain/src/package.json", { type: "module" });
      await saveV3Policy(root, policy);
      checkV3(root);
      const statement = (name) => typeOnly ? `export type { Value } from "${name}";\n`
        : `import "${name}";\n`;
      await writeV3File(root, "tooling/task/src/index.ts", statement("@fixture/domain"));
      checkV3(root);
      await writeV3File(root, "packages/domain/src/index.ts", statement("@fixture/root"));
      const report = checkV3(root, "violations");
      assert.ok(report.diagnostics.some(({ ruleId }) => ruleId ===
        `architecture.source-dependencies.package-${typeOnly ? "type-only" : "runtime"}-cycle`),
      JSON.stringify(report));
    });
  });
}

test("v3 root cannot borrow a child's external declarations", async () => {
  await withV3Fixture(async (root, policy) => {
    await writeV3File(root, "packages/domain/package.json", {
      name: "@fixture/domain", type: "module", dependencies: { "fixture-external": "1.0.0" },
    });
    policy.boundaries.at(-1).allow.packages = ["fixture-external"];
    await saveV3Policy(root, policy);
    checkV3(root);
    await writeV3File(root, "tooling/task/src/index.ts", 'import "fixture-external";\n');
    assertV3Rule(root, "undeclared-external-dependency", "tooling/task/src/index.ts");
  });
});

test("v3 root export claims cannot contradict observed source or authorize self imports", async () => {
  await withV3Fixture(async (root, policy) => {
    const other = v3Boundary("root.other", "tooling/other/src");
    policy.governedRoots.push("tooling/other/src");
    policy.boundaries.push(other);
    await writeV3File(root, "tooling/other/src/index.ts", "export {};\n");
    await writeV3File(root, "package.json", {
      name: "@fixture/root", type: "module", exports: { "./task": "./tooling/task/src/index.ts" },
    });
    policy.boundaries[2].packageExports = ["./task"];
    await saveV3Policy(root, policy);
    checkV3(root);
    delete policy.boundaries[2].packageExports;
    other.packageExports = ["./task"];
    await saveV3Policy(root, policy);
    assertV3Problem(root, "SOURCE_EXPORT_BOUNDARY_INVALID");
    delete other.packageExports;
    policy.boundaries[2].packageExports = ["./task"];
    other.allow.packages = ["@fixture/root"];
    await saveV3Policy(root, policy);
    await writeV3File(root, "tooling/other/src/index.ts", 'import "@fixture/root/task";\n');
    assertV3Rule(root, "self-package-import-boundary-unresolved", "tooling/other/src/index.ts");
  });
});

test("v3 root participation requires a real named package", async () => {
  await withV3Fixture(async (root) => {
    checkV3(root);
    await writeV3File(root, "package.json", { private: true, type: "module" });
    assertV3Problem(root, "WORKSPACE_IDENTITY_INVALID");
  });
});

test("v3 a pure marker cannot satisfy a package selector", async () => {
  await withV3Fixture(async (root, policy) => {
    await writeV3File(root, "tooling/task/package.json", { type: "module" });
    checkV3(root);
    policy.packageRoots.push("tooling/task");
    await saveV3Policy(root, policy);
    assertV3Problem(root, "PACKAGE_ROOT_EMPTY", "tooling/task");
  });
});
