import { registerArchiveSafetyTests } from "./pack-archive-safety-cases.ts";
import { registerArchiveCustodyTests } from "./pack-archive-custody-cases.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCleanBuildStage } from "../scripts/pack-artifact-e2e.mjs";
import {
  assertPhysicalPublishablePackageRoots,
  derivePublishableArtifactPlan,
  packPublishableArtifacts,
} from "../scripts/pack-publishable-artifacts.mjs";
import { boundedDirectoryEntries } from "../scripts/pack-artifact-stage-support.mjs";
import { catalogEntry } from "./pack-publishable-artifacts-support.mjs";

import { derivePublishablePackageProjection } from "../scripts/publishable-packages.mjs";

function syntheticProjection(catalogOrder) {
  const names = {
    a: "@fixture/a",
    b: "@fixture/b",
    c: "@fixture/c",
    d: "@fixture/d",
    unrelated: "@fixture/unrelated",
  };
  const catalog = catalogOrder.map((key) => catalogEntry(names[key]));
  const manifestsByName = new Map([
    [names.a, { name: names.a }],
    [names.b, { devDependencies: { [names.a]: "workspace:*" }, name: names.b }],
    [names.c, { peerDependencies: { [names.a]: "workspace:*" }, name: names.c }],
    [
      names.d,
      {
        dependencies: { [names.b]: "workspace:*" },
        name: names.d,
        optionalDependencies: { [names.c]: "workspace:*" },
      },
    ],
    [names.unrelated, { name: names.unrelated }],
  ]);
  return {
    names,
    projection: derivePublishablePackageProjection({ catalog, manifestsByName }),
  };
}

const requiredPolicy = (packages) =>
  Object.fromEntries(packages.map(({ name }) => [name, ["dist/index.js"]]));

test("manifest projection drives deterministic transitive build support closure", () => {
  const first = syntheticProjection(["d", "unrelated", "c", "a", "b"]);
  const second = syntheticProjection(["b", "a", "d", "c", "unrelated"]);
  assert.deepEqual(
    first.projection.packages.map(({ name }) => name),
    second.projection.packages.map(({ name }) => name),
  );

  const plan = derivePublishableArtifactPlan({
    dependencyDeclarations: first.projection.declarations,
    packages: first.projection.packages,
    repositoryRoot: "/fixture/repository",
    requiredArtifactPaths: requiredPolicy(first.projection.packages),
  });
  const byName = new Map(plan.map((item) => [item.package.name, item]));
  assert.deepEqual(
    byName.get(first.names.d).stagePackages.map(({ name }) => name),
    [first.names.a, first.names.b, first.names.c, first.names.d],
  );
  assert(
    !byName.get(first.names.d).stagePackages.some(({ name }) => name === first.names.unrelated),
  );
  assert.deepEqual(byName.get(first.names.unrelated).buildPackageNames, [first.names.unrelated]);
  assert.deepEqual(
    plan.map(({ package: entry }) => entry.name),
    first.projection.packages.map(({ name }) => name),
  );
  assert(Object.isFrozen(plan));
  assert(plan.every(Object.isFrozen));
  assert(
    plan.every(
      ({ buildPackageNames, stagePackages }) =>
        Object.isFrozen(buildPackageNames) && Object.isFrozen(stagePackages),
    ),
  );
});

test("logical package portability does not reject the host volume path", () => {
  const { projection } = syntheticProjection(["a", "b", "c", "d", "unrelated"]);
  const repositoryRoot =
    process.platform === "win32" ? "D:\\fixture\\repository" : "/fixture/host:volume/repository";
  assert.doesNotThrow(() =>
    derivePublishableArtifactPlan({
      dependencyDeclarations: projection.declarations,
      packages: projection.packages,
      repositoryRoot,
      requiredArtifactPaths: requiredPolicy(projection.packages),
    }),
  );
});

