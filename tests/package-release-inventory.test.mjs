import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, opendir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse as parseYaml } from "yaml";

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
import {
  registryQualificationPackages,
  stageQualificationPackage,
} from "../scripts/registry-qualification-packages.mjs";
import { PUBLISHABLE_PACKAGES } from "../scripts/publishable-packages.mjs";

const repositoryPackageRoot = new URL(
  "../packages/engineering-foundation/",
  import.meta.url,
);

function assertInitialBaselineMatchesManifest(baseline, manifest) {
  assert.equal(baseline.packageName, manifest.name);
  assert.equal(baseline.packageVersion, manifest.version);
}

function authorityPackageNames(values, authority) {
  const names = values.map(({ name }) => name).toSorted();
  assert.equal(
    new Set(names).size,
    names.length,
    `${authority} must contain unique package names`,
  );
  return names;
}

function assertPublicWorkspacePackageAuthorities({
  publicWorkspacePackages,
  publicApiPackages,
  releasePackages,
  qualificationPackages,
  securityPackages,
}) {
  const expected = authorityPackageNames(publicWorkspacePackages, "workspace package inventory");
  for (const [authority, values] of [
    ["public API", publicApiPackages],
    ["release", releasePackages],
    ["package qualification", qualificationPackages],
    ["repository security", securityPackages],
  ]) {
    const observed = authorityPackageNames(values, authority);
    const missing = expected.filter((name) => !observed.includes(name));
    const stale = observed.filter((name) => !expected.includes(name));
    if (missing.length > 0 || stale.length > 0) {
      throw new Error(
        `${authority} package authority does not match public workspace packages; ` +
          `missing=[${missing.join(", ")}], stale=[${stale.join(", ")}].`,
      );
    }
  }
}

async function resolveManifestAuthorityPackages(manifestPaths) {
  return Promise.all(
    manifestPaths.map(async (manifestPath) => {
      const manifest = JSON.parse(
        await readFile(new URL(`../${manifestPath}`, import.meta.url), "utf8"),
      );
      return { name: manifest.name };
    }),
  );
}

async function discoverPublicWorkspacePackages() {
  const packagesRoot = new URL("../packages/", import.meta.url);
  const directory = await opendir(packagesRoot);
  const packages = [];
  for await (const entry of directory) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifest = JSON.parse(
      await readFile(new URL(`${entry.name}/package.json`, packagesRoot), "utf8"),
    );
    if (manifest.private !== true) {
      packages.push({ name: manifest.name });
    }
  }
  return packages;
}

test("every public workspace package has API, release, qualification, and security authority", async () => {
  const publicApiConfig = parseYaml(
    await readFile(
      new URL("../architecture/foundation/public-api-compatibility.yaml", import.meta.url),
      "utf8",
    ),
  );
  const repositorySecurityConfig = parseYaml(
    await readFile(
      new URL("../architecture/foundation/repository-security-baseline.yaml", import.meta.url),
      "utf8",
    ),
  );
  const authorities = {
    publicWorkspacePackages: await discoverPublicWorkspacePackages(),
    publicApiPackages: publicApiConfig.packages.map(({ packageName: name }) => ({ name })),
    releasePackages: PUBLISHABLE_PACKAGES,
    qualificationPackages: registryQualificationPackages(PUBLISHABLE_PACKAGES),
    securityPackages: await resolveManifestAuthorityPackages(
      repositorySecurityConfig.publishablePackageManifests,
    ),
  };
  assert.doesNotThrow(() => assertPublicWorkspacePackageAuthorities(authorities));

  assert.throws(
    () => assertPublicWorkspacePackageAuthorities({
      ...authorities,
      qualificationPackages: authorities.qualificationPackages.filter(
        ({ name }) => name !== "@agent-teams/docs-protocol-mcp",
      ),
    }),
    /package qualification.*missing=\[@agent-teams\/docs-protocol-mcp\]/u,
  );
  assert.throws(
    () => assertPublicWorkspacePackageAuthorities({
      ...authorities,
      publicApiPackages: [...authorities.publicApiPackages, { name: "@fixture/retired" }],
    }),
    /public API.*stale=\[@fixture\/retired\]/u,
  );
  assert.throws(
    () => assertPublicWorkspacePackageAuthorities({
      ...authorities,
      securityPackages: authorities.securityPackages.slice(1),
    }),
    /repository security.*missing=\[@agent-teams\/repository-mutation\]/u,
  );
});

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

