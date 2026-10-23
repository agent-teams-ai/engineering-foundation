import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runNpmCommand } from "../scripts/pack-test-support.mjs";
import { readQualifiedReleaseArtifact } from "../scripts/release-publish-ordered-runtime.mjs";
import { PUBLISHABLE_PACKAGES } from "../scripts/publishable-packages.mjs";
import { packAndInspectArtifact, snapshotVerifiedArtifact } from "../scripts/pack-artifact-e2e.mjs";
import {
  canonicalPublishManifest,
  npmPackManifest,
} from "../scripts/pack-artifact-stage-support.mjs";
import { createPackFixture, qualifiedArchive } from "./pack-publishable-artifacts-support.mjs";

test("pending Foundation releases version FMS when its canonical packed manifest changes", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const require = createRequire(import.meta.url);
  const changesets = createRequire(require.resolve("@changesets/cli/package.json"));
  const plan = await changesets("@changesets/get-release-plan").default(root);
  const foundationName = "@agent-teams/engineering-foundation";
  const foundation = plan.releases.find((release) => release.name === foundationName);
  // A version PR has consumed the pending train; no dependency transition remains.
  if (foundation === undefined || foundation.newVersion === foundation.oldVersion) {
    return;
  }
  const manifest = JSON.parse(
    await readFile(
      new URL("../packages/feature-module-standard/package.json", import.meta.url),
      "utf8",
    ),
  );
  const rootManifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const project = (version) =>
    canonicalPublishManifest(manifest, {
      catalogVersions: new Map(Object.entries(rootManifest.workspaces.catalog)),
      internalPackageVersions: new Map([[foundationName, version]]),
    });
  const before = project(foundation.oldVersion);
  const after = project(foundation.newVersion);
  assert.equal(before.peerDependencies[foundationName], "^1.8.0 || ^2.0.0 || ^3.0.0");
  assert.equal(after.peerDependencies[foundationName], "^1.8.0 || ^2.0.0 || ^3.0.0");
  assert.equal(before.devDependencies[foundationName], foundation.oldVersion);
  assert.equal(after.devDependencies[foundationName], foundation.newVersion);
  assert.notDeepEqual(before, after, "The exact dev dependency still alters published FMS bytes");
  const fms = plan.releases.find((release) => release.name === manifest.name);
  assert.ok(
    fms && fms.type !== "none" && fms.newVersion !== fms.oldVersion,
    "Changed packed FMS bytes require a new FMS version; an optional compatible peer does not make existing npm bytes mutable",
  );
  if (foundation.newVersion === "2.0.0" && manifest.version === "0.1.2") {
    assert.equal(
      fms.newVersion,
      "0.2.0",
      "The compatible peer-window expansion must keep FMS on its intended 0.x minor train",
    );
  }
});

