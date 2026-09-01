import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  assertArchiveSafety,
  assertNoSpecialTarEntries,
  createCleanBuildStage,
  inspectCompressedTarArchive,
  packAndInspectArtifact,
  readVerifiedArchive,
  snapshotVerifiedArtifact,
} from "../scripts/pack-artifact-e2e.mjs";
import {
  assertPhysicalPublishablePackageRoots,
  derivePublishableArtifactPlan,
  packPublishableArtifacts,
} from "../scripts/pack-publishable-artifacts.mjs";
import { boundedDirectoryEntries } from "../scripts/pack-artifact-stage-support.mjs";
import { assertSecretCanaryAbsent } from "../scripts/pack-test-support.mjs";
import {
  catalogEntry, compressedTar, createPackFixture, qualifiedArchive, tarArchive, tarHeader,
} from "./pack-publishable-artifacts-support.mjs";

import { derivePublishablePackageProjection } from "../scripts/publishable-packages.mjs";

async function isPhysicallyContainedPath(root, candidate) {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    realpath(root),
    realpath(candidate),
  ]);
  const relation = relative(canonicalRoot, canonicalCandidate);
  return relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

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
    [names.d, {
      dependencies: { [names.b]: "workspace:*" },
      name: names.d,
      optionalDependencies: { [names.c]: "workspace:*" },
    }],
    [names.unrelated, { name: names.unrelated }],
  ]);
  return {
    names,
    projection: derivePublishablePackageProjection({ catalog, manifestsByName }),
  };
}

function requiredPolicy(packages) {
  return Object.fromEntries(packages.map(({ name }) => [name, ["dist/index.js"]]));
}

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
  assert.deepEqual(byName.get(first.names.d).stagePackages.map(({ name }) => name), [
    first.names.a,
    first.names.b,
    first.names.c,
    first.names.d,
  ]);
  assert(!byName.get(first.names.d).stagePackages.some(({ name }) => name === first.names.unrelated));
  assert.deepEqual(byName.get(first.names.unrelated).buildPackageNames, [first.names.unrelated]);
  assert.deepEqual(plan.map(({ package: entry }) => entry.name), first.projection.packages.map(({ name }) => name));
  assert(Object.isFrozen(plan));
  assert(plan.every(Object.isFrozen));
  assert(plan.every(({ buildPackageNames, stagePackages }) =>
    Object.isFrozen(buildPackageNames) && Object.isFrozen(stagePackages)));
});

test("logical package portability does not reject the host volume path", () => {
  const { projection } = syntheticProjection(["a", "b", "c", "d", "unrelated"]);
  const repositoryRoot = process.platform === "win32"
    ? "D:\\fixture\\repository"
    : "/fixture/host:volume/repository";
  assert.doesNotThrow(() => derivePublishableArtifactPlan({
    dependencyDeclarations: projection.declarations,
    packages: projection.packages,
    repositoryRoot,
    requiredArtifactPaths: requiredPolicy(projection.packages),
  }));
});

test("production orchestration rejects catalog, graph, and packer injection", async () => {
  for (const override of [
    "packages", "dependencyDeclarations", "packArtifact", "runBuild", "runPnpm",
    "expectedManifest", "packageName", "requiredArtifactPaths",
  ]) {
    await assert.rejects(packPublishableArtifacts({ [override]: [] }),
      new RegExp(`does not accept ${override} overrides`, "u"));
  }
});

