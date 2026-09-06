import { evidence, assertSchema, fingerprint, inventory, packagePolicy, policy, schema, json, fixture, inspect, fixate } from "./fixtures/public-api-artifact-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { comparePackageArtifactInventory } from "../dist/capabilities/public-api-compatibility/application/policies/compare-package-artifact-inventory.js";
import { readArtifactBaseline, mapReleasedArtifactBaseline } from "../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-artifact-baseline.js";
import { ArtifactPublicApiEvidence } from "../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/artifact-public-api-evidence.js";
import { FilesystemPublicApiRepository } from "../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-public-api-repository.js";
import { analyzePublicApiCompatibility } from "../dist/capabilities/public-api-compatibility/application/use-cases/analyze-public-api-compatibility.js";
import { preflightPublicApiPromotions } from "../dist/capabilities/public-api-compatibility/application/use-cases/preflight-public-api-promotions.js";
import { promotePublicApiBaselines } from "../dist/capabilities/public-api-compatibility/application/use-cases/promote-public-api-baselines.js";

function dependencies(current, accepted) {
  const artifacts = new ArtifactPublicApiEvidence(new FilesystemPublicApiRepository(assertSchema, evidence), [current], evidence);
  return { repository: artifacts, extractor: artifacts, fingerprint,
    acceptedDecisionEvidence: { readAcceptedDecisionEvidence() { return Promise.resolve(accepted); } } };
}

test("unchanged schema passes; a new schema is additive; $id, const and constraints are breaking", async (t) => {
  const root = await fixture(t);
  const baseline = await inspect(root);
  assert.equal(baseline.status, "release-candidate");
  assert.deepEqual(baseline.jsonSchemas[0].discriminators, { schemaVersion: { const: 1 } });
  assert.equal(comparePackageArtifactInventory(baseline, await inspect(root), fingerprint).classification, "none");
  await json(root, "package/schemas/v2.schema.json", { ...schema, $id: "https://fixture.test/record/v2" });
  assert.equal(comparePackageArtifactInventory(baseline, await inspect(root), fingerprint).classification, "additive");
  await rm(join(root, "package/schemas/v2.schema.json"));
  const changes = [
    { ...schema, $id: "https://fixture.test/changed/v1" },
    { ...schema, properties: { ...schema.properties, schemaVersion: { const: 2 } } },
    { ...schema, properties: { ...schema.properties, value: { type: "string", minLength: 3 } } },
  ];
  const fingerprints = [];
  for (const value of changes) {
    await json(root, "package/schemas/v1.schema.json", value);
    const change = comparePackageArtifactInventory(baseline, await inspect(root), fingerprint);
    assert.equal(change.classification, "breaking");
    fingerprints.push(change.fingerprint);
  }
  assert.equal(new Set(fingerprints).size, changes.length);
});

test("reuses the closed local schema inspector, including cross-package references and nonstandard JSON names", async (t) => {
  const root = await fixture(t);
  const referencing = { ...schema, properties: { ...schema.properties, value: { $ref: "https://fixture.test/value/v1" } } };
  await json(root, "package/schemas/v1.schema.json", referencing);
  await assert.rejects(inspect(root), (error) => error.problem?.code === "JSON_SCHEMA_REFERENCE_NOT_LOCAL");
  const support = { ...packagePolicy, packageName: "@fixture/support", packageRoot: "support", manifestPath: "support/package.json" };
  await json(root, "support/package.json", { name: support.packageName, version: "1.0.0", exports: { "./schemas/*": "./schemas/*" } });
  await json(root, "support/schemas/value.json", { $schema: schema.$schema, $id: "https://fixture.test/value/v1", type: "string" });
  const all = await inventory.inspect(root, [packagePolicy, support]);
  assert.equal(all[1].jsonSchemas[0].path, "schemas/value.json");
  await json(root, "support/schemas/duplicate.json", { $schema: schema.$schema, $id: "https://fixture.test/value/v1", type: "string" });
  await assert.rejects(inventory.inspect(root, [packagePolicy, support]), (error) => error.problem?.code === "JSON_SCHEMA_ID_DUPLICATE");
});