test("official Changesets status and version keep the compatible Foundation 2 FMS release on 0.x", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fms-compatible-release-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Status consults Git's base; borrow only committed objects, with fixture-owned refs.
  const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
  const clone = spawnSync(
    "git",
    ["clone", "--shared", "--no-checkout", "--quiet", sourceRoot, root],
    { encoding: "utf8" },
  );
  assert.equal(clone.status, 0, clone.stdout + clone.stderr);
  const base = spawnSync("git", ["update-ref", "refs/heads/main", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(base.status, 0, base.stdout + base.stderr);
  const require = createRequire(import.meta.url);
  const cli = require.resolve("@changesets/cli/bin.js");
  const foundationName = "@agent-teams/engineering-foundation";
  const standardName = "@agent-teams/feature-module-standard";
  const config = JSON.parse(
    await readFile(new URL("../.changeset/config.json", import.meta.url), "utf8"),
  );
  const standard = JSON.parse(
    await readFile(
      new URL("../packages/feature-module-standard/package.json", import.meta.url),
      "utf8",
    ),
  );
  await mkdir(join(root, ".changeset"));
  await writeFile(join(root, "DISPOSABLE_SANDBOX"), "Official Changesets release-plan fixture.\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fms-release-TEST", private: true, workspaces: ["packages/*"] }),
  );
  await writeFile(
    join(root, ".changeset/config.json"),
    JSON.stringify({ ...config, changelog: false }),
  );
  for (const [directory, manifest] of [
    ["foundation", { name: foundationName, version: "1.10.1" }],
    [
      "standard",
      {
        name: standardName,
        version: "0.1.2",
        peerDependencies: standard.peerDependencies,
        peerDependenciesMeta: standard.peerDependenciesMeta,
        devDependencies: { [foundationName]: "workspace:*" },
      },
    ],
  ]) {
    await mkdir(join(root, "packages", directory), { recursive: true });
    await writeFile(join(root, "packages", directory, "package.json"), JSON.stringify(manifest));
  }
  await writeFile(
    join(root, ".changeset/compatible-release.md"),
    [
      "---",
      `"${foundationName}": major`,
      `"${standardName}": minor`,
      "---",
      "",
      "Compatible peer window TEST release.",
      "",
    ].join("\n"),
  );
  const run = (args) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  run(["status", "--output", "release-plan.json"]);
  const plan = JSON.parse(await readFile(join(root, "release-plan.json"), "utf8"));
  const versions = Object.fromEntries(
    plan.releases.map(({ name, newVersion }) => [name, newVersion]),
  );
  assert.deepEqual(versions, { [foundationName]: "2.0.0", [standardName]: "0.2.0" });
  run(["version"]);
  const versioned = JSON.parse(
    await readFile(join(root, "packages/standard/package.json"), "utf8"),
  );
  assert.equal(versioned.version, "0.2.0");
  // The official versioner may retain workspace:; the canonical pack must strip it.
  assert.equal(
    canonicalPublishManifest(versioned, {
      catalogVersions: new Map(),
      internalPackageVersions: new Map([[foundationName, "2.0.0"]]),
    }).peerDependencies[foundationName],
    "^1.8.0 || ^2.0.0 || ^3.0.0",
  );
  assert.equal(
    JSON.parse(await readFile(join(root, "packages/foundation/package.json"), "utf8")).version,
    "2.0.0",
  );
  t.diagnostic(`Official Changesets release plan: ${JSON.stringify(versions)}`);
});

