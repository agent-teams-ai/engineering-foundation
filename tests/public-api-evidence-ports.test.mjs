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
async function existingPolicy(root) {
  return (await loadCapabilityConfig(schemaConfigurationDependencies(), root,
    "architecture/foundation/public-api-compatibility.yaml")).packages[0];
}

test("Public API evidence readers preserve receiver, Uint8Array bytes and baseline identity", async () => {
  await withPublicApiFixture(async (root) => {
    const selected = await existingPolicy(root), calls = [];
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
      await assert.rejects(repository.readReleasedBaseline(root, await existingPolicy(root)), ({ problem }) =>
        problem?.code === `PUBLIC_API_EVIDENCE_${suffix}` && problem.phase === "public-api-evidence" && problem.retryable === false);
    });
  });
}

test("Public API baseline bootstrap alone accepts missing evidence", async () => {
  await withPublicApiFixture(async (root) => {
    const files = { async read() { throw new ContainedFileReadError("missing"); } };
    const repository = new FilesystemPublicApiRepository(assertSchema, { ...defaults, files });
    assert.equal(await repository.readReleasedBaseline(root, await existingPolicy(root), undefined, "release-promotion"), undefined);
  });
});

test("Public API extraction uses the selected source reader without fallback", async () => {
  await withPublicApiFixture(async (root) => {
    const failure = new Error("selected extraction reader failed");
    const files = { async read() { throw failure; } };
    await assert.rejects(new MicrosoftPublicApiExtractor({ ...defaults, files }).extract(root, await existingPolicy(root), "1.2.3"),
      (error) => error === failure);
  });
});

test("Public API staging preserves Uint8Array bytes and read limits", async () => {
  await withPublicApiFixture(async (root) => {
    const calls = [];
    const files = { async read(input) { calls.push(input); return new Uint8Array(await defaults.files.read(input)); } };
    const staged = await stagePackageSnapshot({ root, policy: await existingPolicy(root) }, { ...defaults, files });
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
      const selected = await existingPolicy(root);
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
    await assert.rejects(repository.readReleaseEvidence(root, ".changeset", await existingPolicy(root)), (error) => error === failure);
    assert.deepEqual(calls, [['"@fixture/public-api": patch', "public-api-changeset"]]);
  });
});

