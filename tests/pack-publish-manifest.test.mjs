import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readQualifiedReleaseArtifact } from "../scripts/release-publish-ordered-runtime.mjs";
import { packAndInspectArtifact, snapshotVerifiedArtifact } from "../scripts/pack-artifact-e2e.mjs";
import { canonicalPublishManifest, npmPackManifest } from "../scripts/pack-artifact-stage-support.mjs";
import { createPackFixture, qualifiedArchive } from "./pack-publishable-artifacts-support.mjs";

test("publish manifest canonicalizes exact dependency authorities without reordering other fields", async (t) => {
  const source = {
    name: "@fixture/app",
    exports: { node: "./node.js", default: "./index.js" },
    dependencies: { zed: "2.0.0", "@fixture/core": "workspace:*", ajv: "catalog:" },
    devDependencies: { typescript: "catalog:", alpha: "1.0.0" },
  };
  const canonical = canonicalPublishManifest(source, {
    catalogVersions: new Map([["ajv", "8.20.0"], ["typescript", "7.0.2"]]),
    internalPackageVersions: new Map([["@fixture/core", "1.2.3"]]),
  });
  assert.deepEqual(Object.keys(canonical.exports), ["node", "default"]);
  assert.deepEqual(canonical.dependencies, {
    "@fixture/core": "1.2.3", ajv: "8.20.0", zed: "2.0.0",
  });
  assert.deepEqual(canonical.devDependencies, { alpha: "1.0.0", typescript: "7.0.2" });
  assert.equal(source.dependencies["@fixture/core"], "workspace:*");

  for (const [specifier, expected] of [
    ["workspace:^", /requires workspace:\*/u],
    ["catalog:parser-oracle", /only supports the default catalog/u],
  ]) {
    await t.test(`rejects ${specifier}`, () => {
      assert.throws(() => canonicalPublishManifest({ dependencies: { dependency: specifier } }, {
        catalogVersions: new Map(), internalPackageVersions: new Map(),
      }), expected);
    });
  }
  await t.test("rejects unresolved exact authorities", () => {
    assert.throws(() => canonicalPublishManifest({ dependencies: { dependency: "workspace:*" } }, {
      catalogVersions: new Map(), internalPackageVersions: new Map(),
    }), /cannot resolve exact workspace version/u);
    assert.throws(() => canonicalPublishManifest({ dependencies: { dependency: "catalog:" } }, {
      catalogVersions: new Map(), internalPackageVersions: new Map(),
    }), /cannot resolve exact catalog version/u);
  });
  await t.test("rejects alternate publish roots", () => {
    assert.throws(() => canonicalPublishManifest({ publishConfig: { directory: "dist" } }, {
      catalogVersions: new Map(), internalPackageVersions: new Map(),
    }), /cannot use publishConfig\.directory/u);
  });
});

test("isolated publish manifest matches npm pack top-level key order", () => {
  const manifest = { version: "1.0.0", name: "@fixture/app", description: "fixture" };
  assert.deepEqual(Object.keys(npmPackManifest(manifest)), ["description", "name", "version"]);
  assert.deepEqual(Object.keys(manifest), ["version", "name", "description"]);
});

test("packed dependency versions must match the sealed publish authority", async (t) => {
  const fixture = await createPackFixture(t, "pack-dependency-substitution-");
  const authoritativeManifest = {
    name: "@fixture/qualified", peerDependencies: { external: "1.0.0" }, version: "1.2.3",
  };
  await writeFile(join(fixture.packageRoot, "package.json"), JSON.stringify(authoritativeManifest));
  const substituted = qualifiedArchive({
    ...authoritativeManifest, peerDependencies: { external: "9.0.0" },
  });
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
    runPnpm: async (args, _cwd, options) => {
      assert.equal(args[0], "pack");
      assert.equal(options.environment.pnpm_config_ignore_pnpmfile, "true");
      assert.equal(options.environment.pnpm_config_ignore_scripts, "true");
      const destination = args.at(args.indexOf("--pack-destination") + 1);
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "fixture-qualified-1.2.3.tgz"), substituted);
    },
    stagePackages: [{
      name: "@fixture/qualified", root: "packages/qualified", sourceRoot: fixture.packageRoot, version: "1.2.3",
    }],
  }), /dependency manifest differs from the sealed publish authority/u);
});

