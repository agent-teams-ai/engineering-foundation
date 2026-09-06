import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evidence, fingerprint, inventory, packagePolicy, schema, json, fixture, inspect } from "../packages/engineering-foundation/tests/fixtures/public-api-artifact-fixture.mjs";
import { comparePackageArtifactInventory, assertPackedWildcardMembers } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/compare-package-artifact-inventory.js";
import { writeArtifactBaseline } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-artifact-baseline.js";
import { inspectCompressedTarArchive } from "../scripts/pack-artifact-archive.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { assertPackageExportCoverage } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-package-export-coverage.js";

const policy = Object.freeze({
  packageName: "@fixture/library",
  packageRoot: "packages/library",
  entrypoints: Object.freeze([
    Object.freeze({
      exportPath: ".",
      declarationEntryPoint: "packages/library/dist/index.d.ts",
    }),
  ]),
  nonTypeExports: Object.freeze([]),
});

test("fails closed when versioned types conditions expose different declarations", () => {
  assert.throws(
    () =>
      assertPackageExportCoverage({
        manifest: {
          exports: {
            ".": {
              "types@>=5.2": "./dist/current.d.ts",
              types: "./dist/index.d.ts",
              default: "./dist/index.js",
            },
          },
        },
        policy,
      }),
    /multiple declaration targets/u,
  );
});

test("accepts package-level types and typings paths without a leading dot slash", () => {
  for (const field of ["types", "typings"]) {
    assert.doesNotThrow(() =>
      assertPackageExportCoverage({
        manifest: {
          [field]: "dist/index.d.ts",
          exports: {
            ".": "./dist/index.js",
          },
        },
        policy,
      })
    );
  }
});

test("rejects unsafe package-level types paths", () => {
  for (const target of [
    "../outside.d.ts",
    "/absolute.d.ts",
    "dist\\index.d.ts",
    "dist/*.d.ts",
    "dist//index.d.ts",
  ]) {
    assert.throws(
      () =>
        assertPackageExportCoverage({
          manifest: {
            types: target,
            exports: {
              ".": "./dist/index.js",
            },
          },
          policy,
        }),
      /unsupported declaration target/u,
    );
  }
});

test("still requires dot-slash declaration targets inside exports", () => {
  assert.throws(
    () =>
      assertPackageExportCoverage({
        manifest: {
          exports: {
            ".": {
              types: "dist/index.d.ts",
              default: "./dist/index.js",
            },
          },
        },
        policy,
      }),
    /unsupported declaration target/u,
  );
});

// Real tar payload, independently containing only v1, with the original wildcard retained.
test("missing actual tar member fails even when the export pattern is unchanged", async (t) => {
  const root = await fixture(t);
  await json(root, "package/schemas/v2.schema.json", { ...schema, $id: "https://fixture.test/record/v2" });
  const released = await inspect(root);
  execFileSync("tar", ["-czf", "complete.tgz", "package"], { cwd: root });
  // Inspect the parser's regular-file representation without assuming tar directory entries.
  const paths = async (name) => inspectCompressedTarArchive(await readFile(join(root, name))).entries
    .filter((entry) => !entry.name.endsWith("/")) .map((entry) => entry.name.slice(8));
  assertPackedWildcardMembers({ actualArtifactPaths: await paths("complete.tgz"), expected: released });
  await rm(join(root, "package/schemas/v2.schema.json"));
  execFileSync("tar", ["-czf", "missing.tgz", "package"], { cwd: root });
  const manifest = JSON.parse(await readFile(join(root, "package/package.json")));
  assertPackageExportCoverage({ manifest, policy: packagePolicy });
  assert.throws(() => assertPackedWildcardMembers({ actualArtifactPaths: ["schemas/v1.schema.json"], expected: released }), /v2.schema.json/u);
  const actual = await paths("missing.tgz");
  assert.ok(actual.includes("schemas/v1.schema.json"));
  assert.throws(() => assertPackedWildcardMembers({ actualArtifactPaths: actual, expected: released }), /missing wildcard export member.*v2.schema.json/u);
  assert.equal(comparePackageArtifactInventory(released, await inspect(root), fingerprint).classification, "breaking");
});