test("qualification policy is closed over every projected package", () => {
  const { projection, names } = syntheticProjection(["a", "b", "c", "d", "unrelated"]);
  const policy = requiredPolicy(projection.packages);
  delete policy[names.unrelated];
  assert.throws(
    () => derivePublishableArtifactPlan({
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
    () => derivePublishableArtifactPlan({
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
    assert.throws(() => derivePublishableArtifactPlan({
      ...base,
      packages: [...projection.packages, projection.packages[0]],
    }), /duplicate package identity/u);
  });
  await t.test("unsafe identity", async () => {
    assert.throws(() => derivePublishableArtifactPlan({
      ...base,
      packages: [{ ...projection.packages[0], name: "../../escape" }],
      dependencyDeclarations: { "../../escape": [] },
      requiredArtifactPaths: { "../../escape": ["dist/index.js"] },
    }), /must have an identity/u);
  });
  await t.test("missing artifact", async () => {
    assert.throws(() => derivePublishableArtifactPlan({
      ...base,
      requiredArtifactPaths: {
        ...base.requiredArtifactPaths,
        [projection.packages[0].name]: [],
      },
    }), /must be a non-empty array/u);
  });
  await t.test("duplicate artifact", async () => {
    assert.throws(() => derivePublishableArtifactPlan({
      ...base,
      requiredArtifactPaths: {
        ...base.requiredArtifactPaths,
        [projection.packages[0].name]: ["dist/index.js", "dist/index.js"],
      },
    }), /duplicate or colliding paths/u);
  });
  await t.test("path escape", async () => {
    assert.throws(() => derivePublishableArtifactPlan({
      ...base,
      packages: [{ ...projection.packages[0], root: "../outside" }],
      dependencyDeclarations: { [projection.packages[0].name]: [] },
      requiredArtifactPaths: { [projection.packages[0].name]: ["dist/index.js"] },
    }), /unsafe package root|package root escapes/u);
  });
  await t.test("colliding roots", async () => {
    const packages = projection.packages.slice(0, 2).map((entry, index) => ({
      ...entry,
      root: index === 0 ? "packages/shared" : "packages/shared/nested",
    }));
    assert.throws(() => derivePublishableArtifactPlan({
      ...base,
      packages,
      requiredArtifactPaths: requiredPolicy(packages),
    }), /colliding stage paths/u);
  });
  await t.test("unresolved support", async () => {
    const target = projection.packages[0];
    assert.throws(() => derivePublishableArtifactPlan({
      ...base,
      dependencyDeclarations: {
        [target.name]: [{ name: "@fixture/missing", section: "devDependencies" }],
      },
      packages: [target],
      requiredArtifactPaths: { [target.name]: ["dist/index.js"] },
    }), /unresolved internal support package/u);
  });
  await t.test("cycle from manifest authority", () => {
    const a = catalogEntry("@fixture/a");
    const b = catalogEntry("@fixture/b");
    assert.throws(() => derivePublishablePackageProjection({
      catalog: [a, b],
      manifestsByName: new Map([
        [a.name, { dependencies: { [b.name]: "workspace:*" }, name: a.name }],
        [b.name, { devDependencies: { [a.name]: "workspace:*" }, name: b.name }],
      ]),
    }), /internal dependency cycle/u);
  });
});

test("clean stage resolves internal imports to freshly built staged copies", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pack-stage-resolution-"));
  t.after(() => rm(repositoryRoot, { force: true, recursive: true }));
  const temporaryRoot = join(repositoryRoot, "temporary");
  const sourceA = join(repositoryRoot, "packages", "a");
  const sourceB = join(repositoryRoot, "packages", "b");
  await mkdir(join(sourceA, "node_modules", "@fixture"), { recursive: true });
  await mkdir(join(sourceB, "dist"), { recursive: true });
  await mkdir(temporaryRoot, { recursive: true });
  await writeFile(join(repositoryRoot, "LICENSE"), "fixture license\n");
  await writeFile(join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(join(sourceA, "package.json"), JSON.stringify({ name: "@fixture/a" }));
  await writeFile(join(sourceB, "package.json"), JSON.stringify({
    exports: "./dist/index.js",
    name: "@fixture/b",
    type: "commonjs",
  }));
  await writeFile(join(sourceB, "dist", "index.js"), "module.exports = 'POISON SOURCE DIST';\n");
  await symlink(sourceB, join(sourceA, "node_modules", "@fixture", "b"), "dir");

  let resolvedInternalPath;
  const stage = await createCleanBuildStage({
    artifactLabel: "fixture-a",
    buildPackageNames: ["@fixture/b", "@fixture/a"],
    dependencyDeclarations: {
      "@fixture/a": [{ name: "@fixture/b", section: "devDependencies" }],
      "@fixture/b": [],
    },
    packageName: "@fixture/a",
    packageRoot: sourceA,
    repositoryRoot,
    runBuild: async (packageRoot, { packageName }) => {
      if (packageName === "@fixture/b") {
        await mkdir(join(packageRoot, "dist"), { recursive: true });
        await writeFile(join(packageRoot, "dist", "index.js"), "module.exports = 'STAGED BUILD';\n");
        return;
      }
      const requireFromStage = createRequire(join(packageRoot, "build-probe.cjs"));
      resolvedInternalPath = requireFromStage.resolve("@fixture/b");
      assert.equal(requireFromStage("@fixture/b"), "STAGED BUILD");
    },
    stagePackages: [
      { name: "@fixture/b", root: "packages/b", sourceRoot: sourceB },
      { name: "@fixture/a", root: "packages/a", sourceRoot: sourceA },
    ],
    temporaryRoot,
  }, "a");

  assert(await isPhysicallyContainedPath(stage.stageRoot, resolvedInternalPath));
  assert(!(await isPhysicallyContainedPath(sourceB, resolvedInternalPath)));
  assert.equal(
    await realpath(join(stage.packageRoot, "node_modules", "@fixture", "b")),
    await realpath(join(stage.stageRoot, "packages", "b")),
  );
  await assert.rejects(realpath(join(stage.stageRoot, "node_modules", "@fixture", "b")), /ENOENT/u);
  assert.equal(await readFile(join(sourceB, "dist", "index.js"), "utf8"),
    "module.exports = 'POISON SOURCE DIST';\n");
});

test("clean stage exposes only directly declared internal packages", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pack-direct-resolution-"));
  t.after(() => rm(repositoryRoot, { force: true, recursive: true }));
  const temporaryRoot = join(repositoryRoot, "temporary");
  const roots = Object.fromEntries(["a", "b", "c"].map((name) => [name, join(repositoryRoot, "packages", name)]));
  await mkdir(temporaryRoot, { recursive: true });
  await writeFile(join(repositoryRoot, "LICENSE"), "fixture license\n");
  await writeFile(join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  for (const name of ["a", "b", "c"]) {
    await mkdir(roots[name], { recursive: true });
    await writeFile(join(roots[name], "package.json"), JSON.stringify({
      exports: "./index.js", name: `@fixture/${name}`, type: "commonjs",
    }));
    await writeFile(join(roots[name], "index.js"), `module.exports = '${name}';\n`);
  }
  await createCleanBuildStage({
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
      name: `@fixture/${name}`, root: `packages/${name}`, sourceRoot: roots[name],
    })),
    temporaryRoot,
  }, "a");
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
  await writeFile(join(yamlRoot, "package.json"), JSON.stringify({ exports: "./index.js", name: "yaml", version: "1.0.0" }));
  await writeFile(join(yamlRoot, "index.js"), "module.exports = 'CACHE SNAPSHOT';\n");
  await writeFile(join(rootA, "config.txt"), "SOURCE SNAPSHOT\n");
  await writeFile(join(rootA, "package.json"), JSON.stringify({ name: "@fixture/a", type: "commonjs" }));
  await createCleanBuildStage({
    dependencyDeclarations: { "@fixture/a": [] }, packageName: "@fixture/a", repositoryRoot,
    runBuild: async (packageRoot) => {
      assert.throws(() => createRequire(join(packageRoot, "probe.cjs")).resolve("yaml"), /Cannot find module/u);
    },
    stagePackages: [{ name: "@fixture/a", root: "packages/a", sourceRoot: rootA }],
    temporaryRoot: join(repositoryRoot, "temporary"),
  }, "undeclared");

  await writeFile(join(rootA, "package.json"), JSON.stringify({
    dependencies: { yaml: "1.0.0" }, name: "@fixture/a", type: "commonjs",
  }));
  let stagedYaml;
  const stage = await createCleanBuildStage({
    dependencyDeclarations: { "@fixture/a": [] }, packageName: "@fixture/a", repositoryRoot,
    runBuild: async (packageRoot) => {
      stagedYaml = join(packageRoot, "node_modules", "yaml");
      assert.equal(createRequire(join(packageRoot, "probe.cjs"))("yaml"), "CACHE SNAPSHOT");
    },
    stagePackages: [{ name: "@fixture/a", root: "packages/a", sourceRoot: rootA }],
    temporaryRoot: join(repositoryRoot, "temporary"),
  }, "declared");
  await writeFile(join(yamlRoot, "index.js"), "module.exports = 'MUTATED CACHE';\n");
  await writeFile(join(rootA, "config.txt"), "MUTATED SOURCE\n");
  assert((await lstat(stagedYaml)).isDirectory());
  assert(!(await lstat(stagedYaml)).isSymbolicLink());
  assert.equal(await readFile(join(stage.packageRoot, "node_modules", "yaml", "index.js"), "utf8"),
    "module.exports = 'CACHE SNAPSHOT';\n");
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
  await writeFile(join(root, "package.json"), JSON.stringify({
    dependencies: { external: "^1.2.0" }, name: "@fixture/a",
  }));
  await writeFile(join(external, "package.json"), JSON.stringify({
    devDependencies: { "phantom-dev": "9.0.0" }, name: "external", version: "1.3.0",
  }));
  await writeFile(join(phantom, "package.json"), JSON.stringify({ name: "phantom-dev", version: "9.0.0" }));
  const stage = await createCleanBuildStage({
    dependencyDeclarations: { "@fixture/a": [] }, packageName: "@fixture/a", repositoryRoot,
    runBuild: async () => {},
    stagePackages: [{ name: "@fixture/a", root: "packages/a", sourceRoot: root }],
    temporaryRoot: join(repositoryRoot, "temporary"),
  }, "runtime-only");
  await assert.rejects(lstat(join(stage.packageRoot, "node_modules", "external", "node_modules", "phantom-dev")),
    /ENOENT/u);

  await writeFile(join(external, "package.json"), JSON.stringify({ name: "renamed", version: "1.3.0" }));
  await assert.rejects(createCleanBuildStage({
    dependencyDeclarations: { "@fixture/a": [] }, packageName: "@fixture/a", repositoryRoot,
    runBuild: async () => {},
    stagePackages: [{ name: "@fixture/a", root: "packages/a", sourceRoot: root }],
    temporaryRoot: join(repositoryRoot, "temporary"),
  }, "wrong-name"), /does not satisfy exact request/u);
  await writeFile(join(external, "package.json"), JSON.stringify({ name: "external", version: "2.0.0" }));
  await assert.rejects(createCleanBuildStage({
    dependencyDeclarations: { "@fixture/a": [] }, packageName: "@fixture/a", repositoryRoot,
    runBuild: async () => {},
    stagePackages: [{ name: "@fixture/a", root: "packages/a", sourceRoot: root }],
    temporaryRoot: join(repositoryRoot, "temporary"),
  }, "wrong-version"), /does not satisfy exact request/u);
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
  await writeFile(join(rootA, "package.json"), JSON.stringify({ dependencies: { external: "1.0.0" }, name: "@fixture/a" }));
  await writeFile(join(rootB, "package.json"), JSON.stringify({ name: "@fixture/b" }));
  await writeFile(join(external, "package.json"), JSON.stringify({ dependencies: { "@fixture/b": "1.0.0" }, name: "external" }));
  await symlink(rootB, join(external, "node_modules", "@fixture", "b"), "dir");
  await assert.rejects(createCleanBuildStage({
    dependencyDeclarations: { "@fixture/a": [], "@fixture/b": [] },
    packageName: "@fixture/a",
    repositoryRoot,
    runBuild: async () => {},
    stagePackages: [
      { name: "@fixture/a", root: "packages/a", sourceRoot: rootA },
      { name: "@fixture/b", root: "packages/b", sourceRoot: rootB },
    ],
    temporaryRoot: join(repositoryRoot, "temporary"),
  }, "a"), /reaches an internal source-workspace package|carries internal package|can resolve internal source-workspace package/u);
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
  await writeFile(join(rootA, "package.json"), JSON.stringify({ dependencies: { external: "1.0.0" }, name: "@fixture/a" }));
  await writeFile(join(rootB, "package.json"), JSON.stringify({ name: "@fixture/b" }));
  await writeFile(join(external, "package.json"), JSON.stringify({ name: "external" }));
  await symlink(rootB, join(rootA, "node_modules", "@fixture", "b"), "dir");
  await assert.rejects(createCleanBuildStage({
    dependencyDeclarations: { "@fixture/a": [], "@fixture/b": [] },
    packageName: "@fixture/a",
    repositoryRoot,
    runBuild: async () => {},
    stagePackages: [
      { name: "@fixture/a", root: "packages/a", sourceRoot: rootA },
      { name: "@fixture/b", root: "packages/b", sourceRoot: rootB },
    ],
    temporaryRoot: join(repositoryRoot, "temporary"),
  }, "a"), /can resolve internal source-workspace package/u);
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
  await writeFile(join(rootA, "package.json"), JSON.stringify({ dependencies: { external: "1.0.0" }, name: "@fixture/a" }));
  await writeFile(join(unrelatedRoot, "package.json"), JSON.stringify({ name: "@fixture/unrelated" }));
  await writeFile(join(external, "package.json"), JSON.stringify({ name: "external" }));
  await symlink(unrelatedRoot, join(external, "payload"), "dir");
  await assert.rejects(createCleanBuildStage({
    authoritativePackageRoots: [rootA, unrelatedRoot],
    dependencyDeclarations: { "@fixture/a": [] },
    packageName: "@fixture/a",
    repositoryRoot,
    runBuild: async () => {},
    stagePackages: [{ name: "@fixture/a", root: "packages/a", sourceRoot: rootA }],
    temporaryRoot: join(repositoryRoot, "temporary"),
  }, "a"), /reaches an internal source-workspace package/u);
});