test("inspects only wildcard roots, rejects links, unsafe and conditional wildcard targets", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "package/node_modules"));
  await symlink(root, join(root, "package/node_modules/irrelevant"), "dir");
  assert.equal((await inspect(root)).wildcardExports[0].members.length, 1);
  await symlink(join(root, "package/schemas/v1.schema.json"), join(root, "package/schemas/link.schema.json"));
  await assert.rejects(inspect(root), /[Ss]ymbolic|Special file/u);
  await rm(join(root, "package/schemas/link.schema.json"));
  for (const target of ["./../outside/*", "./schemas/**", "./schemas/%2e%2e/*", { import: "./schemas/*", default: "./other/*" }]) {
    await json(root, "package/package.json", { name: packagePolicy.packageName, version: "1.2.0", exports: { "./schemas/*": target } });
    await assert.rejects(inspect(root));
  }
});

test("normal checks require explicit fixation and do not create, replace or redirect a baseline", async (t) => {
  const root = await fixture(t);
  const current = await inspect(root);
  await assert.rejects(analyzePublicApiCompatibility({ consumerRoot: root, policy }, dependencies(current)),
    (error) => error.problem?.code === "PUBLIC_API_ARTIFACT_BASELINE_MISSING");
  assert.equal(await readArtifactBaseline(root, packagePolicy, evidence), undefined);
  await assert.rejects(promotePublicApiBaselines({ consumerRoot: root, policy }, dependencies(current)),
    (error) => error.problem?.code === "PUBLIC_API_ARTIFACT_BASELINE_MISSING");
  await fixate(root, current);
  const path = join(root, "architecture/public-api/library.artifacts.json");
  const bytes = await readFile(path);
  assert.deepEqual(await analyzePublicApiCompatibility({ consumerRoot: root, policy }, dependencies(current)), []);
  assert.deepEqual(await readFile(path), bytes);
  await assert.rejects(fixate(root, current), (error) => error.problem?.code === "PUBLIC_API_BASELINE_BOOTSTRAP_CONFLICT");
  await assert.rejects(readArtifactBaseline(root, { ...packagePolicy, releasedBaselinePath: "architecture/public-api/reset.json" }, evidence), /stable.*anchor/u);
  await rm(path);
  await writeFile(join(root, "foreign.json"), bytes);
  await symlink(join(root, "foreign.json"), path);
  await assert.rejects(readArtifactBaseline(root, packagePolicy, evidence), (error) => error.problem?.code === "PUBLIC_API_EVIDENCE_SYMLINK_PROHIBITED");
  assert.deepEqual(await readFile(join(root, "foreign.json")), bytes);
});