test("publish manifest canonicalizes exact dependency authorities without reordering other fields", async (t) => {
  const source = {
    name: "@fixture/app",
    exports: { node: "./node.js", default: "./index.js" },
    dependencies: { zed: "2.0.0", "@fixture/core": "workspace:*", ajv: "catalog:" },
    devDependencies: { typescript: "catalog:", alpha: "1.0.0" },
  };
  const canonical = canonicalPublishManifest(source, {
    catalogVersions: new Map([
      ["ajv", "8.20.0"],
      ["typescript", "7.0.2"],
    ]),
    internalPackageVersions: new Map([["@fixture/core", "1.2.3"]]),
  });
  assert.deepEqual(Object.keys(canonical.exports), ["node", "default"]);
  assert.deepEqual(canonical.dependencies, {
    "@fixture/core": "1.2.3",
    ajv: "8.20.0",
    zed: "2.0.0",
  });
  assert.deepEqual(canonical.devDependencies, { alpha: "1.0.0", typescript: "7.0.2" });
  assert.equal(source.dependencies["@fixture/core"], "workspace:*");

  for (const [specifier, expected] of [
    ["workspace:^", /requires workspace:\*/u],
    ["catalog:parser-oracle", /only supports the default catalog/u],
  ]) {
    await t.test(`rejects ${specifier}`, () => {
      assert.throws(
        () =>
          canonicalPublishManifest(
            { dependencies: { dependency: specifier } },
            {
              catalogVersions: new Map(),
              internalPackageVersions: new Map(),
            },
          ),
        expected,
      );
    });
  }
  await t.test("turns an internal peer range into a caret range of the workspace version", () => {
    const context = {
      catalogVersions: new Map(),
      internalPackageVersions: new Map([["@fixture/core", "1.8.0"]]),
    };
    assert.deepEqual(
      canonicalPublishManifest({ peerDependencies: { "@fixture/core": "workspace:^" } }, context)
        .peerDependencies,
      { "@fixture/core": "^1.8.0" },
    );
    assert.deepEqual(
      canonicalPublishManifest(
        { peerDependencies: { "@fixture/core": "workspace:^" } },
        {
          ...context,
          internalPackageVersions: new Map([["@fixture/core", "1.8.0-rc.0"]]),
        },
      ).peerDependencies,
      { "@fixture/core": "^1.8.0-rc.0" },
    );
    assert.throws(
      () =>
        canonicalPublishManifest(
          { peerDependencies: { "@fixture/core": "workspace:^" } },
          { catalogVersions: new Map(), internalPackageVersions: new Map() },
        ),
      /cannot resolve workspace version/u,
    );
    assert.throws(
      () =>
        canonicalPublishManifest(
          { optionalDependencies: { "@fixture/core": "workspace:^" } },
          context,
        ),
      /requires workspace:\*/u,
    );
  });
  await t.test("retains an explicit stable peer minimum while the workspace advances", () => {
    const peerDependencies = { "@fixture/core": "workspace:^1.8.0" };
    for (const version of ["1.8.0", "1.9.0", "1.10.0"]) {
      const context = {
        catalogVersions: new Map(),
        internalPackageVersions: new Map([["@fixture/core", version]]),
      };
      assert.deepEqual(
        canonicalPublishManifest(
          { peerDependencies, devDependencies: { "@fixture/core": "workspace:*" } },
          context,
        ),
        {
          peerDependencies: { "@fixture/core": "^1.8.0" },
          devDependencies: { "@fixture/core": version },
        },
      );
    }
    for (const version of ["1.7.4", "2.0.0", "1.10.0-rc.0"]) {
      assert.throws(
        () =>
          canonicalPublishManifest(
            { peerDependencies },
            {
              catalogVersions: new Map(),
              internalPackageVersions: new Map([["@fixture/core", version]]),
            },
          ),
        /does not admit workspace version/u,
      );
    }
    for (const [minimum, accepted, rejected] of [
      ["0.2.3", "0.2.9", "0.3.0"],
      ["0.0.3", "0.0.3", "0.0.4"],
      ["0.0.0", "0.0.0", "0.0.1"],
    ]) {
      const peers = { peerDependencies: { "@fixture/core": `workspace:^${minimum}` } };
      const context = {
        catalogVersions: new Map(),
        internalPackageVersions: new Map([["@fixture/core", accepted]]),
      };
      assert.deepEqual(canonicalPublishManifest(peers, context).peerDependencies, {
        "@fixture/core": `^${minimum}`,
      });
      assert.throws(
        () =>
          canonicalPublishManifest(peers, {
            ...context,
            internalPackageVersions: new Map([["@fixture/core", rejected]]),
          }),
        /does not admit workspace version/u,
      );
    }
    for (const specifier of [
      "workspace:^1.8",
      "workspace:^01.8.0",
      "workspace:^1.8.0-rc.0",
      "workspace:^1.8.0 || *",
      "workspace:^1.8.0 || ^2.0",
      "workspace:^1.8.0 || ^2.0.0-rc.0",
      "workspace:^1.8.0||^2.0.0",
      "workspace:^1.8.0 || >=2.0.0",
      "workspace:^1.8.0 || ",
    ]) {
      assert.throws(
        () =>
          canonicalPublishManifest(
            { peerDependencies: { "@fixture/core": specifier } },
            {
              catalogVersions: new Map(),
              internalPackageVersions: new Map([["@fixture/core", "1.9.0"]]),
            },
          ),
        /does not admit workspace version/u,
      );
    }
    assert.throws(
      () =>
        canonicalPublishManifest(
          { peerDependencies },
          {
            catalogVersions: new Map(),
            internalPackageVersions: new Map(),
          },
        ),
      /cannot resolve workspace version/u,
    );
    assert.throws(
      () =>
        canonicalPublishManifest(
          { dependencies: peerDependencies },
          {
            catalogVersions: new Map(),
            internalPackageVersions: new Map([["@fixture/core", "1.9.0"]]),
          },
        ),
      /requires workspace:\*/u,
    );
  });
  await t.test("retains only validated stable caret union branches", () => {
    const peerDependencies = { "@fixture/core": "workspace:^1.8.0 || ^2.0.0" };
    for (const version of ["1.8.0", "1.10.1", "2.0.0", "2.9.9"]) {
      assert.deepEqual(
        canonicalPublishManifest(
          { peerDependencies },
          {
            catalogVersions: new Map(),
            internalPackageVersions: new Map([["@fixture/core", version]]),
          },
        ).peerDependencies,
        { "@fixture/core": "^1.8.0 || ^2.0.0" },
      );
    }
    for (const version of ["1.7.9", "3.0.0", "2.0.0-rc.0"]) {
      assert.throws(
        () =>
          canonicalPublishManifest(
            { peerDependencies },
            {
              catalogVersions: new Map(),
              internalPackageVersions: new Map([["@fixture/core", version]]),
            },
          ),
        /does not admit workspace version/u,
      );
    }
  });
  await t.test("rejects unresolved exact authorities", () => {
    assert.throws(
      () =>
        canonicalPublishManifest(
          { dependencies: { dependency: "workspace:*" } },
          {
            catalogVersions: new Map(),
            internalPackageVersions: new Map(),
          },
        ),
      /cannot resolve exact workspace version/u,
    );
    assert.throws(
      () =>
        canonicalPublishManifest(
          { dependencies: { dependency: "catalog:" } },
          {
            catalogVersions: new Map(),
            internalPackageVersions: new Map(),
          },
        ),
      /cannot resolve exact catalog version/u,
    );
  });
  await t.test("rejects alternate publish roots", () => {
    assert.throws(
      () =>
        canonicalPublishManifest(
          { publishConfig: { directory: "dist" } },
          {
            catalogVersions: new Map(),
            internalPackageVersions: new Map(),
          },
        ),
      /cannot use publishConfig\.directory/u,
    );
  });
});

