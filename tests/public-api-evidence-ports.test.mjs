import { parse as readArchitectureYaml } from "yaml";
import assert from "node:assert/strict";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import test from "node:test";

import { withPublicApiFixture } from "./support/capability-fixtures.mjs";
import { publicApiEvidenceAdapters, schemaConfigurationDependencies } from "./support/capability-adapters.mjs";
import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-capability-config.js";
import { FilesystemPublicApiRepository } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-public-api-repository.js";
import { MicrosoftPublicApiExtractor } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/microsoft-public-api-extractor.js";
import { stagePackageSnapshot } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/staged-public-api-input.js";
import { ContainedFileReadError } from "../packages/engineering-foundation/dist/source-inventory/api.js";

const defaults = publicApiEvidenceAdapters();
const { assertSchema } = schemaConfigurationDependencies();
async function policy(root) {
  return (await loadCapabilityConfig(schemaConfigurationDependencies(), root,
    "architecture/foundation/public-api-compatibility.yaml")).packages[0];
}

test("Public API evidence readers preserve receiver, Uint8Array bytes and baseline identity", async () => {
  await withPublicApiFixture(async (root) => {
    const selected = await policy(root), calls = [];
    const expected = await new FilesystemPublicApiRepository(assertSchema, defaults).readReleasedBaseline(root, selected);
    const files = { calls, async read(input) { this.calls.push(input); return new Uint8Array(await defaults.files.read(input)); } };
    const actual = await new FilesystemPublicApiRepository(assertSchema, { ...defaults, files }).readReleasedBaseline(root, selected);
    assert.deepEqual(actual, expected);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].candidate, join(await realpath(root), selected.releasedBaselinePath));
    assert.equal(calls[0].maxBytes, 32 * 1024 * 1024);
    assert.equal(calls[0].root, await realpath(root));
  });
});

for (const [failure, suffix] of [["escape", "ESCAPE"], ["symlink", "SYMLINK_PROHIBITED"],
  ["invalid", "INVALID"], ["changed", "UNAVAILABLE"], ["missing", "UNAVAILABLE"], ["unavailable", "UNAVAILABLE"]]) {
  test(`Public API evidence port preserves ${failure} diagnostics`, async () => {
    await withPublicApiFixture(async (root) => {
      const files = { async read() { throw new ContainedFileReadError(failure); } };
      const repository = new FilesystemPublicApiRepository(assertSchema, { ...defaults, files });
      await assert.rejects(repository.readReleasedBaseline(root, await policy(root)), ({ problem }) =>
        problem?.code === `PUBLIC_API_EVIDENCE_${suffix}` && problem.phase === "public-api-evidence" && problem.retryable === false);
    });
  });
}

test("Public API baseline bootstrap alone accepts missing evidence", async () => {
  await withPublicApiFixture(async (root) => {
    const files = { async read() { throw new ContainedFileReadError("missing"); } };
    const repository = new FilesystemPublicApiRepository(assertSchema, { ...defaults, files });
    assert.equal(await repository.readReleasedBaseline(root, await policy(root), undefined, "release-promotion"), undefined);
  });
});

test("Public API extraction uses the selected source reader without fallback", async () => {
  await withPublicApiFixture(async (root) => {
    const failure = new Error("selected extraction reader failed");
    const files = { async read() { throw failure; } };
    await assert.rejects(new MicrosoftPublicApiExtractor({ ...defaults, files }).extract(root, await policy(root), "1.2.3"),
      (error) => error === failure);
  });
});

test("Public API staging preserves Uint8Array bytes and read limits", async () => {
  await withPublicApiFixture(async (root) => {
    const calls = [];
    const files = { async read(input) { calls.push(input); return new Uint8Array(await defaults.files.read(input)); } };
    const staged = await stagePackageSnapshot({ root, policy: await policy(root) }, { ...defaults, files });
    try {
      assert.ok(calls.length > 0);
      assert.ok(calls.every((input) => input.root === root && input.maxBytes === 32 * 1024 * 1024));
      assert.deepEqual(await readFile(join(staged.packageRoot, "dist/index.d.ts")),
        await readFile(join(root, "packages/library/dist/index.d.ts")));
    } finally { await rm(staged.stagingRoot, { recursive: true, force: true }); }
  });
});

