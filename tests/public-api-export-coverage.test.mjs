import { execFileSync } from "node:child_process";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  execFileSync("tar", ["--format=ustar", "-czf", "complete.tgz", "package"], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: "1" } });
  // Inspect the parser's regular-file representation without assuming tar directory entries.
  const paths = async (name) => inspectCompressedTarArchive(await readFile(join(root, name))).entries
    .filter((entry) => !entry.name.endsWith("/")) .map((entry) => entry.name.slice(8));
  assertPackedWildcardMembers({ actualArtifactPaths: await paths("complete.tgz"), expected: released });
  await rm(join(root, "package/schemas/v2.schema.json"));
  execFileSync("tar", ["--format=ustar", "-czf", "missing.tgz", "package"], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: "1" } });
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
  execFileSync("tar", ["--format=ustar", "-czf", "released.tgz", "package"], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: "1" } });
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
  execFileSync("tar", ["--format=ustar", "-czf", "candidate.tgz", "package"], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: "1" } });
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

const regular = (name, value = "unselected") => ({ name, data: Buffer.from(value), type: "0" });

test("archive preparation validates all portable ancestors before selecting payload, independent of order", async (t) => {
  const { createHash } = await import("node:crypto");
  const { tarArchive } = await import("./pack-publishable-artifacts-support.mjs");
  const { prepareInitialArtifactBaselines } = await import("../scripts/prepare-public-api-artifact-baselines.mjs");
  const root = await fixture(t);
  await json(root, "architecture/foundation/public-api-compatibility.yaml", {
    schemaVersion: 1, changesetDirectory: ".changeset", acceptedDecisionBaselinePath: "architecture/decisions/accepted-decisions.json",
    packages: [{ ...packagePolicy, entrypoints: [{ exportPath: ".", declarationEntryPoint: "package/dist/index.d.ts" }] }],
  });
  const manifest = { name: packagePolicy.packageName, version: "1.2.0", exports: { "./schemas/*": "./schemas/*" } };
  const required = [regular("package/package.json", JSON.stringify(manifest)), regular("package/schemas/v1.schema.json", JSON.stringify(schema))];
  async function prepare(entries) {
    const bytes = tarArchive(entries);
    const archivePath = join(root, "tree.tgz");
    await writeFile(archivePath, bytes);
    const sha = (algorithm, encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
    const integrity = `sha512-${sha("sha512", "base64")}`;
    return prepareInitialArtifactBaselines({ consumerRoot: root, temporaryRoot: root, archives: [{
      packageName: manifest.name, packageVersion: manifest.version, status: "supported", archivePath,
      sha256: sha("sha256"), integrity, sourceCommit: "a".repeat(40),
      // A binding fixture only; no synthetic signature or provenance authenticity claim.
      verifiedProvenance: { artifact: { name: manifest.name, version: manifest.version, integrity },
        provenance: { commit: "a".repeat(40), sha512: sha("sha512") } },
    }] });
  }
  for (const extra of [
    [], [{ name: "package/schemas/", type: "5", data: Buffer.alloc(0) }],
    [{ name: "package/schemas", type: "5", data: Buffer.alloc(0) }, regular("package/schemas-sibling")],
  ]) {
    for (const entries of [[...extra, ...required], [...required, ...extra]]) {
      assert.equal((await prepare(entries))[0].jsonSchemas.length, 1);
    }
  }
  for (const extra of [
    [regular("package/schemas")], [regular("package/SCHEMAS")],
    [regular("package/unselected"), regular("package/unselected/deep/child")],
    [regular("package/unselected"), { name: "package/unselected/dir/", type: "5", data: Buffer.alloc(0) }],
  ]) {
    for (const entries of [[...extra, ...required], [...required, ...extra.toReversed()]]) {
      await assert.rejects(prepare(entries), /regular member is an ancestor/u);
    }
  }
  await assert.rejects(readFile(join(root, "architecture/public-api/library.artifacts.json")), { code: "ENOENT" });
});

test("wildcard availability uses actual Node resolution for null, conditions, arrays and nesting", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const root = await fixture(t);
  const baseline = await inspect(root);
  const target = "./schemas/*";
  const cases = [
    { target, accepted: true, resolves: true },
    { target: { node: target, default: target }, accepted: true, resolves: true },
    { target: { node: { require: target, default: target }, default: target }, accepted: true, resolves: true },
    { target: [target, target], accepted: true, resolves: true },
    { target: [{ node: target, default: target }, [target]], accepted: true, resolves: true },
    { target: { node: null, default: target }, accepted: false, resolves: false },
    { target: { node: { require: null, default: target }, default: target }, accepted: false, resolves: false },
    { target: [{ node: null, default: target }], accepted: false, resolves: false },
    { target: { node: [], default: target }, accepted: false, resolves: false },
    { target: { browser: target }, accepted: false, resolves: false },
    // Node's array fallback can recover from null, but the one-target model conservatively refuses it.
    { target: [null, target], accepted: false, resolves: true },
    { target: [{ node: null, default: target }, target], accepted: false, resolves: true },
    { target: { node: target }, accepted: false, resolves: true },
    { target: { node: { browser: target }, default: target }, accepted: false, resolves: true },
  ];
  for (const entry of cases) {
    const label = JSON.stringify(entry.target);
    await json(root, "package/package.json", { name: packagePolicy.packageName, version: "1.2.0", exports: { "./schemas/*": entry.target } });
    // A fresh process avoids Node's manifest cache. resolve reads metadata only, executing no package code.
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import {createRequire} from 'node:module'; const require = createRequire(${JSON.stringify(join(root, "package/resolver.cjs"))});
       try { console.log(require.resolve('@fixture/library/schemas/v1.schema.json')); }
       catch (error) { console.log(error.code); process.exitCode = 2; }`,
    ], { encoding: "utf8" });
    assert.equal(result.status, entry.resolves ? 0 : 2, label + result.stderr);
    if (entry.resolves) { assert.equal(await realpath(result.stdout.trim()), await realpath(join(root, "package/schemas/v1.schema.json")), label); }
    else { assert.equal(result.stdout.trim(), "ERR_PACKAGE_PATH_NOT_EXPORTED", label); }
    if (entry.accepted) {
      assert.equal(comparePackageArtifactInventory(baseline, await inspect(root), fingerprint).classification, "none", label);
    } else {
      await assert.rejects(inspect(root), /unsupported conditional or array availability/u, label);
    }
  }
});