test("physical package roots reject symlink escapes and aliases", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pack-physical-roots-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "pack-physical-outside-"));
  t.after(() => Promise.all([
    rm(repositoryRoot, { force: true, recursive: true }),
    rm(outsideRoot, { force: true, recursive: true }),
  ]));
  await mkdir(join(repositoryRoot, "packages"), { recursive: true });
  await symlink(outsideRoot, join(repositoryRoot, "packages", "escape"), "dir");
  await assert.rejects(assertPhysicalPublishablePackageRoots(repositoryRoot, [
    { name: "@fixture/escape", root: "packages/escape" },
  ]), /physically escapes/u);

  const actual = join(repositoryRoot, "packages", "actual");
  await mkdir(actual);
  await symlink(actual, join(repositoryRoot, "packages", "alias"), "dir");
  await assert.rejects(assertPhysicalPublishablePackageRoots(repositoryRoot, [
    { name: "@fixture/actual", root: "packages/actual" },
    { name: "@fixture/alias", root: "packages/alias" },
  ]), /physically colliding/u);
});

test("archive safety retains allowlist, bounds, and special-entry rejection", () => {
  const listing = [
    "package/",
    "package/package.json",
    "package/LICENSE",
    "package/README.md",
    "package/dist/",
    "package/dist/index.js",
  ].join("\n");
  assert.doesNotThrow(() => assertArchiveSafety({
    archiveBytes: Buffer.from("fixture"),
    listing,
    requiredArtifactPaths: ["dist/index.js"],
    verboseListing: "drwxr-xr-x package/\n-rw-r--r-- package/dist/index.js\n",
  }));
  assert.throws(() => assertArchiveSafety({
    archiveBytes: Buffer.from("fixture"),
    listing: `${listing}\npackage/src/secret.js`,
    requiredArtifactPaths: ["dist/index.js"],
    verboseListing: "-rw-r--r-- package/src/secret.js\n",
  }), /Forbidden package entry|outside the release allowlist/u);
  assert.throws(() => assertArchiveSafety({
    archiveBytes: Buffer.from("fixture"),
    listing: listing.replace("package/dist/index.js", ""),
    requiredArtifactPaths: ["dist/index.js"],
    verboseListing: "drwxr-xr-x package/dist/\n",
  }), /Required package entry missing/u);
  assert.throws(() => assertArchiveSafety({
    archiveBytes: Buffer.alloc(8 * 1024 * 1024 + 1),
    listing,
    requiredArtifactPaths: ["dist/index.js"],
    verboseListing: "-rw-r--r-- package/dist/index.js\n",
  }), /archive exceeds/u);
  assert.throws(() => assertNoSpecialTarEntries("lrwxrwxrwx package/link -> target\n"),
    /prohibited special tar entry/u);
  assert.throws(() => assertArchiveSafety({
    archiveBytes: Buffer.from("fixture"),
    listing: Array.from({ length: 2_501 }, (_, index) => `package/dist/${index}.js`).join("\n"),
    requiredArtifactPaths: ["dist/index.js"],
    verboseListing: "",
  }), /too many entries/u);
  assert.throws(() => assertArchiveSafety({
    archiveBytes: Buffer.from("fixture"),
    listing: `${listing}\npackage/dist/../dist/index.js`,
    requiredArtifactPaths: ["dist/index.js"],
    verboseListing: "-rw-r--r-- package/dist/index.js\n",
  }), /unsafe archive member|duplicate or normalized-colliding/u);
  assert.throws(() => assertArchiveSafety({
    archiveBytes: Buffer.from("fixture"),
    listing: `${listing}\npackage/dist/index.js`,
    requiredArtifactPaths: ["dist/index.js"],
    verboseListing: "-rw-r--r-- package/dist/index.js\n",
  }), /duplicate or normalized-colliding/u);
  for (const hostile of [
    "package/dist/INDEX.js",
    "package/dist/index.js. ",
    "package/dist/\u0065\u0301.js",
    "package/dist/CON.txt",
    "package/dist/COM¹.txt",
    "package/dist/AUX",
    "package/dist/CON .txt",
    "package/dist/name:stream.js",
    "package/dist/bad?.js",
  ]) {
    const baseline = hostile.includes("\u0301")
      ? `${listing}\npackage/dist/\u00e9.js`
      : listing;
    assert.throws(() => assertArchiveSafety({
      archiveBytes: Buffer.from("fixture"),
      listing: `${baseline}\n${hostile}`,
      requiredArtifactPaths: ["dist/index.js"],
      verboseListing: "-rw-r--r-- package/dist/index.js\n",
    }), /colliding|non-portable|unsafe/u);
  }
  assert.throws(() => assertArchiveSafety({
    archiveBytes: Buffer.from("fixture"),
    listing: `${listing}\npackage/dist/Σ.js\npackage/dist/ς.js`,
    requiredArtifactPaths: ["dist/index.js"],
    verboseListing: "-rw-r--r-- package/dist/index.js\n",
  }), /colliding/u);
  assert.throws(() => assertArchiveSafety({
    archiveBytes: Buffer.from("fixture"),
    listing: `${listing}\npackage/dist/file.js\npackage/dist/fıle.js`,
    requiredArtifactPaths: ["dist/index.js"],
    verboseListing: "-rw-r--r-- package/dist/index.js\n",
  }), /colliding/u);
});