for (const target of ["baseline", "staging"]) {
  test(`Public API ${target} cannot bypass the selected reader byte limit`, async () => {
    await withPublicApiFixture(async (root) => {
      const files = { async read(input) { return new Uint8Array(input.maxBytes + 1); } };
      const selected = await policy(root);
      const actual = target === "baseline"
        ? new FilesystemPublicApiRepository(assertSchema, { ...defaults, files }).readReleasedBaseline(root, selected)
        : stagePackageSnapshot({ root, policy: selected }, { ...defaults, files }).then(async (staged) => {
          await rm(staged.stagingRoot, { recursive: true, force: true });
          return null;
        });
      await assert.rejects(actual, ({ problem }) => problem?.code ===
        (target === "baseline" ? "PUBLIC_API_EVIDENCE_INVALID" : "PUBLIC_API_PATH_INVALID"));
    });
  });
}

test("Changeset YAML uses the explicit parser and propagates its rejection", async () => {
  await withPublicApiFixture(async (root) => {
    await writeFile(join(root, ".changeset/selected.md"), '---\n"@fixture/public-api": patch\n---\n\nChange\n');
    const failure = new Error("selected YAML parser failed"), calls = [];
    const parseYaml = (...args) => { calls.push(args); throw failure; };
    const repository = new FilesystemPublicApiRepository(assertSchema, { ...defaults, parseYaml });
    await assert.rejects(repository.readReleaseEvidence(root, ".changeset", await policy(root)), (error) => error === failure);
    assert.deepEqual(calls, [['"@fixture/public-api": patch', "public-api-changeset"]]);
  });
});

test("Public API write path uses the selected symlink observation before effects", async () => {
  await withPublicApiFixture(async (root) => {
    const selected = await policy(root), baselinePath = join(root, selected.releasedBaselinePath);
    const before = await readFile(baselinePath), calls = [];
    const paths = { async traversesSymbolicLink(...args) { calls.push(args); return true; } };
    const repository = new FilesystemPublicApiRepository(assertSchema, { ...defaults, paths });
    await assert.rejects(repository.writeReleasedBaseline(root, selected, {}),
      ({ problem }) => problem?.code === "PUBLIC_API_EVIDENCE_SYMLINK_PROHIBITED");
    assert.deepEqual(calls, [[await realpath(root), await realpath(baselinePath)]]);
    assert.deepEqual(await readFile(baselinePath), before);
  });
});

test("Public API cancellation precedes selected evidence ports", async () => {
  await withPublicApiFixture(async (root) => {
    const selected = await policy(root), calls = [];
    const evidence = { ...defaults, files: { async read() { calls.push("read"); throw new Error("unexpected read"); } } };
    for (const operation of [
      new FilesystemPublicApiRepository(assertSchema, evidence).readReleasedBaseline(root, selected, AbortSignal.abort()),
      new MicrosoftPublicApiExtractor(evidence).extract(root, selected, "1.2.3", AbortSignal.abort())
    ]) { await assert.rejects(operation, ({ problem }) => problem?.code === "EXECUTION_CANCELLED"); }
    assert.deepEqual(calls, []);
  });
});

for (const oversized of [false, true]) {
  test(`Changesets prerelease evidence preserves the selected reader and its limit (${oversized})`, async () => {
    await withPublicApiFixture(async (root) => {
      const calls = [];
      const files = { async read(input) {
        calls.push(input);
        if (basename(input.candidate) === "pre.json") {
          return oversized ? new Uint8Array(input.maxBytes + 1) : new TextEncoder().encode(JSON.stringify({
            mode: "pre", tag: "next", initialVersions: { "@fixture/public-api": "1.2.3" }
          }));
        }
        return defaults.files.read(input);
      } };
      const operation = new FilesystemPublicApiRepository(assertSchema, { ...defaults, files })
        .readReleaseEvidence(root, ".changeset", await policy(root));
      if (oversized) {
        await assert.rejects(operation, ({ problem }) => problem?.code === "CHANGESET_PRERELEASE_STATE_INVALID");
      } else {
        const result = await operation;
        assert.equal(result.prereleaseTag, "next");
        assert.equal(result.prereleaseInitialVersion, "1.2.3");
      }
      assert.equal(calls.find((input) => basename(input.candidate) === "pre.json").maxBytes, 1024 * 1024);
    });
  });
}