test("production orchestration rejects catalog, graph, and packer injection", async () => {
  for (const override of [
    "packages",
    "dependencyDeclarations",
    "packArtifact",
    "runBuild",
    "runPnpm",
    "expectedManifest",
    "packageName",
    "requiredArtifactPaths",
  ]) {
    await assert.rejects(
      packPublishableArtifacts({ [override]: [] }),
      new RegExp(`does not accept ${override} overrides`, "u"),
    );
  }
});

test("qualification policy is closed over every projected package", () => {
  const { projection, names } = syntheticProjection(["a", "b", "c", "d", "unrelated"]);
  const policy = requiredPolicy(projection.packages);
  delete policy[names.unrelated];
  assert.throws(
    () =>
      derivePublishableArtifactPlan({
        dependencyDeclarations: projection.declarations,
        packages: projection.packages,
        repositoryRoot: "/fixture/repository",
        requiredArtifactPaths: policy,
      }),
    /required artifact policy is missing package @fixture\/unrelated/u,
  );

  policy[names.unrelated] = ["dist/index.js"];
  policy["@fixture/not-catalogued"] = ["dist/index.js"];
  assert.throws(
    () =>
      derivePublishableArtifactPlan({
        dependencyDeclarations: projection.declarations,
        packages: projection.packages,
        repositoryRoot: "/fixture/repository",
        requiredArtifactPaths: policy,
      }),
    /required artifact policy names unknown package/u,
  );
});