test("compressed tar inspection bounds members before extraction", () => {
  assert.deepEqual(inspectCompressedTarArchive(compressedTar("package/small", 5, Buffer.from("small"))), {
    aggregateBytes: 5,
    entryCount: 1,
    uncompressedBytes: 2_048,
  });
  assert.throws(
    () => inspectCompressedTarArchive(compressedTar("package/oversized", 16 * 1024 * 1024 + 1)),
    /member exceeds/u,
  );
  const compressedBomb = gzipSync(Buffer.alloc(70 * 1024 * 1024));
  assert.throws(() => inspectCompressedTarArchive(compressedBomb), /safety bound/u);
  assert.throws(
    () => inspectCompressedTarArchive(tarArchive([{ name: "package/sparse", type: "S" }])),
    /GNU sparse/u,
  );
  assert.throws(() => inspectCompressedTarArchive(tarArchive([{
    data: Buffer.from("20 GNU.sparse.size=999999999\n"),
    name: "PaxHeader/package",
    type: "x",
  }])), /PAX sparse/u);
  const oneZeroBlock = Buffer.concat([tarHeader("package/file", 0), Buffer.alloc(512)]);
  assert.throws(() => inspectCompressedTarArchive(gzipSync(oneZeroBlock)), /two-zero-block terminator/u);
  const hiddenAfterTerminator = Buffer.concat([
    tarHeader("package/file", 0), Buffer.alloc(1024), tarHeader("package/hidden", 0), Buffer.alloc(1024),
  ]);
  assert.throws(() => inspectCompressedTarArchive(gzipSync(hiddenAfterTerminator)), /hidden trailing data/u);
});

