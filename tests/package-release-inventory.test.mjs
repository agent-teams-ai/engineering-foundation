import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FOUNDATION_PACKAGE_FILE_ALLOWLIST,
  FOUNDATION_REQUIRED_ARTIFACT_PATHS,
  inspectFoundationPackage,
} from "../packages/engineering-foundation/dist/package-self-check.js";
import { FOUNDATION_SCHEMA_IDS } from "../packages/engineering-foundation/dist/schema-ids.js";
import {
  assertArchiveListing,
  createCleanBuildStage,
} from "../scripts/pack-artifact-e2e.mjs";
import { publishablePackageCheckPlan } from "../scripts/check-publishable-packages.mjs";
import {
  releaseGraphProjectionDiagnostics,
  validateReleaseGraphProjections,
} from "../scripts/check-release-graph-projections.mjs";
import {
  registryQualificationPackages,
  stageQualificationPackage,
} from "../scripts/registry-qualification-packages.mjs";
import {
  PACKAGE_RELEASE_GRAPH,
  PUBLISHABLE_PACKAGES,
  PUBLISHABLE_PACKAGE_DEPENDENCIES,
  parsePackageReleaseGraph,
} from "../scripts/publishable-packages.mjs";

const repositoryPackageRoot = new URL(
  "../packages/engineering-foundation/",
  import.meta.url,
);

function releaseGraphPackage(overrides = {}) {
  return {
    changelogPath: "packages/a/CHANGELOG.md",
    dependencies: [],
    manifestPath: "packages/a/package.json",
    name: "@example/a",
    required: false,
    root: "packages/a",
    ...overrides,
  };
}

function releaseGraph(packages) {
  return { packages, schemaVersion: 1 };
}

test("versioned release graph is the single topologically ordered package authority", () => {
  assert.equal(PACKAGE_RELEASE_GRAPH.schemaVersion, 1);
  assert.deepEqual(
    PACKAGE_RELEASE_GRAPH.packages.map(({ name }) => name),
    PUBLISHABLE_PACKAGES.map(({ name }) => name),
  );
  assert.deepEqual(
    Object.fromEntries(PACKAGE_RELEASE_GRAPH.packages.map(({ dependencies, name }) => [
      name,
      dependencies,
    ])),
    PUBLISHABLE_PACKAGE_DEPENDENCIES,
  );
  assert.throws(() => PACKAGE_RELEASE_GRAPH.packages.push(releaseGraphPackage()), TypeError);
});

test("package lint and type-surface checks derive from the versioned release graph", () => {
  const plan = publishablePackageCheckPlan(PUBLISHABLE_PACKAGES);
  assert.equal(plan.length, PUBLISHABLE_PACKAGES.length * 2);
  for (const [index, releasePackage] of PUBLISHABLE_PACKAGES.entries()) {
    assert.deepEqual(plan.slice(index * 2, index * 2 + 2), [
      { arguments: [releasePackage.root], tool: "publint" },
      {
        arguments: ["--pack", "--profile", "esm-only", releasePackage.root],
        tool: "attw",
      },
    ]);
  }
});

test("package manifests and TypeScript references are projections of the release graph", async () => {
  assert.deepEqual(await validateReleaseGraphProjections(), {
    packageCount: PUBLISHABLE_PACKAGES.length,
  });
});

test("release graph projections reject reverse dev edges and reference drift", () => {
  const graph = {
    packages: [
      { dependencies: [], name: "@example/a", root: "packages/a" },
      { dependencies: ["@example/a"], name: "@example/b", root: "packages/b" },
    ],
  };
  const manifestsByName = new Map([
    ["@example/a", { name: "@example/a" }],
    ["@example/b", {
      dependencies: { "@example/a": "workspace:*" },
      devDependencies: { "@example/a": "workspace:*" },
      name: "@example/b",
    }],
  ]);
  const diagnostics = releaseGraphProjectionDiagnostics({
    graph,
    manifestsByName,
    packageTsconfigsByName: new Map([
      ["@example/a", { references: [] }],
      ["@example/b", { references: [] }],
    ]),
    rootTsconfig: { references: [{ path: "./packages/b" }, { path: "./packages/a" }] },
  });
  assert.deepEqual(diagnostics, [
    "@example/b declares an internal package in multiple dependency sections",
    "@example/b tsconfig references differ from the release graph",
    "root tsconfig references must exactly follow package release graph order",
  ]);
});