for (const scenario of ["complete", "archive-member-removed", "files-omits-export", "schema-bytes-changed"]) {
  test(`production pack wildcard inventory: ${scenario}`, async (t) => {
    const fixture = await createPackFixture(t, "pack-wildcard-integration-");
    const manifest = {
      name: "@fixture/qualified", version: "1.2.3",
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
      stagePackages: [{ name: manifest.name, root: "packages/qualified", sourceRoot: fixture.packageRoot }],
      runBuild: async (root) => {
        await mkdir(join(root, "dist"));
        await writeFile(join(root, "dist/index.js"), "export {};\n");
      },
      runPnpm: async (args, root) => {
        const entries = scenario === "files-omits-export" ? [] : [
          { name: "package/schemas/v1.schema.json", data: schema },
          ...(scenario === "archive-member-removed" ? [] : [{
            name: "package/schemas/v2.schema.json",
            data: scenario === "schema-bytes-changed" ? Buffer.from('{"type":"number"}\n') : secondSchema,
          }]),
        ];
        const bytes = qualifiedArchive(JSON.parse(await readFile(join(root, "package.json"), "utf8")), entries);
        const archivePath = join(args.at(args.indexOf("--pack-destination") + 1), "fixture-qualified-1.2.3.tgz");
        packOutputs.push(archivePath);
        await writeFile(archivePath, bytes);
      },
    };
    if (scenario !== "complete") {
      await assert.rejects(packAndInspectArtifact(input), scenario === "schema-bytes-changed"
        ? /content differs.*schemas\/v2.schema.json/u : /missing wildcard export member/u);
      return;
    }
    const artifact = await packAndInspectArtifact(input);
    const record = { ...artifact, packageName: manifest.name, packageVersion: manifest.version };
    const info = { name: manifest.name, version: manifest.version };
    const released = await readQualifiedReleaseArtifact(record, info);
    assert.equal(released.integrity, `sha512-${createHash("sha512").update(snapshotVerifiedArtifact(artifact)).digest("base64")}`);
    assert.deepEqual(released.manifest.exports, manifest.exports);
    await Promise.all(packOutputs.map((path) => writeFile(path, "changed pack output")));
    assert.deepEqual(await readQualifiedReleaseArtifact(record, info), released);
    await assert.rejects(readQualifiedReleaseArtifact(record, { ...info, version: "1.2.4" }), /identity differs/u);
    await assert.rejects(readQualifiedReleaseArtifact(undefined, info), /identity differs/u);
    await assert.rejects(readQualifiedReleaseArtifact({ ...record, packageVersion: "1.2.4" },
      { ...info, version: "1.2.4" }), /manifest identity differs/u);
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
    assert.match(script, /import \{ packPublishableArtifacts \} from "\.\/pack-publishable-artifacts\.mjs"/u);
    assert.match(script, /const qualified = await packPublishableArtifacts\(\{ temporaryRoot(?:: destination)? \}\)/u);
    assert.match(script, /readQualifiedReleaseArtifact\(qualified\[/u);
    assert.match(script, /await readVerifiedArchive\((?:artifact|target)\.archivePath, (?:artifact|target)\.sha256\)/u);
    assert.doesNotMatch(script, /stageBuiltMarkdownPublication|createTargetArchive\(/u);
  }
});

for (const scenario of ["valid-wave", "digest-mismatch", "advance-after-authorization"]) {
  for (const eol of ["lf", "crlf"]) {
    test(`actual release runtime closes archive authorization: ${scenario} (${eol})`, () => {
      // Isolate module hooks, subprocess/fetch stubs, and accelerated retry timers.
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL("./support/release-runtime-probe.mjs", import.meta.url)), scenario, eol,
      ], { encoding: "utf8", timeout: 30_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }
}
