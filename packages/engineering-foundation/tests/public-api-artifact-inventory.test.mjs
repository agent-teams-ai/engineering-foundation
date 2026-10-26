import * as registeredCases1 from "./public-api-artifact-release-cases.ts";
void registeredCases1;
import {
  evidence,
  assertSchema,
  fingerprint,
  inventory,
  packagePolicy,
  policy,
  schema,
  json,
  fixture,
  inspect,
  fixate,
} from "./fixtures/public-api-artifact-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  comparePackageArtifactInventory,
  wildcardExpression,
} from "../dist/capabilities/public-api-compatibility/application/policies/compare-package-artifact-inventory.js";
import {
  readArtifactBaseline,
  mapReleasedArtifactBaseline,
} from "../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-artifact-baseline.js";
import { ArtifactPublicApiEvidence } from "../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/artifact-public-api-evidence.js";
import { FilesystemPublicApiRepository } from "../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-public-api-repository.js";
import { analyzePublicApiCompatibility } from "../dist/capabilities/public-api-compatibility/application/use-cases/analyze-public-api-compatibility.js";
import { preflightPublicApiPromotions } from "../dist/capabilities/public-api-compatibility/application/use-cases/preflight-public-api-promotions.js";
import { promotePublicApiBaselines } from "../dist/capabilities/public-api-compatibility/application/use-cases/promote-public-api-baselines.js";

function dependencies(current, accepted) {
  const artifacts = new ArtifactPublicApiEvidence(
    new FilesystemPublicApiRepository(assertSchema, evidence),
    [current],
    evidence,
  );
  return {
    repository: artifacts,
    extractor: artifacts,
    fingerprint,
    acceptedDecisionEvidence: {
      readAcceptedDecisionEvidence() {
        return Promise.resolve(accepted);
      },
    },
  };
}

test("wildcard matching validates both sentinel halves and requires exactly one star", () => {
  for (const [pattern, member] of [
    ["*", "artifact"],
    ["schemas/*.schema.json", "schemas/v1.schema.json"],
    ["prefix*", "prefix-value"],
    ["*suffix", "value-suffix"],
    ["schemas/pre[1]+(x)*.json", "schemas/pre[1]+(x)value.json"],
  ]) {
    assert.ok(wildcardExpression(pattern).test(member), pattern);
  }
  assert.equal(wildcardExpression("schemas/*.json").test("schemas/.json"), false);
  assert.equal(wildcardExpression("schemas/*.json").test("schemas/v1Xjson"), false);
  assert.equal(wildcardExpression("schemas/*.json").test("other/schemas/v1.json"), false);
  for (const pattern of [
    "schemas/file.json",
    "schemas/**",
    "*/*",
    "pre*suf*fix",
    "../schemas/*",
    "schemas///*",
    "schemas/./*",
    "node_modules/*",
    "schemas/../*",
    "schemas/CON.*",
    "*/NUL.json",
    "*/node_modules/file",
    "schemas/*.",
    "schemas/\\*",
    "schemas/%2e*",
    "schemas/*#",
    "schemas/*?",
    "schemas/*\n",
  ]) {
    assert.throws(() => wildcardExpression(pattern), /Artifact/u, pattern);
  }
});

test("unchanged schema passes; a new schema is additive; $id, const and constraints are breaking", async (t) => {
  const root = await fixture(t);
  const baseline = await inspect(root);
  assert.equal(baseline.status, "release-candidate");
  assert.deepEqual(baseline.jsonSchemas[0].discriminators, { schemaVersion: { const: 1 } });
  assert.equal(
    (await comparePackageArtifactInventory(baseline, await inspect(root), fingerprint))
      .classification,
    "none",
  );
  await json(root, "package/schemas/v2.schema.json", {
    ...schema,
    $id: "https://fixture.test/record/v2",
  });
  assert.equal(
    (await comparePackageArtifactInventory(baseline, await inspect(root), fingerprint))
      .classification,
    "additive",
  );
  await rm(join(root, "package/schemas/v2.schema.json"));
  const changes = [
    { ...schema, $id: "https://fixture.test/changed/v1" },
    { ...schema, properties: { ...schema.properties, schemaVersion: { const: 2 } } },
    { ...schema, properties: { ...schema.properties, value: { type: "string", minLength: 3 } } },
  ];
  const fingerprints = [];
  for (const value of changes) {
    await json(root, "package/schemas/v1.schema.json", value);
    const change = await comparePackageArtifactInventory(
      baseline,
      await inspect(root),
      fingerprint,
    );
    assert.equal(change.classification, "breaking");
    fingerprints.push(change.fingerprint);
  }
  assert.equal(new Set(fingerprints).size, changes.length);
});