test("closed baseline rejects malformed coverage, identities, duplicate keys and false bootstrap support", async (t) => {
  const root = await fixture(t, "0.0.0");
  const initial = await inspect(root);
  assert.equal(initial.status, "initial-unreleased");
  for (const mutate of [
    (x) => ({ ...x, status: "supported" }), (x) => ({ ...x, extra: true }),
    (x) => ({ ...x, packageName: "@fixture/other" }), (x) => ({ ...x, jsonSchemas: [] }),
    (x) => ({ ...x, wildcardExports: [...x.wildcardExports, ...x.wildcardExports] }),
    (x) => ({ ...x, jsonSchemas: [{ ...x.jsonSchemas[0], path: "../outside" }] }),
  ]) { assert.throws(() => mapReleasedArtifactBaseline(mutate(initial), packagePolicy)); }
  const path = "architecture/public-api/library.artifacts.json";
  await writeFile(join(root, path), JSON.stringify(initial).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'));
  await assert.rejects(readArtifactBaseline(root, packagePolicy, evidence), /duplicate/iu);
});

test("unreleased initialization is explicit; promotion requires release version and replays", async (t) => {
  const root = await fixture(t, "0.0.0");
  const input = { consumerRoot: root, policy };
  await assert.rejects(promotePublicApiBaselines(input, dependencies(await inspect(root))),
    (error) => error.problem?.code === "PUBLIC_API_ARTIFACT_BASELINE_MISSING");
  // Storage fixture; real initial preparation below uses a retained packed archive.
  await json(root, "architecture/public-api/library.artifacts.json", await inspect(root));
  assert.equal((await readArtifactBaseline(root, packagePolicy, evidence)).status, "initial-unreleased");
  assert.deepEqual(await promotePublicApiBaselines(input, dependencies(await inspect(root))), []);
  await json(root, "package/schemas/v2.schema.json", { ...schema, $id: "https://fixture.test/record/v2" });
  await assert.rejects(promotePublicApiBaselines(input, dependencies(await inspect(root))),
    (error) => error.problem?.code === "PUBLIC_API_BASELINE_PROMOTION_RELEASE_DRIFT");
  await json(root, "package/package.json", { name: packagePolicy.packageName, version: "0.1.0", exports: { "./schemas/*": "./schemas/*" } });
  await promotePublicApiBaselines(input, dependencies(await inspect(root)));
  assert.equal((await readArtifactBaseline(root, packagePolicy, evidence)).status, "release-candidate");
});

test("removed last wildcard stays governed and unapproved schema drift cannot promote", async (t) => {
  const root = await fixture(t);
  const before = await inspect(root);
  await fixate(root, before);
  await json(root, "package/package.json", { name: packagePolicy.packageName, version: "2.0.0", exports: { "./package.json": "./package.json" } });
  const changedPolicy = { ...packagePolicy, nonTypeExports: [{ exportPath: "./package.json", kind: "data" }] };
  const after = await inspect(root, [changedPolicy]);
  const input = { consumerRoot: root, policy: { ...policy, packages: [changedPolicy] } };
  assert.equal(comparePackageArtifactInventory(before, after, fingerprint).classification, "breaking");
  await assert.rejects(promotePublicApiBaselines(input, dependencies(after)),
    (error) => error.problem?.code === "PUBLIC_API_BASELINE_PROMOTION_UNAPPROVED_BREAK");
  assert.deepEqual(await readArtifactBaseline(root, packagePolicy, evidence), { ...before, status: "supported" });
});

test("preflight validates all surfaces before writing and permits interrupted promotion replay", async (t) => {
  const root = await fixture(t);
  await fixate(root, await inspect(root));
  const before = await readFile(join(root, "architecture/public-api/library.artifacts.json"));
  await json(root, "package/package.json", { name: packagePolicy.packageName, version: "1.3.0", exports: { "./schemas/*": "./schemas/*" } });
  const valid = dependencies(await inspect(root));
  const invalid = { ...valid, extractor: { extract() { throw new Error("unreviewed second surface"); } } };
  await assert.rejects(preflightPublicApiPromotions({ consumerRoot: root, policy }, [valid, invalid]), /unreviewed second/u);
  assert.deepEqual(await readFile(join(root, "architecture/public-api/library.artifacts.json")), before);
  await preflightPublicApiPromotions({ consumerRoot: root, policy }, [valid]);
  assert.deepEqual(await preflightPublicApiPromotions({ consumerRoot: root, policy }, [valid]), []);
});

test("packages without wildcard exports keep their existing behavior and need no sidecar", async (t) => {
  const root = await fixture(t);
  await json(root, "package/package.json", { name: packagePolicy.packageName, version: "1.2.0", exports: { "./package.json": "./package.json" } });
  const noWildcards = { ...packagePolicy, nonTypeExports: [{ exportPath: "./package.json", kind: "data" }] };
  const current = await inspect(root, [noWildcards]);
  assert.deepEqual(await analyzePublicApiCompatibility({ consumerRoot: root, policy: { ...policy, packages: [noWildcards] } }, dependencies(current)), []);
  assert.equal(await readArtifactBaseline(root, noWildcards, evidence), undefined);
});

test("artifact breaks use exact fingerprint plus accepted decision and sufficient version", async (t) => {
  const root = await fixture(t);
  const baseline = await inspect(root);
  await fixate(root, baseline);
  await json(root, "package/schemas/v1.schema.json", { ...schema, properties: { ...schema.properties, value: { type: "string", minLength: 3 } } });
  await json(root, "package/package.json", { name: packagePolicy.packageName, version: "2.0.0", exports: { "./schemas/*": "./schemas/*" } });
  const current = await inspect(root);
  const change = comparePackageArtifactInventory(baseline, current, fingerprint);
  const approvedPolicy = { ...policy, governanceConfigPath: "architecture/foundation/governance.yaml",
    packages: [{ ...packagePolicy, approvedBreakingChanges: [{ fingerprint: change.fingerprint, decisionId: "ADR-0001" }] }] };
  const input = { consumerRoot: root, policy: approvedPolicy };
  await assert.rejects(promotePublicApiBaselines(input, dependencies(current, { acceptedDecisionIds: [], acceptedDecisionPaths: [] })),
    (error) => error.problem?.code === "PUBLIC_API_BASELINE_PROMOTION_DECISION_NOT_ACCEPTED");
  const acceptedEvidence = { acceptedDecisionIds: ["ADR-0001"], acceptedDecisionPaths: ["docs/decisions/0001-break.md"] };
  await promotePublicApiBaselines(input, dependencies(current, acceptedEvidence));
  assert.equal((await readArtifactBaseline(root, packagePolicy, evidence)).packageVersion, "2.0.0");
  // The same approval does not cover another constraint change.
  await json(root, "package/schemas/v1.schema.json", { ...schema, properties: { ...schema.properties, value: { type: "string", minLength: 4 } } });
  assert.notEqual(comparePackageArtifactInventory(baseline, await inspect(root), fingerprint).fingerprint, change.fingerprint);
});

test("wildcard JSON data and instance $schema hints are not schema definitions", async (t) => {
  const root = await fixture(t);
  await json(root, "package/schemas/data.json", [1, 2]);
  await json(root, "package/schemas/config.json", { $schema: "https://json.schemastore.org/tsconfig", compilerOptions: {} });
  const current = await inspect(root);
  assert.equal(current.wildcardExports[0].members.length, 3);
  assert.equal(current.jsonSchemas.length, 1);
});

test("inventory object ordering does not change compatibility but schema byte ordering does", async (t) => {
  const root = await fixture(t);
  const definition = { ...schema, properties: { ...schema.properties,
    kind: { const: { name: "record", version: 1 } } } };
  await json(root, "package/schemas/v1.schema.json", definition);
  const current = await inspect(root);
  const baseline = structuredClone(current);
  baseline.jsonSchemas[0].discriminators = {
    schemaVersion: { const: 1 }, kind: { const: { version: 1, name: "record" } }
  };
  await fixate(root, baseline);
  const released = await readArtifactBaseline(root, packagePolicy, evidence);
  assert.deepEqual(released.jsonSchemas, current.jsonSchemas);
  assert.equal(comparePackageArtifactInventory(released, current, fingerprint).classification, "none");
  assert.deepEqual(await analyzePublicApiCompatibility({ consumerRoot: root, policy }, dependencies(current)), []);
  await json(root, "package/schemas/v1.schema.json", { ...definition,
    properties: { ...definition.properties, kind: { const: { version: 1, name: "record" } } } });
  assert.equal(comparePackageArtifactInventory(released, await inspect(root), fingerprint).classification, "breaking");
});

test("inventory rejects a new wildcard member or changed manifest after schema inspection", async (t) => {
  const { FilesystemPackageArtifactInventory } = await import("../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-package-artifact-inventory.js");
  const { AjvJsonSchemaReleaseInspector } = await import("../dist/capabilities/contract-json-schema-releases/module.js");
  for (const mutate of [
    (root) => json(root, "package/schemas/v2.schema.json", { ...schema, $id: "https://fixture.test/record/v2" }),
    (root) => json(root, "package/package.json", { name: packagePolicy.packageName, version: "1.3.0", exports: { "./schemas/*": "./schemas/*" } }),
  ]) {
    const root = await fixture(t);
    const racing = new FilesystemPackageArtifactInventory({ async inspect(input) {
      const result = await new AjvJsonSchemaReleaseInspector(evidence.files).inspect(input);
      await mutate(root);
      return result;
    } }, evidence);
    await assert.rejects(racing.inspect(root, [packagePolicy]), /changed/iu);
  }
});

test("historical namespace artifacts cannot authorize supported compatibility or release promotion", async (t) => {
  const root = await fixture(t, "0.0.0");
  const current = await inspect(root);
  await json(root, "architecture/public-api/library.artifacts.json", { ...current, status: "historical-bootstrap" });
  await assert.rejects(analyzePublicApiCompatibility({ consumerRoot: root, policy }, dependencies(current)), /historical/iu);
  await assert.rejects(promotePublicApiBaselines({ consumerRoot: root, policy }, dependencies(current)), /historical/iu);
});

test("artifact promotion preserves a baseline swapped after its release comparison", async (t) => {
  const root = await fixture(t);
  await fixate(root, await inspect(root));
  await json(root, "package/package.json", { name: packagePolicy.packageName, version: "1.3.0", exports: { "./schemas/*": "./schemas/*" } });
  const current = await inspect(root);
  const normal = dependencies(current);
  const swapped = { ...current, packageVersion: "9.0.0", status: "supported" };
  const racing = { ...normal, extractor: { async extract(...args) {
    await json(root, "architecture/public-api/library.artifacts.json", swapped);
    return normal.extractor.extract(...args);
  } } };
  await assert.rejects(preflightPublicApiPromotions({ consumerRoot: root, policy }, [racing]), /changed|stale/iu);
  assert.deepEqual(await readArtifactBaseline(root, packagePolicy, evidence), swapped);
});

test("wildcard inventory rejects portable path aliases and device names", async (t) => {
  const root = await fixture(t);
  // Compatibility-distinct bytes coexist even on case-insensitive filesystems.
  await json(root, "package/schemas/V１.schema.json", { ...schema, $id: "https://fixture.test/alias/v1" });
  await assert.rejects(inspect(root), /alias|colli|portable/iu);
  await rm(join(root, "package/schemas/V１.schema.json"));
  await writeFile(join(root, "package/schemas/NUL.json"), "{}");
  await assert.rejects(inspect(root), /portable/iu);
});

test("inventory bounds bytes and cancellation before returning artifact evidence", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "package/schemas/oversized.bin"), Buffer.alloc(32 * 1024 * 1024 + 1));
  await assert.rejects(inspect(root));
  await rm(join(root, "package/schemas/oversized.bin"));
  await assert.rejects(inventory.inspect(root, [packagePolicy], AbortSignal.abort()));
});