test("packed FMS peer union admits the minimum and Foundation 2 and 3 under strict peers only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fms-strict-peers-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const foundationName = "@agent-teams/engineering-foundation";
  const standard = JSON.parse(
    await readFile(
      new URL("../packages/feature-module-standard/package.json", import.meta.url),
      "utf8",
    ),
  );
  const packed = canonicalPublishManifest(
    {
      name: standard.name,
      version: "0.2.0",
      peerDependencies: standard.peerDependencies,
      peerDependenciesMeta: standard.peerDependenciesMeta,
    },
    {
      catalogVersions: new Map(),
      internalPackageVersions: new Map([[foundationName, "2.0.0"]]),
    },
  );
  await writeFile(join(root, "standard.tgz"), qualifiedArchive(packed));
  for (const version of ["1.8.0", "2.0.0", "3.0.0", "1.7.9", "4.0.0", "3.0.0-rc.0"]) {
    const consumer = join(root, version);
    await mkdir(consumer);
    await writeFile(
      join(consumer, "foundation.tgz"),
      qualifiedArchive({ name: foundationName, version }),
    );
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: {
          [foundationName]: "file:./foundation.tgz",
          [standard.name]: "file:../standard.tgz",
        },
      }),
    );
    const install = runNpmCommand(
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--strict-peer-deps",
        "--no-audit",
        "--no-fund",
        "--cache",
        join(root, "cache"),
      ],
      consumer,
      { timeoutMs: 30_000 },
    );
    if (version === "1.8.0" || version === "2.0.0" || version === "3.0.0") {
      await install;
    } else {
      await assert.rejects(install, (error) => /ERESOLVE/u.test(error.stderr));
    }
  }
});