test("attacker-controlled packed manifest cannot forge qualification identity", async (t) => {
  const fixture = await createPackFixture(t, "pack-forged-manifest-");
  const bytes = qualifiedArchive({ name: "@fixture/attacker", version: "1.2.3" });
  await assert.rejects(packAndInspectArtifact({
    ...fixture,
    buildPackageNames: ["@fixture/qualified"],
    dependencyDeclarations: { "@fixture/qualified": [] },
    expectedManifest: { name: "@fixture/qualified", version: "1.2.3" },
    packageName: "@fixture/qualified",
    requiredArtifactPaths: ["dist/index.js"],
    runBuild: async () => {},
    runPnpm: async (args) => {
      const destination = args.at(args.indexOf("--pack-destination") + 1);
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "fixture-qualified-1.2.3.tgz"), bytes);
    },
    stagePackages: [{
      name: "@fixture/qualified", root: "packages/qualified", sourceRoot: fixture.packageRoot, version: "1.2.3",
    }],
  }), /manifest identity does not match/u);
});

test("same-identity manifest substitution and injected payloads fail closed", async (t) => {
  const fixture = await createPackFixture(t, "pack-substituted-manifest-");
  await writeFile(join(fixture.packageRoot, "package.json"), JSON.stringify({
    exports: { ".": "./dist/index.js" },
    files: ["dist"],
    name: "@fixture/qualified",
    scripts: { build: "fixture-build" },
    version: "1.2.3",
  }));
  const forgedManifest = {
    exports: { ".": "./dist/attacker.js" },
    files: ["dist"],
    name: "@fixture/qualified",
    scripts: { build: "fixture-build", postinstall: "node attacker.js" },
    version: "1.2.3",
  };
  const forgedBytes = qualifiedArchive(forgedManifest);
  const injectedBytes = qualifiedArchive(JSON.parse(await readFile(join(fixture.packageRoot, "package.json"), "utf8")), [
    { data: Buffer.from("attack\n"), name: "package/dist/attacker.js" },
  ]);
  const substitutedContentBytes = tarArchive([
    { data: await readFile(join(fixture.packageRoot, "package.json")), name: "package/package.json" },
    { data: Buffer.from("fixture license\n"), name: "package/LICENSE" },
    { data: Buffer.from("# Fixture\n"), name: "package/README.md" },
    { data: Buffer.from("attack();\n"), name: "package/dist/index.js" },
  ]);
  for (const [bytes, expected] of [
    [forgedBytes, /manifest identity does not match/u],
    [injectedBytes, /payload differs/u],
    [substitutedContentBytes, /content differs/u],
  ]) {
    await assert.rejects(packAndInspectArtifact({
      ...fixture,
      buildPackageNames: ["@fixture/qualified"],
      dependencyDeclarations: { "@fixture/qualified": [] },
      packageName: "@fixture/qualified",
      requiredArtifactPaths: ["dist/index.js"],
      runBuild: async (packageRoot) => {
        await mkdir(join(packageRoot, "dist"), { recursive: true });
        await writeFile(join(packageRoot, "dist", "index.js"), "export {};\n");
      },
      runPnpm: async (args) => {
        const destination = args.at(args.indexOf("--pack-destination") + 1);
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "fixture-qualified-1.2.3.tgz"), bytes);
      },
      stagePackages: [{ name: "@fixture/qualified", root: "packages/qualified", sourceRoot: fixture.packageRoot }],
    }), expected);
  }
});