test("projection and staging validation fail closed", async (t) => {
  const { projection } = syntheticProjection(["a", "b", "c", "d", "unrelated"]);
  const base = {
    dependencyDeclarations: projection.declarations,
    packages: projection.packages,
    repositoryRoot: "/fixture/repository",
    requiredArtifactPaths: requiredPolicy(projection.packages),
  };
  await t.test("duplicate identity", async () => {
    assert.throws(
      () =>
        derivePublishableArtifactPlan({
          ...base,
          packages: [...projection.packages, projection.packages[0]],
        }),
      /duplicate package identity/u,
    );
  });
  await t.test("unsafe identity", async () => {
    assert.throws(
      () =>
        derivePublishableArtifactPlan({
          ...base,
          packages: [{ ...projection.packages[0], name: "../../escape" }],
          dependencyDeclarations: { "../../escape": [] },
          requiredArtifactPaths: { "../../escape": ["dist/index.js"] },
        }),
      /must have an identity/u,
    );
  });
  await t.test("missing artifact", async () => {
    assert.throws(
      () =>
        derivePublishableArtifactPlan({
          ...base,
          requiredArtifactPaths: {
            ...base.requiredArtifactPaths,
            [projection.packages[0].name]: [],
          },
        }),
      /must be a non-empty array/u,
    );
  });
  await t.test("duplicate artifact", async () => {
    assert.throws(
      () =>
        derivePublishableArtifactPlan({
          ...base,
          requiredArtifactPaths: {
            ...base.requiredArtifactPaths,
            [projection.packages[0].name]: ["dist/index.js", "dist/index.js"],
          },
        }),
      /duplicate or colliding paths/u,
    );
  });
  await t.test("path escape", async () => {
    assert.throws(
      () =>
        derivePublishableArtifactPlan({
          ...base,
          packages: [{ ...projection.packages[0], root: "../outside" }],
          dependencyDeclarations: { [projection.packages[0].name]: [] },
          requiredArtifactPaths: { [projection.packages[0].name]: ["dist/index.js"] },
        }),
      /unsafe package root|package root escapes/u,
    );
  });
  await t.test("colliding roots", async () => {
    const packages = projection.packages.slice(0, 2).map((entry, index) => ({
      ...entry,
      root: index === 0 ? "packages/shared" : "packages/shared/nested",
    }));
    assert.throws(
      () =>
        derivePublishableArtifactPlan({
          ...base,
          packages,
          requiredArtifactPaths: requiredPolicy(packages),
        }),
      /colliding stage paths/u,
    );
  });
  await t.test("unresolved support", async () => {
    const target = projection.packages[0];
    assert.throws(
      () =>
        derivePublishableArtifactPlan({
          ...base,
          dependencyDeclarations: {
            [target.name]: [{ name: "@fixture/missing", section: "devDependencies" }],
          },
          packages: [target],
          requiredArtifactPaths: { [target.name]: ["dist/index.js"] },
        }),
      /unresolved internal support package/u,
    );
  });
  await t.test(
    "an optional peer range with its workspace link is one ordering edge; other ranges and pairs are rejected",
    () => {
      const a = catalogEntry("@fixture/a");
      const b = catalogEntry("@fixture/b");
      const derive = (manifest, version = "1.9.0") =>
        derivePublishablePackageProjection({
          catalog: [a, b],
          manifestsByName: new Map([
            [a.name, { name: a.name, version }],
            [b.name, { name: b.name, ...manifest }],
          ]),
        });
      const peer = derive({
        devDependencies: { [a.name]: "workspace:*" },
        peerDependencies: { [a.name]: "workspace:^" },
        peerDependenciesMeta: { [a.name]: { optional: true } },
      });
      assert.deepEqual(peer.declarations[b.name], [{ name: a.name, section: "peerDependencies" }]);
      assert.deepEqual(peer.dependencies[b.name], []);
      assert.deepEqual(
        peer.packages.map(({ name }) => name),
        [a.name, b.name],
      );
      const minimum = {
        devDependencies: { [a.name]: "workspace:*" },
        peerDependencies: { [a.name]: "workspace:^1.8.0" },
        peerDependenciesMeta: { [a.name]: { optional: true } },
      };
      assert.deepEqual(derive(minimum).declarations[b.name], peer.declarations[b.name]);
      for (const version of ["1.7.4", "2.0.0", "1.10.0-rc.0"]) {
        assert.throws(() => derive(minimum, version), /does not admit workspace version/u);
      }
      const union = { ...minimum, peerDependencies: { [a.name]: "workspace:^1.8.0 || ^2.0.0" } };
      for (const version of ["1.8.0", "1.10.1", "2.0.0", "2.9.9"]) {
        assert.deepEqual(derive(union, version).declarations[b.name], peer.declarations[b.name]);
      }
      for (const version of ["1.7.9", "3.0.0", "2.0.0-rc.0"]) {
        assert.throws(() => derive(union, version), /does not admit workspace version/u);
      }
      assert.throws(() => derive(minimum, ""), /requires an actual workspace version/u);
      assert.throws(
        () => derive({ ...minimum, peerDependencies: { [a.name]: "workspace:^1.8" } }),
        /does not admit workspace version/u,
      );
      assert.throws(
        () => derive({ ...minimum, peerDependenciesMeta: undefined }),
        /multiple dependency sections/u,
      );
      assert.throws(
        () => derive({ peerDependencies: minimum.peerDependencies }),
        /as workspace:\*/u,
      );
      assert.throws(() => derive({ dependencies: minimum.peerDependencies }), /as workspace:\*/u);
      assert.throws(
        () => derive({ ...minimum, peerDependencies: { "@fixture/unknown": "workspace:^1.8.0" } }),
        /unknown internal workspace package/u,
      );
      assert.throws(
        () => derive({ peerDependencies: { [a.name]: "workspace:^" } }),
        /as workspace:\*/u,
      );
      assert.throws(
        () =>
          derive({
            devDependencies: { [a.name]: "workspace:*" },
            peerDependencies: { [a.name]: "workspace:^" },
          }),
        /multiple dependency sections/u,
      );
      assert.throws(
        () => derive({ dependencies: { [a.name]: "workspace:^" } }),
        /as workspace:\*/u,
      );
      assert.throws(
        () => derive({ devDependencies: { [a.name]: "workspace:^" } }),
        /as workspace:\*/u,
      );
      assert.throws(
        () =>
          derive({
            devDependencies: { [a.name]: "workspace:*" },
            peerDependencies: { [a.name]: "workspace:*" },
          }),
        /multiple dependency sections/u,
      );
      assert.throws(
        () =>
          derive({
            dependencies: { [a.name]: "workspace:*" },
            devDependencies: { [a.name]: "workspace:*" },
          }),
        /multiple dependency sections/u,
      );
    },
  );
  await t.test("cycle from manifest authority", () => {
    const a = catalogEntry("@fixture/a");
    const b = catalogEntry("@fixture/b");
    assert.throws(
      () =>
        derivePublishablePackageProjection({
          catalog: [a, b],
          manifestsByName: new Map([
            [a.name, { dependencies: { [b.name]: "workspace:*" }, name: a.name }],
            [b.name, { devDependencies: { [a.name]: "workspace:*" }, name: b.name }],
          ]),
        }),
      /internal dependency cycle/u,
    );
  });
});