test("isolated publish manifest matches npm pack top-level key order", () => {
  const manifest = { version: "1.0.0", name: "@fixture/app", description: "fixture" };
  assert.deepEqual(Object.keys(npmPackManifest(manifest)), ["description", "name", "version"]);
  assert.deepEqual(Object.keys(manifest), ["version", "name", "description"]);
});

test("packed dependency versions must match the sealed publish authority", async (t) => {
  const fixture = await createPackFixture(t, "pack-dependency-substitution-");
  const authoritativeManifest = {
    name: "@fixture/qualified",
    peerDependencies: { external: "1.0.0" },
    version: "1.2.3",
  };
  await writeFile(join(fixture.packageRoot, "package.json"), JSON.stringify(authoritativeManifest));
  const substituted = qualifiedArchive({
    ...authoritativeManifest,
    peerDependencies: { external: "9.0.0" },
  });
  await assert.rejects(
    packAndInspectArtifact({
      ...fixture,
      buildPackageNames: ["@fixture/qualified"],
      dependencyDeclarations: { "@fixture/qualified": [] },
      packageName: "@fixture/qualified",
      requiredArtifactPaths: ["dist/index.js"],
      runBuild: async (packageRoot) => {
        await mkdir(join(packageRoot, "dist"), { recursive: true });
        await writeFile(join(packageRoot, "dist", "index.js"), "export {};\n");
      },
      runPnpm: async (args, _cwd, options) => {
        assert.equal(args[0], "pack");
        assert.equal(options.environment.pnpm_config_ignore_pnpmfile, "false");
        const destination = args.at(args.indexOf("--pack-destination") + 1);
        const hookPath = join(destination, "..", "canonical-packing-hook.cjs");
        assert.ok(args.includes(`--config.pnpmfile=${hookPath}`));
        assert.deepEqual(
          await readFile(hookPath),
          await readFile(new URL("../.pnpmfile.cjs", import.meta.url)),
        );
        assert.equal(options.environment.pnpm_config_ignore_scripts, "true");
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "fixture-qualified-1.2.3.tgz"), substituted);
      },
      stagePackages: [
        {
          name: "@fixture/qualified",
          root: "packages/qualified",
          sourceRoot: fixture.packageRoot,
          version: "1.2.3",
        },
      ],
    }),
    /dependency manifest differs from the sealed publish authority/u,
  );
});