test("returned artifact is a verified byte snapshot, not a mutable pack output", async (t) => {
  const fixture = await createPackFixture(t, "pack-verified-snapshot-");
  const bytes = qualifiedArchive({ name: "@fixture/qualified", version: "1.2.3" });
  const packOutputs = [];
  const artifact = await packAndInspectArtifact({
    ...fixture,
    buildPackageNames: ["@fixture/qualified"],
    dependencyDeclarations: { "@fixture/qualified": [] },
    expectedManifest: { name: "@fixture/qualified", version: "1.2.3" },
    packageName: "@fixture/qualified",
    requiredArtifactPaths: ["dist/index.js"],
    runBuild: async () => {},
    runPnpm: async (args) => {
      const destination = args.at(args.indexOf("--pack-destination") + 1);
      await mkdir(destination, { recursive: true });
      const path = join(destination, "fixture-qualified-1.2.3.tgz");
      packOutputs.push(path);
      await writeFile(path, bytes);
    },
    stagePackages: [{
      name: "@fixture/qualified", root: "packages/qualified", sourceRoot: fixture.packageRoot, version: "1.2.3",
    }],
  });
  await Promise.all(packOutputs.map((path) => writeFile(path, "mutated")));
  assert.deepEqual(await readFile(artifact.archivePath), bytes);
  assert.equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(snapshotVerifiedArtifact(artifact), bytes);
  await rm(artifact.archivePath);
  await symlink(packOutputs[0], artifact.archivePath);
  assert.deepEqual(snapshotVerifiedArtifact(artifact), bytes);
  await assert.rejects(readVerifiedArchive(artifact.archivePath, artifact.sha256), /replaced by a symlink/u);
});