test("independent surface versions finish an interrupted two-surface promotion", async (t) => {
  const firstRoot = await fixture(t);
  const secondRoot = await fixture(t);
  for (const root of [firstRoot, secondRoot]) {
    await fixate(root, await inspect(root));
    await json(root, "package/package.json", { name: packagePolicy.packageName, version: "1.3.0", exports: { "./schemas/*": "./schemas/*" } });
  }
  const first = dependencies(await inspect(firstRoot));
  const second = dependencies(await inspect(secondRoot));
  const secondRepository = {
    readReleasedBaseline: (_root, ...args) => second.repository.readReleasedBaseline(secondRoot, ...args),
    readReleaseEvidence: (_root, ...args) => second.repository.readReleaseEvidence(secondRoot, ...args),
    writeReleasedBaseline: (_root, ...args) => second.repository.writeReleasedBaseline(secondRoot, ...args),
  };
  const secondSurface = { ...second, repository: secondRepository };
  const interrupted = { ...secondSurface, repository: { ...secondRepository,
    writeReleasedBaseline() { throw new Error("simulated interruption after first surface"); } } };
  const input = { consumerRoot: firstRoot, policy };
  await assert.rejects(preflightPublicApiPromotions(input, [first, interrupted]), /interruption/u);
  assert.equal((await readArtifactBaseline(firstRoot, packagePolicy, evidence)).packageVersion, "1.3.0");
  assert.equal((await readArtifactBaseline(secondRoot, packagePolicy, evidence)).packageVersion, "1.2.0");
  const firstBytes = await readFile(join(firstRoot, "architecture/public-api/library.artifacts.json"));
  await preflightPublicApiPromotions(input, [first, secondSurface]);
  assert.deepEqual(await readFile(join(firstRoot, "architecture/public-api/library.artifacts.json")), firstBytes);
  assert.equal((await readArtifactBaseline(secondRoot, packagePolicy, evidence)).packageVersion, "1.3.0");
});