for (const scenario of [
  "complete",
  "archive-member-removed",
  "files-omits-export",
  "schema-bytes-changed",
]) {
  test(`production pack wildcard inventory: ${scenario}`, async (t) => {
    const fixture = await createPackFixture(t, "pack-wildcard-integration-");
    const manifest = {
      name: "@fixture/qualified",
      version: "1.2.3",
      exports: { "./schemas/*": "./schemas/*" },
      files: scenario === "files-omits-export" ? ["dist"] : ["dist", "schemas"],
    };
    const schema = Buffer.from('{"$id":"https://fixture.test/v1","type":"string"}\n');
    const secondSchema = Buffer.from('{"$id":"https://fixture.test/v2","type":"string"}\n');
    await writeFile(join(fixture.packageRoot, "package.json"), JSON.stringify(manifest));
    await mkdir(join(fixture.packageRoot, "schemas"));
    await writeFile(join(fixture.packageRoot, "schemas/v1.schema.json"), schema);
    await writeFile(join(fixture.packageRoot, "schemas/v2.schema.json"), secondSchema);
    const packOutputs = [];
    const input = {
      ...fixture,
      packageName: manifest.name,
      buildPackageNames: [manifest.name],
      dependencyDeclarations: { [manifest.name]: [] },
      allowedArtifactPaths: ["dist", "schemas"],
      requiredArtifactPaths: ["dist/index.js"],
      stagePackages: [
        { name: manifest.name, root: "packages/qualified", sourceRoot: fixture.packageRoot },
      ],
      runBuild: async (root) => {
        await mkdir(join(root, "dist"));
        await writeFile(join(root, "dist/index.js"), "export {};\n");
      },
      runPnpm: async (args, root) => {
        const entries =
          scenario === "files-omits-export"
            ? []
            : [
                { name: "package/schemas/v1.schema.json", data: schema },
                ...(scenario === "archive-member-removed"
                  ? []
                  : [
                      {
                        name: "package/schemas/v2.schema.json",
                        data:
                          scenario === "schema-bytes-changed"
                            ? Buffer.from('{"type":"number"}\n')
                            : secondSchema,
                      },
                    ]),
              ];
        const bytes = qualifiedArchive(
          JSON.parse(await readFile(join(root, "package.json"), "utf8")),
          entries,
        );
        const archivePath = join(
          args.at(args.indexOf("--pack-destination") + 1),
          "fixture-qualified-1.2.3.tgz",
        );
        packOutputs.push(archivePath);
        await writeFile(archivePath, bytes);
      },
    };
    if (scenario !== "complete") {
      await assert.rejects(
        packAndInspectArtifact(input),
        scenario === "schema-bytes-changed"
          ? /content differs.*schemas\/v2.schema.json/u
          : /missing wildcard export member/u,
      );
      return;
    }
    const artifact = await packAndInspectArtifact(input);
    const record = { ...artifact, packageName: manifest.name, packageVersion: manifest.version };
    const info = { name: manifest.name, version: manifest.version };
    const released = await readQualifiedReleaseArtifact(record, info);
    assert.equal(
      released.integrity,
      `sha512-${createHash("sha512").update(snapshotVerifiedArtifact(artifact)).digest("base64")}`,
    );
    assert.deepEqual(released.manifest.exports, manifest.exports);
    await Promise.all(packOutputs.map((path) => writeFile(path, "changed pack output")));
    assert.deepEqual(await readQualifiedReleaseArtifact(record, info), released);
    await assert.rejects(
      readQualifiedReleaseArtifact(record, { ...info, version: "1.2.4" }),
      /identity differs/u,
    );
    await assert.rejects(readQualifiedReleaseArtifact(undefined, info), /identity differs/u);
    await assert.rejects(
      readQualifiedReleaseArtifact(
        { ...record, packageVersion: "1.2.4" },
        { ...info, version: "1.2.4" },
      ),
      /manifest identity differs/u,
    );
    await rm(record.archivePath);
    await symlink(packOutputs[0], record.archivePath);
    await assert.rejects(readQualifiedReleaseArtifact(record, info), /replaced by a symlink/u);
    await rm(record.archivePath);
    await writeFile(record.archivePath, "replaced verified archive");
    await assert.rejects(readQualifiedReleaseArtifact(record, info), /digest|SHA-256|changed/iu);
  });
}