test("required runtime asset deletion fails qualification after the package build contract", async (t) => {
  const fixture = await createPackFixture(t, "pack-required-assets-");
  await mkdir(join(fixture.packageRoot, "assets"));
  await writeFile(join(fixture.packageRoot, "assets", "catalog.json"), "{}\n");
  const bytesWithoutAsset = qualifiedArchive({ name: "@fixture/qualified", version: "1.2.3" });
  let builds = 0;
  await assert.rejects(packAndInspectArtifact({
    ...fixture,
    allowedArtifactPaths: ["dist", "assets"],
    buildPackageNames: ["@fixture/qualified"],
    dependencyDeclarations: { "@fixture/qualified": [] },
    expectedManifest: { name: "@fixture/qualified", version: "1.2.3" },
    packageName: "@fixture/qualified",
    requiredArtifactPaths: ["dist/index.js", "assets/catalog.json"],
    runBuild: async (packageRoot) => {
      builds += 1;
      // This seam stands in for the package-owned `pnpm run build` contract;
      // production invokes that script rather than raw tsc.
      await rm(join(packageRoot, "assets", "catalog.json"));
    },
    runPnpm: async (args) => {
      const destination = args.at(args.indexOf("--pack-destination") + 1);
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "fixture-qualified-1.2.3.tgz"), bytesWithoutAsset);
    },
    stagePackages: [{
      name: "@fixture/qualified", root: "packages/qualified", sourceRoot: fixture.packageRoot, version: "1.2.3",
    }],
  }), /Required package entry missing: package\/assets\/catalog\.json/u);
  assert.equal(builds, 2);
});