test("Public API baseline preserves unknown selected-reader failure identity", async () => {
  await withPublicApiFixture(async (root) => {
    const failure = new Error("selected baseline failed"), files = { async read() { throw failure; } };
    const repository = new FilesystemPublicApiRepository(assertSchema, { ...defaults, files });
    await assert.rejects(repository.readReleasedBaseline(root, await policy(root)), (error) => error === failure);
  });
});

test("audit pinned SDK has exact disjoint ownership and opaque loads elsewhere remain rejected", async () => {
  const { OxcSourceDependencyParser } = await import("../packages/engineering-foundation/dist/capabilities/source-dependencies/adapters/outbound/oxc/oxc-source-dependency-parser.js");
  const { readSourceArchitectureHeader, parseSourceArchitecturePolicy } = await import("../packages/engineering-foundation/dist/capabilities/source-dependencies/adapters/inbound/configuration/parse-capability-config.js");
  const { evaluateSourceDependencies } = await import("../packages/engineering-foundation/dist/capabilities/source-dependencies/application/policies/evaluate-source-dependencies.js");
  const { readdir } = await import("node:fs/promises");
  const root = "packages/engineering-foundation/src/capabilities/public-api-compatibility/adapters";
  const path = `${root}/outbound/api-extractor/load-pinned-audit-sdk.ts`;
  // The actual parser validates the complete v2 configuration, including overlaps.
  const architecturePolicy = parseSourceArchitecturePolicy(readSourceArchitectureHeader(readArchitectureYaml(await readFile("architecture/foundation/source-dependencies.yaml", "utf8"))));
  const owner = file => architecturePolicy.boundaries.filter(boundary => boundary.roots.some(directory => file === directory || file.startsWith(`${directory}/`)));
  const loader = owner(path);
  assert.equal(loader.length, 1);
  assert.equal(loader[0].id, "capability.public-api-compatibility.pinned-sdk-loader");
  assert.deepEqual(loader[0].roots, [path]);
  assert.deepEqual(loader[0].entrypoints, [path]);
  assert.deepEqual(loader[0].allowedRuntimeReferences, ["commonjs"]);
  const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith(".ts")).map(file => `${root}/${file.split(sep).join("/")}`);
  assert.ok(files.length > 10);
  for (const file of files) {
    assert.equal(owner(file).length, 1, file);
    if (file !== path) { assert.deepEqual(owner(file)[0].allowedRuntimeReferences, [], file); }
  }
  const parser = new OxcSourceDependencyParser();
  const parsed = parser.parse({ path, source: await readFile(path, "utf8") });
  assert.equal(parsed.parseErrorCount, 0);
  assert.deepEqual(parsed.unresolved.map(reference => reference.kind), ["commonjs", "commonjs"]);
  const evaluate = (file, references) => evaluateSourceDependencies({ policy: { ...architecturePolicy, boundaries: architecturePolicy.boundaries.map(boundary => ({ ...boundary, entrypoints: [] })) }, graph: {
    nodes: [], edges: [], parseFailures: [], unclassifiedSourcePaths: [],
    unresolvedRuntimeReferences: references.map(reference => ({ ...reference, path: file, boundaryId: owner(file)[0].id }))
  } });
  assert.deepEqual(evaluate(path, parsed.unresolved), []);
  const source = 'import { createRequire } from "node:module"; const load = createRequire("/opaque/sdk.cjs"); load("typescript");';
  for (const file of files.filter(candidate => candidate !== path)) {
    const witness = parser.parse({ path: file, source });
    assert.equal(witness.unresolved.length, 1);
    const rejected = evaluate(file, witness.unresolved);
    assert.equal(rejected.length, 1, file);
    assert.match(rejected[0].message, /Non-literal commonjs reference/);
  }
});