test("release and registry targets invoke the concrete qualified pack gate", async () => {
  for (const path of ["release-publish-ordered-runtime.mjs", "registry-install-e2e.mjs"]) {
    const script = await readFile(new URL(`../scripts/${path}`, import.meta.url), "utf8");
    if (path === "release-publish-ordered-runtime.mjs") {
      assert.match(
        script,
        /const \{ packPublishableArtifacts \} = await import\("\.\/pack-publishable-artifacts\.mjs"\)/u,
      );
      assert.doesNotMatch(script, /import \{ packPublishableArtifacts \} from/u);
    } else {
      assert.match(
        script,
        /import\s*\{\s*runQualifiedArtifactConsumer,\s*withQualifiedPackageArtifacts,?\s*\}\s*from "\.\/pack-publishable-artifacts\.mjs"/u,
      );
      assert.match(
        script,
        /withQualifiedPackageArtifacts\("registry",\s*\(?handle\)?\s*=>\s*qualifyRegistryConsumers\(handle, group\),?\s*\)/u,
      );
      assert.match(script, /await runRegistryInstallTest\(\);/u);
      assert.match(script, /runQualifiedArtifactConsumer\(\s*handle,\s*"registry",/u);
    }
    if (path === "release-publish-ordered-runtime.mjs") {
      assert.match(
        script,
        /const qualified = await packPublishableArtifacts\(\{ temporaryRoot(?:: destination)? \}\)/u,
      );
      assert.match(script, /readQualifiedReleaseArtifact\(qualified\[/u);
      assert.match(script, /await readVerifiedArchive\(artifact\.archivePath, artifact\.sha256\)/u);
    } else {
      assert.match(script, /readQualifiedReleaseArtifact\(artifacts\[/u);
      assert.match(script, /await checkpoint\(\);\s+await publishArchive\(/u);
      assert.doesNotMatch(script, /packPublishableArtifacts\(/u);
    }
    assert.doesNotMatch(script, /stageBuiltMarkdownPublication|createTargetArchive\(/u);
  }
});

for (const scenario of [
  "valid-wave",
  "digest-mismatch",
  "advance-after-authorization",
  "notes-exact",
  "notes-prefix",
  "notes-level-three",
  "notes-empty",
  "prerequisite-secret",
  "ambiguous-absent",
  "lost-response",
]) {
  for (const eol of ["lf", "crlf"]) {
    test(`actual release runtime closes archive authorization: ${scenario} (${eol})`, () => {
      // Isolate module hooks, subprocess/fetch stubs, and accelerated retry timers.
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./support/release-runtime-probe.mjs", import.meta.url)),
          scenario,
          eol,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /credential-secret/u);
      const evidence = JSON.parse(result.stdout.trim().split("\n").at(-1));
      assert.equal(evidence.scenario, scenario);
      if (
        ["digest-mismatch", "advance-after-authorization", "prerequisite-secret"].includes(scenario)
      ) {
        assert.match(evidence.error, /publication did not start$/u);
        assert.equal(
          result.stderr.trim(),
          evidence.error
            .replace(/^Ordered release refused: /u, "")
            .replace(/; publication did not start$/u, ""),
        );
        assert.doesNotMatch(result.stdout, /New tag:/u);
      }
      if (["ambiguous-absent", "lost-response"].includes(scenario)) {
        assert.match(
          result.stderr,
          /initial publish failure: npm publish failed; code=ECONNRESET/u,
        );
        assert.equal(
          result.stderr.trim().split("\n").length,
          scenario === "lost-response" ? PUBLISHABLE_PACKAGES.length : 1,
        );
      }
    });
  }
}

test("repository packing hook restores scripts ordering after pnpm projection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "TEST-pack-manifest-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pnpm = fileURLToPath(new URL("../node_modules/pnpm/bin/pnpm.cjs", import.meta.url));
  const hook = fileURLToPath(new URL("../.pnpmfile.cjs", import.meta.url));
  const manifest = {
    name: "manifest-order-fixture",
    version: "1.0.0",
    scripts: { build: "true" },
    sideEffects: false,
  };
  await writeFile(join(root, "package.json"), JSON.stringify(npmPackManifest(manifest)));
  const marker = join(root, "ambient-hook-ran");
  const ambient = join(root, "ambient.cjs");
  await writeFile(
    ambient,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); module.exports = {};`,
  );
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    "configDependencies:\n  forbidden-plugin: invalid-without-integrity\n",
  );
  const outputs = [];
  for (const ignore of ["true", "false"]) {
    const result = spawnSync(
      process.execPath,
      [
        pnpm,
        "pack",
        "--pack-destination",
        root,
        "--config.ignore-scripts=true",
        `--config.pnpmfile=${hook}`,
        "--config.global-pnpmfile=",
        "--config.config-dependencies=",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          pnpm_config_ignore_pnpmfile: ignore,
          pnpm_config_global_pnpmfile: ambient,
        },
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const listing = spawnSync(
      "tar",
      ["-xOf", join(root, "manifest-order-fixture-1.0.0.tgz"), "package/package.json"],
      { encoding: "utf8" },
    );
    assert.equal(listing.status, 0, listing.stderr);
    outputs.push(JSON.parse(listing.stdout));
  }
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.deepEqual(outputs[0], outputs[1]);
  assert.notDeepEqual(Object.keys(outputs[0]), Object.keys(outputs[1]));
  assert.deepEqual(Object.keys(outputs[1]), Object.keys(npmPackManifest(manifest)));
});