test("two clean pack outputs must be byte-identical", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pack-determinism-"));
  t.after(() => rm(repositoryRoot, { force: true, recursive: true }));
  const packageRoot = join(repositoryRoot, "packages", "qualified");
  const temporaryRoot = join(repositoryRoot, "temporary");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(temporaryRoot, { recursive: true });
  await writeFile(join(repositoryRoot, "LICENSE"), "fixture license\n");
  await writeFile(join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(join(packageRoot, "package.json"), '{"name":"@fixture/qualified","version":"1.2.3"}\n');
  await writeFile(join(packageRoot, "README.md"), "# Fixture\n");
  let invocation = 0;
  await assert.rejects(packAndInspectArtifact({
    artifactLabel: "qualified",
    buildPackageNames: ["@fixture/qualified"],
    dependencyDeclarations: { "@fixture/qualified": [] },
    expectedManifest: { name: "@fixture/qualified", version: "1.2.3" },
    packageName: "@fixture/qualified",
    packageRoot,
    repositoryRoot,
    requiredArtifactPaths: ["dist/index.js"],
    runBuild: async () => {},
    runPnpm: async (args) => {
      const destination = args.at(args.indexOf("--pack-destination") + 1);
      await mkdir(destination, { recursive: true });
      invocation += 1;
      await writeFile(join(destination, "fixture-qualified-1.2.3.tgz"), `archive-${invocation}`);
    },
    stagePackages: [{
      name: "@fixture/qualified",
      root: "packages/qualified",
      sourceRoot: packageRoot,
    }],
    temporaryRoot,
  }), /byte-identical tarballs/u);
  assert.equal(invocation, 2);
});

test("secret canary scanning remains fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pack-secret-canary-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    join(root, "artifact.js"),
    "AGENT_TEAMS_PACKAGE_SECRET_CANARY_DO_NOT_PUBLISH_7A13D6C4\n",
  );
  await assert.rejects(assertSecretCanaryAbsent(root), /Secret-like content leaked/u);
});
