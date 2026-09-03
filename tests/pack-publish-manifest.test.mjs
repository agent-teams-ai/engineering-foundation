import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { packAndInspectArtifact } from "../scripts/pack-artifact-e2e.mjs";
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