test("oversized artifact record fails before replacing readable evidence", async (t) => {
  const root = await fixture(t);
  await fixate(root, await inspect(root));
  const path = join(root, "architecture/public-api/library.artifacts.json");
  const before = await readFile(path);
  const current = await inspect(root);
  const oversized = { ...current, jsonSchemas: [], wildcardExports: [{
    exportPath: "./schemas/*", targetPattern: "schemas/*",
    members: Array.from({ length: 12000 }, (_, i) => `schemas/${"a".repeat(400)}/${String(i).padStart(5, "0")}.bin`),
  }] };
  await assert.rejects(preflightPublicApiPromotions({ consumerRoot: root, policy }, [dependencies(oversized)]), /4 MiB/u);
  assert.deepEqual(await readFile(path), before);
});

test("supported same-version schema mutation cannot promote even with a Changeset", async (t) => {
  const root = await fixture(t);
  await fixate(root, await inspect(root));
  const path = join(root, "architecture/public-api/library.artifacts.json");
  const before = await readFile(path);
  await writeFile(join(root, ".changeset/change.md"), '---\n"@fixture/library": major\n---\n\nSchema change.\n');
  await json(root, "package/schemas/v1.schema.json", { ...schema, minProperties: 2 });
  await assert.rejects(promotePublicApiBaselines({ consumerRoot: root, policy }, dependencies(await inspect(root))),
    (error) => error.problem?.code === "PUBLIC_API_BASELINE_PROMOTION_RELEASE_DRIFT");
  assert.deepEqual(await readFile(path), before);
});