test("Public API write path uses the selected symlink observation before effects", async () => {
  await withPublicApiFixture(async (root) => {
    const selected = await existingPolicy(root), baselinePath = join(root, selected.releasedBaselinePath);
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
    const selected = await existingPolicy(root), calls = [];
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
        .readReleaseEvidence(root, ".changeset", await existingPolicy(root));
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
    await assert.rejects(repository.readReleasedBaseline(root, await existingPolicy(root)), (error) => error === failure);
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

const growthTypedEntries = result => result.surface.value.entries.filter(row => row.coordinate.subject.kind === "typed");

// Focused S1 observation cases; retained under the existing public API test owner.
{
  const { createHash } = await import("node:crypto");

  const { growthDimensions } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-observation.js");
  const { growthObservationDigest, normalizeGrowthObservation } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js");
  const digest = `sha256:${"a".repeat(64)}`;
  const fingerprint = { sha256(value) { return createHash("sha256").update(value).digest("hex"); } };
  function observation() {
    return { contractRevision: "foundation:sdk-growth:c0:5", observationVersion: "foundation:sdk-growth:observation:1", repository: "fixture", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), topologyDigest: digest, lockDigest: digest, toolchainDigest: digest, artifactDigests: [digest], tool: { version: "1", artifactDigest: digest, extractorVersion: "pinned" }, coverage: [{ packageName: "fixture", classification: "governed", dimensions: growthDimensions.map(dimension => ({ dimension, status: "unavailable", reasons: ["unobserved"] })) }], entries: [{ coordinate: { packageName: "fixture", exportPath: ".", resolutionBranch: [{ condition: "import" }, { index: 0 }], subject: { kind: "typed", canonicalReference: "opaque" } }, value: { state: "present", digest } }] };
  }
  test("S1: normalizes set order without mutating input or semantic sequences", () => {
    const original = observation();
    const changed = { ...original, coverage: original.coverage.map(row => ({ ...row, dimensions: row.dimensions.toReversed() })) };
    assert.equal(growthObservationDigest(original, fingerprint), growthObservationDigest(changed, fingerprint));
    assert.deepEqual(normalizeGrowthObservation(original).entries[0].coordinate.resolutionBranch, original.entries[0].coordinate.resolutionBranch);
    const reversed = observation();
    reversed.entries[0].coordinate.resolutionBranch.reverse();
    assert.notEqual(growthObservationDigest(original, fingerprint), growthObservationDigest(reversed, fingerprint));
  });
  test("S1: rejects identical duplicate coordinates, dimensions, reasons and artifacts", () => {
    for (const alter of [value => value.entries.push(value.entries[0]), value => value.coverage[0].dimensions.push(value.coverage[0].dimensions[0]), value => value.coverage[0].dimensions[0].reasons.push("unobserved"), value => value.artifactDigests.push(digest)]) {
      const value = observation(); alter(value);
      assert.throws(() => growthObservationDigest(value, fingerprint), /duplicate-growth-collection-key/u);
    }
  });
  test("S1: rejects missing coverage and S1 decision authority", () => {
    const missing = observation(); missing.coverage[0].dimensions.pop();
    assert.throws(() => normalizeGrowthObservation(missing), /incomplete-growth-coverage-structure/u);
    const active = observation(); active.coverage[0].dimensions.find(row => row.dimension === "decision").status = "complete";
    assert.throws(() => normalizeGrowthObservation(active), /s1-decision-evidence-unavailable/u);
  });
  test("S1: rejects malformed identity and package scope", () => {
    assert.throws(() => normalizeGrowthObservation({ ...observation(), sourceTree: "not-a-tree" }), /invalid-growth-source-identity/u);
    const value = observation(); value.entries[0].coordinate.packageName = "other";
    assert.throws(() => normalizeGrowthObservation(value), /growth-entry-package-outside-topology/u);
  });
  test("S1: closed observation shapes reject extra fields and ambiguous union branches", () => {
    for (const alter of [
      value => { value.surfaceDigest = digest; },
      value => { value.tool.extra = "authority"; },
      value => { value.entries[0].coordinate.resolutionBranch[0].index = 0; },
      value => { value.entries[0].value.state = "missing"; },
      value => { value.coverage[0].classification = "excluded"; },
      value => { value.coverage[0].dimensions[0].status = "trusted"; }
    ]) {
      const value = observation(); alter(value);
      assert.throws(() => normalizeGrowthObservation(value), /invalid-growth-observation-shape/u);
    }
  });
  test("S1: binary ordering retains supplementary Unicode order and rejects uncanonical text without normalizing", () => {
    const value = observation();
    const original = value.entries[0];
    value.entries = ["\uE000", "\u{10000}"].map(canonicalReference => ({ ...original, coordinate: { ...original.coordinate, subject: { kind: "typed", canonicalReference } } }));
    assert.deepEqual(normalizeGrowthObservation(value).entries.map(row => row.coordinate.subject.canonicalReference), ["\u{10000}", "\uE000"]);
    value.entries[0].coordinate.subject.canonicalReference = "e\u0301";
    assert.throws(() => growthObservationDigest(value, fingerprint), /growth-canonical-value-unsupported/u);
  });
  test("S1: observation digest matches the frozen-domain canonical UTF-8 vector without newline", () => {
    assert.equal(growthObservationDigest(observation(), fingerprint), "sha256:db6131b2fc0a3937c8d19ac60c348c38455734f3adc96565055f09b85e44e0ce");
  });
}

// Focused S1 observation cases; retained under the existing public API test owner.
{
  const { retainGrowthCompatibility } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/retain-growth-compatibility.js");

  const policy = { packageName: "fixture", entrypoints: [], nonTypeExports: [] };
  const typed = { schemaVersion: 1, packageName: "fixture", packageVersion: "1.0.0", extractorVersion: "pinned", entrypoints: [{ exportPath: ".", items: [
    { canonicalReference: "opaque", kind: "Function", parentKind: "EntryPoint", signature: " exact\nbytes " },
    { canonicalReference: "empty-parent", kind: "Function", parentKind: "EntryPoint", parentReference: "", signature: "x" }
  ] }] };
  const artifact = { schemaVersion: 1, packageName: "fixture", packageVersion: "1.0.0", wildcardExports: [], jsonSchemas: [] };
  function input(subjects) {
    return { consumerRoot: "/unused", subjects: subjects ?? [{ policy, packageVersion: "1.0.0" }], extractorVersion: "pinned", cancellation: { throwIfCancelled() {} } };
  }
  function ports(overrides = {}) {
    return { typed: { async extract() { return typed; } }, artifact: { async inspect() { return [artifact]; } }, ...overrides };
  }
  test("S1: retains separate lossless v1 branches and invokes each observer once", async () => {
    let typedCalls = 0;
    let artifactCalls = 0;
    const rows = await retainGrowthCompatibility(input(), ports({ typed: { async extract() { typedCalls++; return typed; } }, artifact: { async inspect() { artifactCalls++; return [artifact]; } } }));
    assert.equal(typedCalls, 1);
    assert.equal(artifactCalls, 1);
    assert.deepEqual(rows[0].compatibility.typed, { kind: "typed", snapshot: { status: "available", value: typed } });
    assert.equal(Object.hasOwn(rows[0].compatibility.typed.snapshot.value.entrypoints[0].items[0], "parentReference"), false);
    assert.equal(rows[0].compatibility.typed.snapshot.value.entrypoints[0].items[1].parentReference, "");
    assert.equal(rows[0].compatibility.artifact.snapshot.value.extractorVersion, "package-artifact-inventory/1");
    assert.deepEqual(rows[0].compatibility.artifact.snapshot.value.entrypoints, []);
  });
  test("S1: rejects duplicate packages before either observer runs", async () => {
    const subject = input().subjects[0];
    await assert.rejects(retainGrowthCompatibility(input([subject, subject]), ports()), /duplicate-compatibility-package/u);
  });
  test("S1: rejects cross-branch provenance and missing artifact rows", async () => {
    await assert.rejects(retainGrowthCompatibility(input(), ports({ typed: { async extract() { return { ...typed, extractorVersion: "package-artifact-inventory/1" }; } } })), /typed-observer-provenance-mismatch/u);
    await assert.rejects(retainGrowthCompatibility(input(), ports({ artifact: { async inspect() { return []; } } })), /artifact-observer-provenance-mismatch/u);
  });
  test("S1: retains independent branch failure with stable reasons", async () => {
    const result = await retainGrowthCompatibility(input(), ports({ typed: { async extract() { throw new Error("random temporary path"); } } }));
    assert.deepEqual(result[0].compatibility.typed.snapshot, { status: "unavailable", reasons: ["typed-observation-unavailable"] });
    assert.equal(result[0].compatibility.artifact.snapshot.status, "available");
  });
  test("S1: propagates cancellation after an observer throws", async () => {
    let cancelled = false;
    const request = { ...input(), cancellation: { throwIfCancelled() { if (cancelled) { throw new Error("cancelled"); } } } };
    await assert.rejects(retainGrowthCompatibility(request, ports({ typed: { async extract() { cancelled = true; throw new Error("io"); } } })), /cancelled/u);
  });
  test("S1: retained snapshots keep unchanged v1 comparator fingerprints independently", async () => {
    const { classifyPublicApiChange } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/evaluate-public-api-compatibility.js");
    const { artifactApiProjection } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/artifact-api-projection.js");
    const { createHash } = await import("node:crypto");
    const fingerprint = { sha256(value) { return createHash("sha256").update(value).digest("hex"); } };
    const beforeTyped = structuredClone(typed);
    beforeTyped.entrypoints[0].items[0].signature = "old signature";
    const beforeArtifact = { ...artifact, wildcardExports: [{ exportPath: "./schemas/*", targetPattern: "schemas/*", members: ["schemas/old.json"] }] };
    const [row] = await retainGrowthCompatibility(input(), ports());
    assert.deepEqual(classifyPublicApiChange(beforeTyped, row.compatibility.typed.snapshot.value, fingerprint), classifyPublicApiChange(beforeTyped, typed, fingerprint));
    assert.deepEqual(classifyPublicApiChange(artifactApiProjection(beforeArtifact), row.compatibility.artifact.snapshot.value, fingerprint), classifyPublicApiChange(artifactApiProjection(beforeArtifact), artifactApiProjection(artifact), fingerprint));
  });
  test("S1: later artifact observation cannot mutate retained typed evidence", async () => {
    const mutable = structuredClone(typed);
    const [row] = await retainGrowthCompatibility(input(), ports({ typed: { async extract() { return mutable; } }, artifact: { async inspect() { mutable.entrypoints[0].items[0].signature = "mutated"; return [artifact]; } } }));
    assert.equal(row.compatibility.typed.snapshot.value.entrypoints[0].items[0].signature, typed.entrypoints[0].items[0].signature);
  });
}

// Focused S1 observation cases; retained under the existing public API test owner.
{
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");

  const { createGrowthObservation } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/observe-sdk-growth.js");
  const { observedPackageExports } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-package-export-coverage.js");
  const { growthObservationDigest } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js");
  const matrix = JSON.parse(readFileSync(new URL("../docs/reference/sdk-growth-c0/surface-matrix.json", import.meta.url)));
  const digest = `sha256:${"a".repeat(64)}`;
  const invocation = { repository: "fixture", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), topologyDigest: digest, lockDigest: digest, toolchainDigest: digest, artifactDigests: [digest], tool: { version: "1", artifactDigest: digest, extractorVersion: "pinned" } };
  const cancellation = { throwIfCancelled() {} };
  const fingerprint = { sha256(value) { return createHash("sha256").update(value).digest("hex"); } };
  function fixture(repository) {
    const packages = repository.packages.map(pkg => ({ name: pkg.packageName, manifestPath: pkg.manifestPath, rootPath: pkg.manifestPath.includes("/") ? pkg.manifestPath.slice(0, pkg.manifestPath.lastIndexOf("/")) : ".", moduleType: "module", dependencies: [], bundledDependencies: [], exportSurface: { explicit: !pkg.surface.some(row => row.shape === "no-exports"), entries: pkg.surface.filter(row => row.exportPath !== undefined).map(row => ({ subpath: row.exportPath, target: row.target, availability: "available" })) } }));
    const subjects = packages.filter(pkg => pkg.exportSurface.explicit).map(pkg => {
      const observed = observedPackageExports({ manifest: { exports: Object.fromEntries(pkg.exportSurface.entries.map(row => [row.subpath, row.target])) }, policy: { packageName: pkg.name, packageRoot: pkg.rootPath } });
      return { packageVersion: repository.packages.find(row => row.packageName === pkg.name).version, policy: { packageName: pkg.name, packageRoot: pkg.rootPath, manifestPath: pkg.manifestPath, tsconfigPath: "tsconfig.json", releasedBaselinePath: "unused.json", approvedBreakingChanges: [], entrypoints: observed.filter(row => row.kind === "typed").map(row => ({ exportPath: row.exportPath, declarationEntryPoint: row.declarationEntryPoint })), nonTypeExports: observed.filter(row => row.kind !== "typed").map(row => ({ exportPath: row.exportPath, kind: row.kind })) } };
    });
    const calls = { workspace: 0, typed: [], artifact: [] };
    const dependencies = {
      fingerprint,
      workspace: { async read() { calls.workspace++; return { packages, catalogs: [] }; } },
      typed: { async extract(_root, policy, packageVersion) { calls.typed.push(policy.packageName); return { schemaVersion: 1, packageName: policy.packageName, packageVersion, extractorVersion: "pinned", entrypoints: policy.entrypoints.map(entry => ({ exportPath: entry.exportPath, items: [{ canonicalReference: "opaque!same-reference", kind: "Function", parentKind: "EntryPoint", signature: "export declare function fixture(): void;" }] })) }; } },
      artifact: { async inspect(_root, policies) { return policies.map(policy => {
        calls.artifact.push(policy.packageName);
        const pkg = packages.find(row => row.name === policy.packageName);
        const wildcardExports = policy.nonTypeExports.filter(row => row.kind === "wildcard").map(row => ({ exportPath: row.exportPath, targetPattern: pkg.exportSurface.entries.find(entry => entry.subpath === row.exportPath).target.slice(2), members: [pkg.exportSurface.entries.find(entry => entry.subpath === row.exportPath).target.slice(2).replace("*", "fixture.schema.json")] }));
        return { schemaVersion: 1, packageName: policy.packageName, packageVersion: subjects.find(row => row.policy.packageName === policy.packageName).packageVersion, status: "release-candidate", wildcardExports, jsonSchemas: wildcardExports.flatMap(row => row.members.map(path => ({ path, id: `https://fixture/${path}`, digest, discriminators: {} }))) };
      }); } }
    };
    return { packages, subjects, calls, dependencies, port() { return createGrowthObservation({ consumerRoot: "/unused", workspaceManifestPath: "pnpm-workspace.yaml", subjects }, dependencies); } };
  }
  for (const repository of matrix.repositories) {
    test(`S1: C0 ${repository.repository}: every frozen surface row has an existing route or explicit unsupported outcome`, async () => {
      const setup = fixture(repository);
      const result = await setup.port().observe(invocation, cancellation);
      assert.equal(setup.calls.workspace, 1);
      assert.equal(new Set(setup.calls.typed).size, setup.subjects.length);
      assert.equal(setup.calls.typed.length, setup.subjects.length);
      assert.equal(setup.calls.artifact.length, setup.subjects.length);
      assert.equal(result.surface.status, "available");
      assert.equal(result.compatibilitySnapshots.length, repository.packages.length);
      for (const pkg of repository.packages) {
        const coverage = result.surface.value.coverage.find(row => row.packageName === pkg.packageName);
        assert.equal(coverage.dimensions.length, 10);
        assert.equal(coverage.dimensions.find(row => row.dimension === "decision").status, "unavailable");
        for (const row of pkg.surface) {
          const entries = result.surface.value.entries.filter(entry => entry.coordinate.packageName === pkg.packageName);
          if (row.shape.startsWith("typed-")) {
            assert.equal(entries.filter(entry => entry.coordinate.exportPath === row.exportPath && entry.coordinate.subject.kind === "typed").length, 1);
            assert.equal(entries.filter(entry => entry.coordinate.exportPath === row.exportPath && entry.coordinate.subject.kind === "export-branch").length, 1);
          } else if (row.shape === "wildcard") {
            assert.equal(entries.filter(entry => entry.coordinate.exportPath === row.exportPath.replace("*", "fixture.schema.json") && entry.coordinate.subject.kind === "wildcard-member").length, 1);
          } else {
            const dimension = row.shape === "no-exports" ? "resolution" : row.shape;
            assert.equal(coverage.dimensions.find(entry => entry.dimension === dimension).status, "unsupported");
          }
        }
      }
      assert.equal(Object.isFrozen(result), true);
      assert.equal(Object.isFrozen(result.surface.value.entries), true);
    });
  }
  test("S1: reordered inventory and selectors have identical growth hashes", async () => {
    const setup = fixture(matrix.repositories[0]);
    const first = await setup.port().observe(invocation, cancellation);
    setup.packages.reverse(); setup.subjects.reverse();
    const second = await setup.port().observe(invocation, cancellation);
    assert.equal(growthObservationDigest(first.surface.value, fingerprint), growthObservationDigest(second.surface.value, fingerprint));
  });
  test("S1: low-level observers cannot mutate the captured workspace observation", async () => {
    const setup = fixture(matrix.repositories[1]);
    const pkg = setup.packages.find(row => row.exportSurface.explicit);
    const originalTarget = structuredClone(pkg.exportSurface.entries[0].target);
    const extract = setup.dependencies.typed.extract;
    setup.dependencies.typed.extract = async (...args) => {
      pkg.exportSurface.entries[0].target = null;
      return extract(...args);
    };
    const result = await setup.port().observe(invocation, cancellation);
    const typed = result.surface.value.entries.filter(row => row.coordinate.packageName === pkg.name && row.coordinate.subject.kind === "typed");
    assert.equal(typed.length, 1);
    assert.deepEqual(typed[0].coordinate.resolutionBranch, [{ condition: "import" }, { condition: "types" }]);
    assert.notEqual(originalTarget, null);
  });
  test("S1: missing topology and failed observers never fabricate empty successful evidence", async () => {
    const setup = fixture(matrix.repositories[1]);
    setup.dependencies.workspace.read = async () => { throw new Error("ephemeral path"); };
    const missing = await setup.port().observe(invocation, cancellation);
    assert.deepEqual(missing.surface, { status: "unavailable", reasons: ["workspace-observation-unavailable"] });
    assert.equal(setup.calls.typed.length, 0);
    setup.dependencies.workspace.read = async () => ({ packages: setup.packages, catalogs: [] });
    setup.dependencies.typed.extract = async () => { throw new Error("unavailable"); };
    const failed = await setup.port().observe(invocation, cancellation);
    assert.equal(failed.compatibilitySnapshots.find(row => row.packageName === setup.subjects[0].policy.packageName).typed.snapshot.status, "unavailable");
    assert.equal(failed.surface.value.entries.some(row => row.coordinate.subject.kind === "typed"), false);
  });
  test("S1: duplicate topology, out-of-scope policy and forged observer package fail closed", async () => {
    const setup = fixture(matrix.repositories[1]);
    setup.packages.push(setup.packages[0]);
    await assert.rejects(setup.port().observe(invocation, cancellation), /duplicate-growth-collection-key/u);
    setup.packages.pop();
    setup.subjects[0].policy.manifestPath = "elsewhere.json";
    await assert.rejects(setup.port().observe(invocation, cancellation), /growth-policy-outside-observed-topology/u);
    const clean = fixture(matrix.repositories[1]);
    clean.dependencies.typed.extract = async () => ({ schemaVersion: 1, packageName: "forged", packageVersion: "0.2.0", extractorVersion: "pinned", entrypoints: [] });
    await assert.rejects(clean.port().observe(invocation, cancellation), /typed-observer-provenance-mismatch/u);
  });
  test("S1: condition order, null and fallback mutations change growth values without inventing absence", async () => {
    const setup = fixture(matrix.repositories[1]);
    const pkg = setup.packages.find(row => row.exportSurface.explicit);
    const entry = pkg.exportSurface.entries[0];
    const original = entry.target;
    const before = await setup.port().observe(invocation, cancellation);
    entry.target = Object.fromEntries(Object.entries(original).toReversed());
    const reordered = await setup.port().observe(invocation, cancellation);
    assert.notEqual(growthObservationDigest(before.surface.value, fingerprint), growthObservationDigest(reordered.surface.value, fingerprint));
    entry.target = [original, null, original];
    const fallback = await setup.port().observe(invocation, cancellation);
    const typedEntries = fallback.surface.value.entries.filter(row => row.coordinate.packageName === pkg.name && row.coordinate.subject.kind === "typed");
    assert.equal(typedEntries.length, 2);
    assert.deepEqual(typedEntries.map(row => row.coordinate.resolutionBranch[0]), [{ index: 0 }, { index: 2 }]);
    assert.equal(fallback.surface.value.entries.every(row => row.value.state === "present"), true);
  });
  test("S1: config removal keeps the workspace package and unavailable branches", async () => {
    const setup = fixture(matrix.repositories[1]);
    const removed = setup.subjects.pop();
    const result = await setup.port().observe(invocation, cancellation);
    const row = result.compatibilitySnapshots.find(entry => entry.packageName === removed.policy.packageName);
    assert.equal(row.typed.snapshot.status, "unavailable");
    assert.equal(row.artifact.snapshot.status, "unavailable");
    assert.ok(result.surface.value.coverage.some(entry => entry.packageName === removed.policy.packageName));
  });
  test("S1: unsupported typed wildcard retains an explicit outcome and no typed coordinates", async () => {
    const setup = fixture(matrix.repositories[1]);
    const pkg = setup.packages.find(row => row.exportSurface.explicit);
    pkg.exportSurface.entries[0].target = { types: "./dist/*.d.ts", import: "./dist/*.js" };
    const result = await setup.port().observe(invocation, cancellation);
    assert.equal(result.surface.value.coverage.find(row => row.packageName === pkg.name).dimensions.find(row => row.dimension === "typed").status, "unsupported");
    assert.equal(result.surface.value.entries.some(row => row.coordinate.packageName === pkg.name && row.coordinate.subject.kind === "typed"), false);
  });
  test("S1: uncanonical observed declarations keep v1 bytes but make growth unavailable", async () => {
    const setup = fixture(matrix.repositories[1]);
    const extract = setup.dependencies.typed.extract;
    setup.dependencies.typed.extract = async (...args) => {
      const value = await extract(...args);
      value.entrypoints[0].items[0].signature = "e\u0301";
      return value;
    };
    const result = await setup.port().observe(invocation, cancellation);
    assert.deepEqual(result.surface, { status: "unavailable", reasons: ["growth-canonical-value-unsupported"] });
    assert.equal(result.compatibilitySnapshots.find(row => row.typed.snapshot.status === "available").typed.snapshot.value.entrypoints[0].items[0].signature, "e\u0301");
  });
  test("S1: artifact-only identity changes do not manufacture SDK coordinates or values", async () => {
    const setup = fixture(matrix.repositories[1]);
    const before = await setup.port().observe(invocation, cancellation);
    const after = await setup.port().observe({ ...invocation, artifactDigests: [`sha256:${"b".repeat(64)}`] }, cancellation);
    assert.deepEqual(before.surface.value.entries, after.surface.value.entries);
    assert.notEqual(growthObservationDigest(before.surface.value, fingerprint), growthObservationDigest(after.surface.value, fingerprint));
  });
  test("S1: equal-count replacement and signature mutations preserve opaque coordinate semantics", async () => {
    const setup = fixture(matrix.repositories[1]);
    const before = await setup.port().observe(invocation, cancellation);
    const extract = setup.dependencies.typed.extract;
    setup.dependencies.typed.extract = async (...args) => {
      const value = await extract(...args);
      value.entrypoints[0].items[0].canonicalReference = "opaque!replacement";
      return value;
    };
    const replaced = await setup.port().observe(invocation, cancellation);
    assert.equal(growthTypedEntries(before).length, growthTypedEntries(replaced).length);
    assert.notDeepEqual(growthTypedEntries(before).map(row => row.coordinate), growthTypedEntries(replaced).map(row => row.coordinate));
    setup.dependencies.typed.extract = async (...args) => {
      const value = await extract(...args);
      value.entrypoints[0].items[0].signature = "export type Changed = number;";
      return value;
    };
    const changed = await setup.port().observe(invocation, cancellation);
    assert.deepEqual(growthTypedEntries(before).map(row => row.coordinate), growthTypedEntries(changed).map(row => row.coordinate));
    assert.notDeepEqual(growthTypedEntries(before).map(row => row.value), growthTypedEntries(changed).map(row => row.value));
  });
}

// Focused S1 observation cases; retained under the existing public API test owner.
{
  const { createHash } = await import("node:crypto");
  const { mkdtemp, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");


  const { createGrowthObservation } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/observe-sdk-growth.js");

  const { FilesystemPackageArtifactInventory } = await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-package-artifact-inventory.js");
  const { PnpmWorkspaceInventoryReader } = await import("../packages/engineering-foundation/dist/workspace-inventory/adapters/outbound/pnpm/pnpm-workspace-inventory-reader.js");
  const { PnpmPackageManifestSnapshotReader } = await import("../packages/engineering-foundation/dist/workspace-inventory/adapters/outbound/pnpm/pnpm-package-manifest-snapshot-reader.js");
  const { readContainedRegularFile, pathTraversesSymbolicLink } = await import("../packages/engineering-foundation/dist/source-inventory/node.js");
  const { AjvJsonSchemaReleaseInspector } = await import("../packages/engineering-foundation/dist/capabilities/contract-json-schema-releases/module.js");

  const digest = `sha256:${"a".repeat(64)}`;
  const invocation = { repository: "fixture", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), topologyDigest: digest, lockDigest: digest, toolchainDigest: digest, artifactDigests: [], tool: { version: "1", artifactDigest: digest, extractorVersion: "7.58.12" } };
  const cancellation = { throwIfCancelled() {} };

  test("S1: one S1 execution reuses real workspace, Extractor and wildcard adapters and observes mutations", async t => {
    const root = await mkdtemp(join(tmpdir(), "ef-growth-adapters-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "package/dist"), { recursive: true });
    await mkdir(join(root, "package/schemas"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture-root", private: true }));
    const manifest = { name: "growth-fixture", version: "1.0.0", type: "module", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./schemas/*": "./schemas/*" } };
    await writeFile(join(root, "package/package.json"), JSON.stringify(manifest));
    await writeFile(join(root, "package/tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", target: "ES2022", strict: true }, files: ["dist/index.d.ts"] }));
    await writeFile(join(root, "package/dist/index.d.ts"), "export declare function stable(value: string): string;\n");
    const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://fixture/record/v1", type: "string", minLength: 1 };
    await writeFile(join(root, "package/schemas/v1.schema.json"), JSON.stringify(schema));
    const files = { read: readContainedRegularFile };
    const evidence = { files, paths: { traversesSymbolicLink: pathTraversesSymbolicLink } };
    const workspace = new PnpmWorkspaceInventoryReader({ async readYaml() { return { packages: ["package"] }; } }, new PnpmPackageManifestSnapshotReader({ read: readContainedRegularFile, pathTraversesSymbolicLink }));
    const port = createGrowthObservation({ consumerRoot: root, workspaceManifestPath: "pnpm-workspace.yaml", subjects: [{ packageVersion: "1.0.0", policy: { packageName: "growth-fixture", packageRoot: "package", manifestPath: "package/package.json", tsconfigPath: "package/tsconfig.json", releasedBaselinePath: "architecture/public-api/growth-fixture.json", approvedBreakingChanges: [], entrypoints: [{ exportPath: ".", declarationEntryPoint: "package/dist/index.d.ts" }], nonTypeExports: [{ exportPath: "./schemas/*", kind: "wildcard" }] } }] }, { workspace, typed: new MicrosoftPublicApiExtractor(evidence), artifact: new FilesystemPackageArtifactInventory(new AjvJsonSchemaReleaseInspector(files), evidence), fingerprint: { sha256(value) { return createHash("sha256").update(value).digest("hex"); } } });
    const before = await port.observe(invocation, cancellation);
    const retained = before.compatibilitySnapshots.find(row => row.packageName === "growth-fixture");
    assert.equal(retained.typed.snapshot.status, "available");
    assert.equal(retained.artifact.snapshot.status, "available");
    assert.equal(retained.typed.snapshot.value.extractorVersion, "7.58.12");
    assert.equal(retained.artifact.snapshot.value.extractorVersion, "package-artifact-inventory/1");
    assert.equal(before.surface.status, "available");
    await writeFile(join(root, "package/dist/index.d.ts"), "export declare function stable(value: number): number;\n");
    await writeFile(join(root, "package/schemas/v1.schema.json"), JSON.stringify({ ...schema, minLength: 2 }));
    const after = await port.observe(invocation, cancellation);
    assert.equal(after.surface.status, "available");
    for (const kind of ["typed", "wildcard-member"]) {
      const first = before.surface.value.entries.filter(row => row.coordinate.subject.kind === kind);
      const second = after.surface.value.entries.filter(row => row.coordinate.subject.kind === kind);
      assert.equal(first.length, 1, kind);
      assert.deepEqual(first.map(row => row.coordinate), second.map(row => row.coordinate));
      assert.notDeepEqual(first.map(row => row.value), second.map(row => row.value));
    }
  });
}