test("versioned release graph rejects ambiguity, escapes and non-topological edges", () => {
  assert.throws(
    () => parsePackageReleaseGraph(releaseGraph([releaseGraphPackage({ root: "../a" })])),
    /portable repository-relative path/u,
  );
  assert.throws(
    () => parsePackageReleaseGraph(releaseGraph([releaseGraphPackage({ root: "packages//a" })])),
    /portable repository-relative path/u,
  );
  assert.throws(
    () => parsePackageReleaseGraph(releaseGraph([
      releaseGraphPackage(),
      releaseGraphPackage({ name: "@example/b" }),
    ])),
    /root values must be unique/u,
  );
  assert.throws(
    () => parsePackageReleaseGraph(releaseGraph([
      releaseGraphPackage({ dependencies: ["@example/b"] }),
      releaseGraphPackage({
        changelogPath: "packages/b/CHANGELOG.md",
        manifestPath: "packages/b/package.json",
        name: "@example/b",
        root: "packages/b",
      }),
    ])),
    /dependencies must precede/u,
  );
  assert.throws(
    () => parsePackageReleaseGraph(releaseGraph([
      releaseGraphPackage({ dependencies: ["@example/missing"] }),
    ])),
    /undeclared package/u,
  );
});

function assertMcpBaselineMatchesManifest(baseline, manifest) {
  assert.equal(baseline.packageName, manifest.name);
  assert.equal(baseline.packageVersion, manifest.version);
}

test("registry qualification includes Docs Protocol exactly once across bootstrap promotion", () => {
  const foundation = {
    name: "@agent-teams/engineering-foundation",
    root: "packages/engineering-foundation",
  };
  const qualificationOnly = registryQualificationPackages([foundation]);
  assert.equal(
    qualificationOnly.filter(({ name }) => name === "@agent-teams/docs-protocol").length,
    1,
  );
  assert.equal(qualificationOnly.at(-1).qualificationOnly, true);

  const docs = {
    name: "@agent-teams/docs-protocol",
    root: "packages/docs-protocol",
  };
  const publicCatalog = registryQualificationPackages([foundation, docs]);
  assert.deepEqual(publicCatalog, [foundation, docs]);
  assert.equal(publicCatalog[1].qualificationOnly, undefined);
  assert.throws(
    () => registryQualificationPackages([foundation, docs, docs]),
    /unique publishable package names/u,
  );
});

test("reviewed catalog owns the public Docs Protocol manifest", async () => {
  const docsEntries = PUBLISHABLE_PACKAGES.filter(
    ({ name }) => name === "@agent-teams/docs-protocol",
  );
  assert.deepEqual(docsEntries, [
    {
      changelogPath: "packages/docs-protocol/CHANGELOG.md",
      manifestPath: "packages/docs-protocol/package.json",
      name: "@agent-teams/docs-protocol",
      root: "packages/docs-protocol",
    },
  ]);
  const manifest = JSON.parse(
    await readFile(new URL("../packages/docs-protocol/package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.publishConfig, {
    access: "public",
    provenance: true,
    registry: "https://registry.npmjs.org/",
  });
});

test("reviewed catalog and API baseline follow the public Docs Protocol MCP manifest", async () => {
  const entries = PUBLISHABLE_PACKAGES.filter(
    ({ name }) => name === "@agent-teams/docs-protocol-mcp",
  );
  assert.deepEqual(entries, [
    {
      changelogPath: "packages/docs-protocol-mcp/CHANGELOG.md",
      manifestPath: "packages/docs-protocol-mcp/package.json",
      name: "@agent-teams/docs-protocol-mcp",
      root: "packages/docs-protocol-mcp",
    },
  ]);
  const manifest = JSON.parse(
    await readFile(new URL("../packages/docs-protocol-mcp/package.json", import.meta.url), "utf8"),
  );
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.dependencies["@agent-teams/docs-protocol"], "workspace:*");
  assert.deepEqual(manifest.publishConfig, {
    access: "public",
    provenance: true,
    registry: "https://registry.npmjs.org/",
  });
  const baseline = JSON.parse(
    await readFile(new URL("../architecture/public-api/docs-protocol-mcp.json", import.meta.url), "utf8"),
  );
  assertMcpBaselineMatchesManifest(baseline, manifest);
});

test("Docs Protocol MCP API baseline supports the initial release transition", () => {
  for (const version of ["0.0.0", "0.1.0"]) {
    assert.doesNotThrow(() => assertMcpBaselineMatchesManifest(
      { packageName: "@agent-teams/docs-protocol-mcp", packageVersion: version },
      { name: "@agent-teams/docs-protocol-mcp", version },
    ));
  }
  assert.throws(() => assertMcpBaselineMatchesManifest(
    { packageName: "@agent-teams/docs-protocol-mcp", packageVersion: "0.0.0" },
    { name: "@agent-teams/docs-protocol-mcp", version: "0.1.0" },
  ));
});

test("release manifest exactly follows the package self-check allowlist", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("package.json", repositoryPackageRoot),
    "utf8",
  ));
  assert.deepEqual(manifest.files, FOUNDATION_PACKAGE_FILE_ALLOWLIST);
  for (const schemaId of FOUNDATION_SCHEMA_IDS) {
    assert.ok(manifest.files.includes(`schemas/${schemaId}.schema.json`));
  }
  assert.ok(manifest.exports["./document-authoring"]);
});