test("reviewed catalog owns the standalone Document Authoring package", async () => {
  const entries = PUBLISHABLE_PACKAGES.filter(
    ({ name }) => name === "@agent-teams/document-authoring",
  );
  assert.deepEqual(entries, [{
    changelogPath: "packages/document-authoring/CHANGELOG.md",
    manifestPath: "packages/document-authoring/package.json",
    name: "@agent-teams/document-authoring",
    root: "packages/document-authoring",
  }]);
  const manifest = JSON.parse(await readFile(
    new URL("../packages/document-authoring/package.json", import.meta.url),
    "utf8",
  ));
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.version, "0.0.0");
  assert.equal(manifest.dependencies?.["@agent-teams/repository-mutation"], "workspace:*");
  assert.equal(manifest.dependencies?.["@agent-teams/engineering-foundation"], undefined);
  assert.deepEqual(Object.keys(manifest.exports).toSorted(), [
    ".", "./observation", "./package.json", "./qualification", "./schemas/*",
  ]);
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
  assertInitialBaselineMatchesManifest(baseline, manifest);
});

test("Docs Protocol MCP API baseline supports the initial release transition", () => {
  for (const version of ["0.0.0", "0.1.0"]) {
    assert.doesNotThrow(() => assertInitialBaselineMatchesManifest(
      { packageName: "@agent-teams/docs-protocol-mcp", packageVersion: version },
      { name: "@agent-teams/docs-protocol-mcp", version },
    ));
  }
  assert.throws(() => assertInitialBaselineMatchesManifest(
    { packageName: "@agent-teams/docs-protocol-mcp", packageVersion: "0.0.0" },
    { name: "@agent-teams/docs-protocol-mcp", version: "0.1.0" },
  ));
});

test("reviewed catalog and API baseline follow the public Agent Teams adapter manifest", async () => {
  const entries = PUBLISHABLE_PACKAGES.filter(
    ({ name }) => name === "@agent-teams/docs-protocol-agent-teams",
  );
  assert.deepEqual(entries, [
    {
      changelogPath: "packages/docs-protocol-agent-teams/CHANGELOG.md",
      manifestPath: "packages/docs-protocol-agent-teams/package.json",
      name: "@agent-teams/docs-protocol-agent-teams",
      root: "packages/docs-protocol-agent-teams",
    },
  ]);
  const manifest = JSON.parse(
    await readFile(new URL("../packages/docs-protocol-agent-teams/package.json", import.meta.url), "utf8"),
  );
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  assert.equal(manifest.private, undefined);
  assert.deepEqual(Object.keys(manifest.exports).toSorted(), [
    ".",
    "./package.json",
    "./qualification",
    "./schemas/*",
  ]);
  const baseline = JSON.parse(
    await readFile(new URL("../architecture/public-api/docs-protocol-agent-teams.json", import.meta.url), "utf8"),
  );
  assertInitialBaselineMatchesManifest(baseline, manifest);
});

test("Agent Teams adapter API baseline supports the initial release transition", () => {
  for (const version of ["0.0.0", "0.1.0"]) {
    assert.doesNotThrow(() => assertInitialBaselineMatchesManifest(
      { packageName: "@agent-teams/docs-protocol-agent-teams", packageVersion: version },
      { name: "@agent-teams/docs-protocol-agent-teams", version },
    ));
  }
  assert.throws(() => assertInitialBaselineMatchesManifest(
    { packageName: "@agent-teams/docs-protocol-agent-teams", packageVersion: "0.0.0" },
    { name: "@agent-teams/docs-protocol-agent-teams", version: "0.1.0" },
  ));
});

test("Agent Teams adapter declarations close the managed qualification public types", async () => {
  const declarations = await Promise.all([
    readFile(new URL("../packages/docs-protocol-agent-teams/dist/index.d.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../packages/docs-protocol-agent-teams/dist/qualification/index.d.ts", import.meta.url),
      "utf8",
    ),
  ]);
  for (const source of declarations) {
    assert.match(source, /DocsProtocolQualificationContractV2/u);
    assert.match(source, /DocsProtocolQualificationReceiptV2/u);
    assert.match(source, /DocsProtocolQualificationScenarioV2/u);
    assert.match(source, /DocsProtocolQualificationV2Request/u);
  }
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
  assert.equal(manifest.exports["./document-authoring"], undefined);
  assert.equal(manifest.exports["./document-authoring/qualification"], undefined);
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
      authoritativePackageRoots: [supportRoot, packageRoot],
      buildPackageNames: ["qualified-package"],
      dependencyDeclarations: {
        "qualified-package": [],
        "support-package": [],
      },
      packageName: "qualified-package",
      packageRoot,
      repositoryRoot: root,
      runBuild: async () => {},
      stagePackages: [
        {
          name: "support-package",
          root: "packages/support-package",
          sourceRoot: supportRoot,
        },
        {
          name: "qualified-package",
          root: "packages/qualified-package",
          sourceRoot: packageRoot,
        },
      ],
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