test("clean stage exposes only directly declared internal packages", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pack-direct-resolution-"));
  t.after(() => rm(repositoryRoot, { force: true, recursive: true }));
  const temporaryRoot = join(repositoryRoot, "temporary");
  const roots = Object.fromEntries(
    ["a", "b", "c"].map((name) => [name, join(repositoryRoot, "packages", name)]),
  );
  await mkdir(temporaryRoot, { recursive: true });
  await writeFile(join(repositoryRoot, "LICENSE"), "fixture license\n");
  await writeFile(join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  for (const name of ["a", "b", "c"]) {
    await mkdir(roots[name], { recursive: true });
    await writeFile(
      join(roots[name], "package.json"),
      JSON.stringify({
        exports: "./index.js",
        name: `@fixture/${name}`,
        type: "commonjs",
      }),
    );
    await writeFile(join(roots[name], "index.js"), `module.exports = '${name}';\n`);
  }
  await createCleanBuildStage(
    {
      artifactLabel: "fixture-a",
      buildPackageNames: ["@fixture/c", "@fixture/b", "@fixture/a"],
      dependencyDeclarations: {
        "@fixture/a": [{ name: "@fixture/b", section: "dependencies" }],
        "@fixture/b": [{ name: "@fixture/c", section: "dependencies" }],
        "@fixture/c": [],
      },
      packageName: "@fixture/a",
      repositoryRoot,
      runBuild: async (packageRoot, { packageName }) => {
        const requireFromPackage = createRequire(join(packageRoot, "probe.cjs"));
        if (packageName === "@fixture/b") {
          assert.equal(requireFromPackage("@fixture/c"), "c");
        }
        if (packageName === "@fixture/a") {
          assert.equal(requireFromPackage("@fixture/b"), "b");
          assert.throws(() => requireFromPackage.resolve("@fixture/c"), /Cannot find module/u);
        }
      },
      stagePackages: ["c", "b", "a"].map((name) => ({
        name: `@fixture/${name}`,
        root: `packages/${name}`,
        sourceRoot: roots[name],
      })),
      temporaryRoot,
    },
    "a",
  );
});