test("reuses the closed local schema inspector, including cross-package references and nonstandard JSON names", async (t) => {
  const root = await fixture(t);
  const referencing = {
    ...schema,
    properties: { ...schema.properties, value: { $ref: "https://fixture.test/value/v1" } },
  };
  await json(root, "package/schemas/v1.schema.json", referencing);
  await assert.rejects(
    inspect(root),
    (error) => error.problem?.code === "JSON_SCHEMA_REFERENCE_NOT_LOCAL",
  );
  const support = {
    ...packagePolicy,
    packageName: "@fixture/support",
    packageRoot: "support",
    manifestPath: "support/package.json",
  };
  await json(root, "support/package.json", {
    name: support.packageName,
    version: "1.0.0",
    exports: { "./schemas/*": "./schemas/*" },
  });
  await json(root, "support/schemas/value.json", {
    $schema: schema.$schema,
    $id: "https://fixture.test/value/v1",
    type: "string",
  });
  const all = await inventory.inspect(root, [packagePolicy, support]);
  assert.equal(all[1].jsonSchemas[0].path, "schemas/value.json");
  await json(root, "support/schemas/duplicate.json", {
    $schema: schema.$schema,
    $id: "https://fixture.test/value/v1",
    type: "string",
  });
  await assert.rejects(
    inventory.inspect(root, [packagePolicy, support]),
    (error) => error.problem?.code === "JSON_SCHEMA_ID_DUPLICATE",
  );
});

test("inspects only wildcard roots, rejects links, unsafe and conditional wildcard targets", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "package/node_modules"));
  await symlink(root, join(root, "package/node_modules/irrelevant"), "dir");
  assert.equal((await inspect(root)).wildcardExports[0].members.length, 1);
  await symlink(
    join(root, "package/schemas/v1.schema.json"),
    join(root, "package/schemas/link.schema.json"),
  );
  await assert.rejects(inspect(root), /[Ss]ymbolic|Special file/u);
  await rm(join(root, "package/schemas/link.schema.json"));
  for (const target of [
    "./../outside/*",
    "./schemas/**",
    "./schemas/%2e%2e/*",
    { import: "./schemas/*", default: "./other/*" },
  ]) {
    await json(root, "package/package.json", {
      name: packagePolicy.packageName,
      version: "1.2.0",
      exports: { "./schemas/*": target },
    });
    await assert.rejects(inspect(root));
  }
});

test("normal checks require explicit fixation and do not create, replace or redirect a baseline", async (t) => {
  const root = await fixture(t);
  const current = await inspect(root);
  await assert.rejects(
    analyzePublicApiCompatibility({ consumerRoot: root, policy }, dependencies(current)),
    (error) => error.problem?.code === "PUBLIC_API_ARTIFACT_BASELINE_MISSING",
  );
  assert.equal(await readArtifactBaseline(root, packagePolicy, evidence), undefined);
  await assert.rejects(
    promotePublicApiBaselines({ consumerRoot: root, policy }, dependencies(current)),
    (error) => error.problem?.code === "PUBLIC_API_ARTIFACT_BASELINE_MISSING",
  );
  await fixate(root, current);
  const path = join(root, "architecture/public-api/library.artifacts.json");
  const bytes = await readFile(path);
  assert.deepEqual(
    await analyzePublicApiCompatibility({ consumerRoot: root, policy }, dependencies(current)),
    [],
  );
  assert.deepEqual(await readFile(path), bytes);
  await assert.rejects(
    fixate(root, current),
    (error) => error.problem?.code === "PUBLIC_API_BASELINE_BOOTSTRAP_CONFLICT",
  );
  await assert.rejects(
    readArtifactBaseline(
      root,
      { ...packagePolicy, releasedBaselinePath: "architecture/public-api/reset.json" },
      evidence,
    ),
    /stable.*anchor/u,
  );
  await rm(path);
  await writeFile(join(root, "foreign.json"), bytes);
  await symlink(join(root, "foreign.json"), path);
  await assert.rejects(
    readArtifactBaseline(root, packagePolicy, evidence),
    (error) => error.problem?.code === "PUBLIC_API_EVIDENCE_SYMLINK_PROHIBITED",
  );
  assert.deepEqual(await readFile(join(root, "foreign.json")), bytes);
});