test("schema compilation uses captured bytes under A-B-A and returns the stable valid byte digest", async (t) => {
  const { FilesystemPackageArtifactInventory } = await import("../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-package-artifact-inventory.js");
  const { AjvJsonSchemaReleaseInspector } = await import("../dist/capabilities/contract-json-schema-releases/module.js");
  const root = await fixture(t);
  const path = join(root, "package/schemas/v1.schema.json");
  const validBytes = await readFile(path);
  const stable = await inspect(root);
  assert.equal(stable.jsonSchemas[0].digest, `sha256:${fingerprint.sha256(validBytes.toString("utf8"))}`);
  await json(root, "package/schemas/v1.schema.json", { ...schema, unknownStrictKeyword: true });
  const invalidBytes = await readFile(path);
  await assert.rejects(inspect(root), (error) => error.problem?.code === "JSON_SCHEMA_COMPILE_FAILED");
  let capturedReads = 0;
  const compiler = new AjvJsonSchemaReleaseInspector({ read() { throw new Error("Captured inspection must not read disk"); } });
  const racing = new FilesystemPackageArtifactInventory({ async inspect(input) {
    await writeFile(path, validBytes);
    try {
      const captured = await input.evidenceReader(input.schemaPaths[0]);
      capturedReads++;
      assert.deepEqual(captured, invalidBytes);
      // Mutating a returned copy cannot alter the bytes held by inventory or later reader calls.
      captured.fill(0);
      assert.deepEqual(await input.evidenceReader(input.schemaPaths[0]), invalidBytes);
      return await compiler.inspect(input);
    } finally { await writeFile(path, invalidBytes); }
  } }, evidence);
  await assert.rejects(racing.inspect(root, [packagePolicy]), (error) => error.problem?.code === "JSON_SCHEMA_COMPILE_FAILED");
  assert.equal(capturedReads, 1);
  assert.deepEqual(await readFile(path), invalidBytes);
  await writeFile(path, validBytes);
  assert.deepEqual(await inspect(root), stable);
});