test("clean stage materializes only declared external dependencies", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pack-declared-external-"));
  t.after(() => rm(repositoryRoot, { force: true, recursive: true }));
  const rootA = join(repositoryRoot, "packages", "a");
  const yamlRoot = join(rootA, "node_modules", "yaml");
  await mkdir(yamlRoot, { recursive: true });
  await mkdir(join(repositoryRoot, "temporary"), { recursive: true });
  await writeFile(join(repositoryRoot, "LICENSE"), "fixture license\n");
  await writeFile(join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(
    join(yamlRoot, "package.json"),
    JSON.stringify({ exports: "./index.js", name: "yaml", version: "1.0.0" }),
  );
  await writeFile(join(yamlRoot, "index.js"), "module.exports = 'CACHE SNAPSHOT';\n");
  await writeFile(join(rootA, "config.txt"), "SOURCE SNAPSHOT\n");
  await writeFile(
    join(rootA, "package.json"),
    JSON.stringify({ name: "@fixture/a", type: "commonjs" }),
  );
  await createCleanBuildStage(
    {
      dependencyDeclarations: { "@fixture/a": [] },
      packageName: "@fixture/a",
      repositoryRoot,
      runBuild: async (packageRoot) => {
        assert.throws(
          () => createRequire(join(packageRoot, "probe.cjs")).resolve("yaml"),
          /Cannot find module/u,
        );
      },
      stagePackages: [{ name: "@fixture/a", root: "packages/a", sourceRoot: rootA }],
      temporaryRoot: join(repositoryRoot, "temporary"),
    },
    "undeclared",
  );

  await writeFile(
    join(rootA, "package.json"),
    JSON.stringify({
      dependencies: { yaml: "1.0.0" },
      name: "@fixture/a",
      type: "commonjs",
    }),
  );
  let stagedYaml;
  const stage = await createCleanBuildStage(
    {
      dependencyDeclarations: { "@fixture/a": [] },
      packageName: "@fixture/a",
      repositoryRoot,
      runBuild: async (packageRoot) => {
        stagedYaml = join(packageRoot, "node_modules", "yaml");
        assert.equal(createRequire(join(packageRoot, "probe.cjs"))("yaml"), "CACHE SNAPSHOT");
      },
      stagePackages: [{ name: "@fixture/a", root: "packages/a", sourceRoot: rootA }],
      temporaryRoot: join(repositoryRoot, "temporary"),
    },
    "declared",
  );
  await writeFile(join(yamlRoot, "index.js"), "module.exports = 'MUTATED CACHE';\n");
  await writeFile(join(rootA, "config.txt"), "MUTATED SOURCE\n");
  assert((await lstat(stagedYaml)).isDirectory());
  assert(!(await lstat(stagedYaml)).isSymbolicLink());
  assert.equal(
    await readFile(join(stage.packageRoot, "node_modules", "yaml", "index.js"), "utf8"),
    "module.exports = 'CACHE SNAPSHOT';\n",
  );
  assert.equal(await readFile(join(stage.packageRoot, "config.txt"), "utf8"), "SOURCE SNAPSHOT\n");
});

test("external manifests are version-bound and only runtime closure is reconstructed", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pack-external-identity-"));
  t.after(() => rm(repositoryRoot, { force: true, recursive: true }));
  const root = join(repositoryRoot, "packages", "a");
  const external = join(root, "node_modules", "external");
  const phantom = join(external, "node_modules", "phantom-dev");
  await mkdir(phantom, { recursive: true });
  await mkdir(join(repositoryRoot, "temporary"), { recursive: true });
  await writeFile(join(repositoryRoot, "LICENSE"), "fixture license\n");
  await writeFile(join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: { external: "^1.2.0" },
      name: "@fixture/a",
    }),
  );
  await writeFile(
    join(external, "package.json"),
    JSON.stringify({
      devDependencies: { "phantom-dev": "9.0.0" },
      name: "external",
      version: "1.3.0",
    }),
  );
  await writeFile(
    join(phantom, "package.json"),
    JSON.stringify({ name: "phantom-dev", version: "9.0.0" }),
  );
  const stage = await createCleanBuildStage(
    {
      dependencyDeclarations: { "@fixture/a": [] },
      packageName: "@fixture/a",
      repositoryRoot,
      runBuild: async () => {},
      stagePackages: [{ name: "@fixture/a", root: "packages/a", sourceRoot: root }],
      temporaryRoot: join(repositoryRoot, "temporary"),
    },
    "runtime-only",
  );
  await assert.rejects(
    lstat(join(stage.packageRoot, "node_modules", "external", "node_modules", "phantom-dev")),
    /ENOENT/u,
  );

  await writeFile(
    join(external, "package.json"),
    JSON.stringify({ name: "renamed", version: "1.3.0" }),
  );
  await assert.rejects(
    createCleanBuildStage(
      {
        dependencyDeclarations: { "@fixture/a": [] },
        packageName: "@fixture/a",
        repositoryRoot,
        runBuild: async () => {},
        stagePackages: [{ name: "@fixture/a", root: "packages/a", sourceRoot: root }],
        temporaryRoot: join(repositoryRoot, "temporary"),
      },
      "wrong-name",
    ),
    /does not satisfy exact request/u,
  );
  await writeFile(
    join(external, "package.json"),
    JSON.stringify({ name: "external", version: "2.0.0" }),
  );
  await assert.rejects(
    createCleanBuildStage(
      {
        dependencyDeclarations: { "@fixture/a": [] },
        packageName: "@fixture/a",
        repositoryRoot,
        runBuild: async () => {},
        stagePackages: [{ name: "@fixture/a", root: "packages/a", sourceRoot: root }],
        temporaryRoot: join(repositoryRoot, "temporary"),
      },
      "wrong-version",
    ),
    /does not satisfy exact request/u,
  );
});