test("closed baseline rejects malformed coverage, identities, duplicate keys and false bootstrap support", async (t) => {
  const root = await fixture(t, "0.0.0");
  const initial = await inspect(root);
  assert.equal(initial.status, "initial-unreleased");
  for (const mutate of [
    (x) => ({ ...x, status: "supported" }),
    (x) => ({ ...x, extra: true }),
    (x) => ({ ...x, packageName: "@fixture/other" }),
    (x) => ({ ...x, jsonSchemas: [] }),
    (x) => ({ ...x, wildcardExports: [...x.wildcardExports, ...x.wildcardExports] }),
    (x) => ({ ...x, jsonSchemas: [{ ...x.jsonSchemas[0], path: "../outside" }] }),
  ]) {
    assert.throws(() => mapReleasedArtifactBaseline(mutate(initial), packagePolicy));
  }
  const path = "architecture/public-api/library.artifacts.json";
  await writeFile(
    join(root, path),
    JSON.stringify(initial).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
  );
  await assert.rejects(readArtifactBaseline(root, packagePolicy, evidence), /duplicate/iu);
});

test("unreleased initialization is explicit; promotion requires release version and replays", async (t) => {
  const root = await fixture(t, "0.0.0");
  const input = { consumerRoot: root, policy };
  await assert.rejects(
    promotePublicApiBaselines(input, dependencies(await inspect(root))),
    (error) => error.problem?.code === "PUBLIC_API_ARTIFACT_BASELINE_MISSING",
  );
  // Storage fixture; real initial preparation below uses a retained packed archive.
  await json(root, "architecture/public-api/library.artifacts.json", await inspect(root));
  assert.equal(
    (await readArtifactBaseline(root, packagePolicy, evidence)).status,
    "initial-unreleased",
  );
  assert.deepEqual(await promotePublicApiBaselines(input, dependencies(await inspect(root))), []);
  await json(root, "package/schemas/v2.schema.json", {
    ...schema,
    $id: "https://fixture.test/record/v2",
  });
  await assert.rejects(
    promotePublicApiBaselines(input, dependencies(await inspect(root))),
    (error) => error.problem?.code === "PUBLIC_API_BASELINE_PROMOTION_RELEASE_DRIFT",
  );
  await json(root, "package/package.json", {
    name: packagePolicy.packageName,
    version: "0.1.0",
    exports: { "./schemas/*": "./schemas/*" },
  });
  await promotePublicApiBaselines(input, dependencies(await inspect(root)));
  assert.equal(
    (await readArtifactBaseline(root, packagePolicy, evidence)).status,
    "release-candidate",
  );
});

test("removed last wildcard stays governed and unapproved schema drift cannot promote", async (t) => {
  const root = await fixture(t);
  const before = await inspect(root);
  await fixate(root, before);
  await json(root, "package/package.json", {
    name: packagePolicy.packageName,
    version: "2.0.0",
    exports: { "./package.json": "./package.json" },
  });
  const changedPolicy = {
    ...packagePolicy,
    nonTypeExports: [{ exportPath: "./package.json", kind: "data" }],
  };
  const after = await inspect(root, [changedPolicy]);
  const input = { consumerRoot: root, policy: { ...policy, packages: [changedPolicy] } };
  assert.equal(
    (await comparePackageArtifactInventory(before, after, fingerprint)).classification,
    "breaking",
  );
  await assert.rejects(
    promotePublicApiBaselines(input, dependencies(after)),
    (error) => error.problem?.code === "PUBLIC_API_BASELINE_PROMOTION_UNAPPROVED_BREAK",
  );
  assert.deepEqual(await readArtifactBaseline(root, packagePolicy, evidence), {
    ...before,
    status: "supported",
  });
});