test("CLI composes the artifact guard with typed API checks and preserves the released evidence", async () => {
  const { withPublicApiFixture, check } = await import("./support/capability-fixtures.mjs");
  const { parse, stringify } = await import("yaml");
  await withPublicApiFixture(async (root) => {
    const configPath = join(root, "architecture/foundation/public-api-compatibility.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    const owned = config.packages[0];
    owned.nonTypeExports = [{ exportPath: "./schemas/*", kind: "wildcard" }];
    await writeFile(configPath, stringify(config));
    const manifest = JSON.parse(await readFile(join(root, owned.manifestPath)));
    manifest.exports["./schemas/*"] = "./schemas/*";
    await json(root, owned.manifestPath, manifest);
    await json(root, `${owned.packageRoot}/schemas/v1.schema.json`, schema);
    const current = (await inventory.inspect(root, [owned]))[0];
    await writeArtifactBaseline({ root, policy: owned, snapshot: { ...current, status: "supported" }, mode: "create" }, evidence);
    const baselinePath = join(root, "architecture/public-api/public-api.artifacts.json");
    const baseline = await readFile(baselinePath);
    const positive = check(root);
    assert.equal(positive.result.status, 0, positive.result.stdout);
    await rm(join(root, `${owned.packageRoot}/schemas/v1.schema.json`));
    const negative = check(root);
    assert.equal(negative.result.status, 1, negative.result.stdout);
    assert.equal(negative.report.outcome, "violations");
    assert.ok(negative.report.capabilities[0].diagnostics.some((entry) => /breaking/iu.test(entry.message)));
    assert.deepEqual(await readFile(baselinePath), baseline);
  });
});

test("released artifact initial fixation binds exact archive bytes, validates every proposal, and replays creates", async (t) => {
  const { createHash } = await import("node:crypto");
  const { prepareInitialArtifactBaselines } = await import("../scripts/prepare-public-api-artifact-baselines.mjs");
  const root = await fixture(t);
  const configuration = { schemaVersion: 1, changesetDirectory: ".changeset",
    acceptedDecisionBaselinePath: "architecture/decisions/accepted-decisions.json",
    packages: [{ ...packagePolicy, entrypoints: [{ exportPath: ".", declarationEntryPoint: "package/dist/index.d.ts" }] }] };
  await json(root, "architecture/foundation/public-api-compatibility.yaml", configuration);
  execFileSync("tar", ["-czf", "released.tgz", "package"], { cwd: root });
  const bytes = await readFile(join(root, "released.tgz"));
  const sha512 = createHash("sha512").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const input = { packageName: packagePolicy.packageName, packageVersion: "1.2.0", status: "supported",
    archivePath: join(root, "released.tgz"), sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity, sourceCommit: "a".repeat(40),
    // Synthetic verifier output: this fixture tests receipt binding, not cryptography.
    verifiedProvenance: { artifact: { name: packagePolicy.packageName, version: "1.2.0", integrity },
      provenance: { commit: "a".repeat(40), sha512 } } };
  const request = { consumerRoot: root, archives: [input], temporaryRoot: root };
  for (const corrupt of [
    { sha256: "0".repeat(64) }, { packageVersion: "1.1.0" }, { verifiedProvenance: undefined },
    { status: "historical-bootstrap" }, { sourceCommit: "b".repeat(40) },
  ]) {
    await assert.rejects(prepareInitialArtifactBaselines({ ...request, archives: [{ ...input, ...corrupt }], create: true }));
    await assert.rejects(readFile(join(root, "architecture/public-api/library.artifacts.json")), { code: "ENOENT" });
  }
  // Current source has changed: initial fixation still comes from the retained release.
  await json(root, "package/schemas/v1.schema.json", { ...schema, $id: "https://fixture.test/source-only/v1" });
  const [preview] = await prepareInitialArtifactBaselines(request);
  assert.equal(preview.jsonSchemas[0].id, schema.$id);
  assert.equal(preview.archive.memberDigests[0].digest, preview.jsonSchemas[0].digest);
  await assert.rejects(readFile(join(root, "architecture/public-api/library.artifacts.json")), { code: "ENOENT" });
  await prepareInitialArtifactBaselines({ ...request, create: true });
  const baseline = await readFile(join(root, "architecture/public-api/library.artifacts.json"));
  await prepareInitialArtifactBaselines({ ...request, create: true });
  assert.deepEqual(await readFile(join(root, "architecture/public-api/library.artifacts.json")), baseline);
  await json(root, "architecture/public-api/library.artifacts.json", { ...preview, packageVersion: "9.0.0" });
  await assert.rejects(prepareInitialArtifactBaselines({ ...request, create: true }), /already exists/iu);
  assert.equal(JSON.parse(await readFile(join(root, "architecture/public-api/library.artifacts.json"))).packageVersion, "9.0.0");
});

test("initial candidate fixation rejects an archive that differs from current schemas", async (t) => {
  const { createHash } = await import("node:crypto");
  const { prepareInitialArtifactBaselines } = await import("../scripts/prepare-public-api-artifact-baselines.mjs");
  const root = await fixture(t, "0.0.0");
  const configured = { ...packagePolicy, entrypoints: [{ exportPath: ".", declarationEntryPoint: "package/dist/index.d.ts" }] };
  await json(root, "architecture/foundation/public-api-compatibility.yaml", {
    schemaVersion: 1, changesetDirectory: ".changeset", acceptedDecisionBaselinePath: "architecture/decisions/accepted-decisions.json", packages: [configured],
  });
  await json(root, "package/package.json", { name: packagePolicy.packageName, version: "0.0.0",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./schemas/*": "./schemas/*" } });
  execFileSync("tar", ["-czf", "candidate.tgz", "package"], { cwd: root });
  const bytes = await readFile(join(root, "candidate.tgz"));
  const archives = [{ packageName: packagePolicy.packageName, packageVersion: "0.0.0", status: "initial-unreleased",
    archivePath: join(root, "candidate.tgz"), sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, sourceCommit: "a".repeat(40) }];
  const input = { consumerRoot: root, temporaryRoot: root, archives };
  assert.equal((await prepareInitialArtifactBaselines(input))[0].status, "initial-unreleased");
  await json(root, "package/schemas/v1.schema.json", { ...schema, $id: "https://fixture.test/changed/v1" });
  await assert.rejects(prepareInitialArtifactBaselines({ ...input, create: true }), /differs from current/u);
  await assert.rejects(readFile(join(root, "architecture/public-api/library.artifacts.json")), { code: "ENOENT" });
});