test("tarball inventory rejects any source or unallowlisted release file", () => {
  const required = FOUNDATION_REQUIRED_ARTIFACT_PATHS.map(
    (path) => `package/${path}`,
  );
  const base = [
    "package/",
    "package/package.json",
    "package/LICENSE",
    "package/README.md",
    ...required,
  ].join("\n");
  assertArchiveListing(base, FOUNDATION_REQUIRED_ARTIFACT_PATHS);
  assert.throws(
    () => assertArchiveListing(`${base}\npackage/private-token.txt\n`, FOUNDATION_REQUIRED_ARTIFACT_PATHS),
    /outside the release allowlist/u,
  );
  assert.throws(
    () => assertArchiveListing(`${base}\npackage/src/private.ts\n`, FOUNDATION_REQUIRED_ARTIFACT_PATHS),
    /Forbidden package entry/u,
  );
});

test("clean checkout package stages materialize the repository license", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-clean-package-stage-"));
  try {
    const packageRoot = join(root, "packages", "qualified-package");
    const supportRoot = join(root, "packages", "support-package");
    const temporaryRoot = join(root, "temporary");
    await Promise.all([
      mkdir(join(packageRoot, "node_modules"), { recursive: true }),
      mkdir(join(supportRoot, "node_modules"), { recursive: true }),
      mkdir(temporaryRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "LICENSE"), "canonical repository license\n"),
      writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n"),
      writeFile(join(packageRoot, "package.json"), '{"name":"qualified-package"}\n'),
      writeFile(join(supportRoot, "package.json"), '{"name":"support-package"}\n'),
    ]);

    const stage = await createCleanBuildStage({
      artifactLabel: "clean-checkout",
      packageRoot,
      repositoryRoot: root,
      runBuild: async () => {},
      supportPackageRoots: [supportRoot],
      temporaryRoot,
    }, "a");

    assert.equal(
      await readFile(join(stage.packageRoot, "LICENSE"), "utf8"),
      "canonical repository license\n",
    );
    assert.equal(
      await readFile(join(stage.stageRoot, "packages", "support-package", "LICENSE"), "utf8"),
      "canonical repository license\n",
    );

    const docsRoot = join(root, "packages", "docs-protocol");
    const foundationRoot = join(root, "packages", "engineering-foundation");
    await Promise.all([
      mkdir(docsRoot, { recursive: true }),
      mkdir(foundationRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(docsRoot, "package.json"),
        `${JSON.stringify({
          name: "@agent-teams/docs-protocol",
          version: "0.0.0",
          private: true,
          dependencies: { "@agent-teams/engineering-foundation": "workspace:*" },
        })}\n`,
      ),
      writeFile(
        join(foundationRoot, "package.json"),
        '{"name":"@agent-teams/engineering-foundation","version":"0.17.0-rc.0"}\n',
      ),
    ]);
    const disposableRoot = await stageQualificationPackage({
      destination: join(temporaryRoot, "registry"),
      foundationPackageName: "@agent-teams/engineering-foundation",
      releasePackage: {
        name: "@agent-teams/docs-protocol",
        qualificationOnly: true,
        root: "packages/docs-protocol",
      },
      repositoryRoot: root,
    });
    assert.equal(
      await readFile(join(disposableRoot, "LICENSE"), "utf8"),
      "canonical repository license\n",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("package self-check rejects a symlinked required artifact", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "foundation-package-inventory-"));
  try {
    const packageRoot = join(root, "package");
    await cp(repositoryPackageRoot, packageRoot, {
      filter(source) {
        return !source.includes("node_modules") && !source.includes("tsconfig.tsbuildinfo");
      },
      recursive: true,
    });
    const target = join(packageRoot, "presets", "oxlint", "base.json");
    const source = `${target}.original`;
    await cp(target, source);
    await rm(target);
    await symlink(source, target, "file");
    await assert.rejects(
      inspectFoundationPackage(packageRoot),
      (error) =>
        error?.code === "PACKAGE_INVALID" &&
        /presets\/oxlint\/base\.json/u.test(error.message),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("package self-check rejects manifest expansion beyond the allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-package-manifest-"));
  try {
    const packageRoot = join(root, "package");
    await cp(repositoryPackageRoot, packageRoot, {
      filter(source) {
        return !source.includes("node_modules") && !source.includes("tsconfig.tsbuildinfo");
      },
      recursive: true,
    });
    const manifestPath = join(packageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files.push("src");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      inspectFoundationPackage(packageRoot),
      (error) =>
        error?.code === "PACKAGE_INVALID" &&
        /exact release allowlist/u.test(error.message),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