test("preflight validates all surfaces before writing and permits interrupted promotion replay", async (t) => {
  const root = await fixture(t);
  await fixate(root, await inspect(root));
  const before = await readFile(join(root, "architecture/public-api/library.artifacts.json"));
  await json(root, "package/package.json", {
    name: packagePolicy.packageName,
    version: "1.3.0",
    exports: { "./schemas/*": "./schemas/*" },
  });
  const valid = dependencies(await inspect(root));
  const legacyRepository = {
    readReleasedBaseline: (...args) => valid.repository.readReleasedBaseline(...args),
    readReleaseEvidence: (...args) => valid.repository.readReleaseEvidence(...args),
    writeReleasedBaseline: (...args) => valid.repository.writeReleasedBaseline(...args),
  };
  await assert.rejects(
    preflightPublicApiPromotions(
      { consumerRoot: root, policy },
      [{ ...valid, repository: legacyRepository }],
      async () => {},
    ),
    /write-plan adapter/u,
  );
  assert.deepEqual(
    await readFile(join(root, "architecture/public-api/library.artifacts.json")),
    before,
  );
  const invalid = {
    ...valid,
    extractor: {
      extract() {
        throw new Error("unreviewed second surface");
      },
    },
  };
  await assert.rejects(
    preflightPublicApiPromotions({ consumerRoot: root, policy }, [valid, invalid]),
    /unreviewed second/u,
  );
  assert.deepEqual(
    await readFile(join(root, "architecture/public-api/library.artifacts.json")),
    before,
  );
  await preflightPublicApiPromotions({ consumerRoot: root, policy }, [valid]);
  assert.deepEqual(await preflightPublicApiPromotions({ consumerRoot: root, policy }, [valid]), []);
});

test("valid authorization receipt crosses the final cancellation boundary", async (t) => {
  const root = await fixture(t);
  await fixate(root, await inspect(root));
  await json(root, "package/package.json", {
    name: packagePolicy.packageName,
    version: "1.3.0",
    exports: { "./schemas/*": "./schemas/*" },
  });
  const selected = dependencies(await inspect(root)),
    controller = new AbortController();
  const writeSignals = [];
  const repository = {
    ...selected.repository,
    readReleasedBaseline: (...args) => selected.repository.readReleasedBaseline(...args),
    readReleaseEvidence: (...args) => selected.repository.readReleaseEvidence(...args),
    describeReleasedBaselineWrite: (...args) =>
      selected.repository.describeReleasedBaselineWrite(...args),
    writeReleasedBaseline: (...args) => {
      writeSignals.push(args[3]);
      return selected.repository.writeReleasedBaseline(...args);
    },
  };
  await preflightPublicApiPromotions(
    { consumerRoot: root, policy, signal: controller.signal },
    [{ ...selected, repository }],
    async () => {
      controller.abort(new Error("late cancellation"));
    },
  );
  assert.deepEqual(writeSignals, [undefined]);
  assert.equal((await readArtifactBaseline(root, packagePolicy, evidence)).packageVersion, "1.3.0");
});

test("legacy promotion without authority does not require a write-plan adapter", async (t) => {
  const root = await fixture(t);
  await fixate(root, await inspect(root));
  await json(root, "package/package.json", {
    name: packagePolicy.packageName,
    version: "1.3.0",
    exports: { "./schemas/*": "./schemas/*" },
  });
  const selected = dependencies(await inspect(root));
  const legacyRepository = {
    readReleasedBaseline: (...args) => selected.repository.readReleasedBaseline(...args),
    readReleaseEvidence: (...args) => selected.repository.readReleaseEvidence(...args),
    writeReleasedBaseline: (...args) => selected.repository.writeReleasedBaseline(...args),
  };
  await preflightPublicApiPromotions({ consumerRoot: root, policy }, [
    { ...selected, repository: legacyRepository },
  ]);
  assert.equal((await readArtifactBaseline(root, packagePolicy, evidence)).packageVersion, "1.3.0");
});

test("packages without wildcard exports keep their existing behavior and need no sidecar", async (t) => {
  const root = await fixture(t);
  await json(root, "package/package.json", {
    name: packagePolicy.packageName,
    version: "1.2.0",
    exports: { "./package.json": "./package.json" },
  });
  const noWildcards = {
    ...packagePolicy,
    nonTypeExports: [{ exportPath: "./package.json", kind: "data" }],
  };
  const current = await inspect(root, [noWildcards]);
  assert.deepEqual(
    await analyzePublicApiCompatibility(
      { consumerRoot: root, policy: { ...policy, packages: [noWildcards] } },
      dependencies(current),
    ),
    [],
  );
  assert.equal(await readArtifactBaseline(root, noWildcards, evidence), undefined);
});