test("stage directory enumeration fails closed at its aggregate entry bound", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pack-wide-external-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await Promise.all([writeFile(join(root, "a"), ""), writeFile(join(root, "b"), "")]);
  await assert.rejects(
    boundedDirectoryEntries(root, "External dependency tree", { entries: 49_999 }),
    /bounded entry limit/u,
  );
});

test("external dependency trees carrying nested workspace links are rejected", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pack-hostile-external-"));
  t.after(() => rm(repositoryRoot, { force: true, recursive: true }));
  const rootA = join(repositoryRoot, "packages", "a");
  const rootB = join(repositoryRoot, "packages", "b");
  const external = join(rootA, "node_modules", "external");
  await mkdir(join(external, "node_modules", "@fixture"), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await mkdir(join(repositoryRoot, "temporary"), { recursive: true });
  await writeFile(join(repositoryRoot, "LICENSE"), "fixture license\n");
  await writeFile(join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(
    join(rootA, "package.json"),
    JSON.stringify({ dependencies: { external: "1.0.0" }, name: "@fixture/a" }),
  );
  await writeFile(join(rootB, "package.json"), JSON.stringify({ name: "@fixture/b" }));
  await writeFile(
    join(external, "package.json"),
    JSON.stringify({ dependencies: { "@fixture/b": "1.0.0" }, name: "external" }),
  );
  await symlink(rootB, join(external, "node_modules", "@fixture", "b"), "dir");
  await assert.rejects(
    createCleanBuildStage(
      {
        dependencyDeclarations: { "@fixture/a": [], "@fixture/b": [] },
        packageName: "@fixture/a",
        repositoryRoot,
        runBuild: async () => {},
        stagePackages: [
          { name: "@fixture/a", root: "packages/a", sourceRoot: rootA },
          { name: "@fixture/b", root: "packages/b", sourceRoot: rootB },
        ],
        temporaryRoot: join(repositoryRoot, "temporary"),
      },
      "a",
    ),
    /reaches an internal source-workspace package|carries internal package|can resolve internal source-workspace package/u,
  );
});

test("external dependency links resolving source-workspace ancestors are rejected", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pack-hostile-ancestor-"));
  t.after(() => rm(repositoryRoot, { force: true, recursive: true }));
  const rootA = join(repositoryRoot, "packages", "a");
  const rootB = join(repositoryRoot, "packages", "b");
  const external = join(rootA, "node_modules", "external");
  await mkdir(join(rootA, "node_modules", "@fixture"), { recursive: true });
  await mkdir(external, { recursive: true });
  await mkdir(rootB, { recursive: true });
  await mkdir(join(repositoryRoot, "temporary"), { recursive: true });
  await writeFile(join(repositoryRoot, "LICENSE"), "fixture license\n");
  await writeFile(join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(
    join(rootA, "package.json"),
    JSON.stringify({ dependencies: { external: "1.0.0" }, name: "@fixture/a" }),
  );
  await writeFile(join(rootB, "package.json"), JSON.stringify({ name: "@fixture/b" }));
  await writeFile(join(external, "package.json"), JSON.stringify({ name: "external" }));
  await symlink(rootB, join(rootA, "node_modules", "@fixture", "b"), "dir");
  await assert.rejects(
    createCleanBuildStage(
      {
        dependencyDeclarations: { "@fixture/a": [], "@fixture/b": [] },
        packageName: "@fixture/a",
        repositoryRoot,
        runBuild: async () => {},
        stagePackages: [
          { name: "@fixture/a", root: "packages/a", sourceRoot: rootA },
          { name: "@fixture/b", root: "packages/b", sourceRoot: rootB },
        ],
        temporaryRoot: join(repositoryRoot, "temporary"),
      },
      "a",
    ),
    /can resolve internal source-workspace package/u,
  );
});

test("external links into an authoritative package outside the staged closure are rejected", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pack-hostile-unrelated-"));
  t.after(() => rm(repositoryRoot, { force: true, recursive: true }));
  const rootA = join(repositoryRoot, "packages", "a");
  const unrelatedRoot = join(repositoryRoot, "packages", "unrelated");
  const external = join(rootA, "node_modules", "external");
  await mkdir(external, { recursive: true });
  await mkdir(unrelatedRoot, { recursive: true });
  await mkdir(join(repositoryRoot, "temporary"), { recursive: true });
  await writeFile(join(repositoryRoot, "LICENSE"), "fixture license\n");
  await writeFile(join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(
    join(rootA, "package.json"),
    JSON.stringify({ dependencies: { external: "1.0.0" }, name: "@fixture/a" }),
  );
  await writeFile(
    join(unrelatedRoot, "package.json"),
    JSON.stringify({ name: "@fixture/unrelated" }),
  );
  await writeFile(join(external, "package.json"), JSON.stringify({ name: "external" }));
  await symlink(unrelatedRoot, join(external, "payload"), "dir");
  await assert.rejects(
    createCleanBuildStage(
      {
        authoritativePackageRoots: [rootA, unrelatedRoot],
        dependencyDeclarations: { "@fixture/a": [] },
        packageName: "@fixture/a",
        repositoryRoot,
        runBuild: async () => {},
        stagePackages: [{ name: "@fixture/a", root: "packages/a", sourceRoot: rootA }],
        temporaryRoot: join(repositoryRoot, "temporary"),
      },
      "a",
    ),
    /reaches an internal source-workspace package/u,
  );
});

test("physical package roots reject symlink escapes and aliases", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pack-physical-roots-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "pack-physical-outside-"));
  t.after(() =>
    Promise.all([
      rm(repositoryRoot, { force: true, recursive: true }),
      rm(outsideRoot, { force: true, recursive: true }),
    ]),
  );
  await mkdir(join(repositoryRoot, "packages"), { recursive: true });
  await symlink(outsideRoot, join(repositoryRoot, "packages", "escape"), "dir");
  await assert.rejects(
    assertPhysicalPublishablePackageRoots(repositoryRoot, [
      { name: "@fixture/escape", root: "packages/escape" },
    ]),
    /physically escapes/u,
  );

  const actual = join(repositoryRoot, "packages", "actual");
  await mkdir(actual);
  await symlink(actual, join(repositoryRoot, "packages", "alias"), "dir");
  await assert.rejects(
    assertPhysicalPublishablePackageRoots(repositoryRoot, [
      { name: "@fixture/actual", root: "packages/actual" },
      { name: "@fixture/alias", root: "packages/alias" },
    ]),
    /physically colliding/u,
  );
});

registerArchiveSafetyTests();
registerArchiveCustodyTests();