test("captured schema inspection retains final byte, symlink and per-schema bounds", async (t) => {
  const { FilesystemPackageArtifactInventory } = await import("../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-package-artifact-inventory.js");
  const { AjvJsonSchemaReleaseInspector } = await import("../dist/capabilities/contract-json-schema-releases/module.js");
  for (const change of ["bytes", "symlink", "oversized"]) {
    const root = await fixture(t);
    const path = join(root, "package/schemas/v1.schema.json");
    if (change === "oversized") {
      await json(root, "package/schemas/v1.schema.json", { ...schema, description: "a".repeat(4 * 1024 * 1024) });
      await assert.rejects(inspect(root), (error) => error.problem?.code === "JSON_SCHEMA_FILE_INVALID");
      continue;
    }
    const racing = new FilesystemPackageArtifactInventory({ async inspect(input) {
      const result = await new AjvJsonSchemaReleaseInspector(evidence.files).inspect(input);
      if (change === "bytes") { await json(root, "package/schemas/v1.schema.json", { ...schema, minProperties: 1 }); }
      else {
        const bytes = await readFile(path);
        await writeFile(join(root, "outside.json"), bytes);
        await rm(path);
        await symlink(join(root, "outside.json"), path);
      }
      return result;
    } }, evidence);
    await assert.rejects(racing.inspect(root, [packagePolicy]), /changed|Special file|[Ss]ymbolic/u);
  }
});

test("per-inspection captured evidence overrides path and constructor readers without missing-byte fallback", async (t) => {
  const { AjvJsonSchemaReleaseInspector } = await import("../dist/capabilities/contract-json-schema-releases/module.js");
  const root = await fixture(t);
    const path = "package/schemas/v1.schema.json";
    const captured = await readFile(join(root, path));
    const input = { consumerRoot: root, schemaPaths: [path], fixtures: [], requireMixedExpectations: false };
    const stable = await new AjvJsonSchemaReleaseInspector(evidence.files).inspect(input);
    const inspector = new AjvJsonSchemaReleaseInspector(
      { read() { throw new Error("Unexpected filesystem fallback"); } },
      async () => { throw new Error("Unexpected constructor-reader fallback"); },
    );
    await json(root, path, { ...JSON.parse(captured), unknownStrictKeyword: true });
    assert.deepEqual(await inspector.inspect({ ...input, evidenceReader: async () => captured }), stable);
    for (const [bytes, code] of [
      [undefined, "JSON_SCHEMA_FILE_UNAVAILABLE"],
      [Buffer.alloc(4 * 1024 * 1024 + 1), "JSON_SCHEMA_FILE_INVALID"],
      [await readFile(join(root, path)), "JSON_SCHEMA_COMPILE_FAILED"],
    ]) {
      await assert.rejects(inspector.inspect({ ...input, evidenceReader: async () => bytes }),
        (error) => error.problem?.code === code);
    }
    await assert.rejects(inspector.inspect({ ...input, schemaPaths: ["../outside.json"], evidenceReader: async () => captured }));
    await assert.rejects(inspector.inspect({ ...input, signal: AbortSignal.abort(), evidenceReader: async () => captured }));
});
