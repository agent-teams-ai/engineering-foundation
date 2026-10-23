import { registerGrowthAdmissionCases } from "./support/public-api-growth-admission-cases.mjs";
import { parse as readArchitectureYaml } from "yaml";
import assert from "node:assert/strict";
import {
  readFile,
  readdir as readDirectory,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import test from "node:test";

import { withPublicApiFixture } from "./support/capability-fixtures.mjs";
import {
  publicApiEvidenceAdapters,
  schemaConfigurationDependencies,
} from "./support/capability-adapters.mjs";
import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-capability-config.js";
import { FilesystemPublicApiRepository } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-public-api-repository.js";
import { TypeScriptPublicApiExtractor } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/microsoft-public-api-extractor.js";
import { stagePackageSnapshot } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/staged-public-api-input.js";
import { ContainedFileReadError } from "../packages/engineering-foundation/dist/source-inventory/api.js";

import { createWorkspaceGrowthReader } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/workspace-growth-reader.js";

const defaults = publicApiEvidenceAdapters();
const { assertSchema } = schemaConfigurationDependencies();
async function existingPolicy(root) {
  return (
    await loadCapabilityConfig(
      schemaConfigurationDependencies(),
      root,
      "architecture/foundation/public-api-compatibility.yaml",
    )
  ).packages[0];
}

test("Public API evidence readers preserve receiver, Uint8Array bytes and baseline identity", async () => {
  await withPublicApiFixture(async (root) => {
    const selected = await existingPolicy(root),
      calls = [];
    const expected = await new FilesystemPublicApiRepository(
      assertSchema,
      defaults,
    ).readReleasedBaseline(root, selected);
    const files = {
      calls,
      async read(input) {
        this.calls.push(input);
        return new Uint8Array(await defaults.files.read(input));
      },
    };
    const actual = await new FilesystemPublicApiRepository(assertSchema, {
      ...defaults,
      files,
    }).readReleasedBaseline(root, selected);
    assert.deepEqual(actual, expected);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].candidate, join(await realpath(root), selected.releasedBaselinePath));
    assert.equal(calls[0].maxBytes, 32 * 1024 * 1024);
    assert.equal(calls[0].root, await realpath(root));
  });
});

for (const [failure, suffix] of [
  ["escape", "ESCAPE"],
  ["symlink", "SYMLINK_PROHIBITED"],
  ["invalid", "INVALID"],
  ["changed", "UNAVAILABLE"],
  ["missing", "UNAVAILABLE"],
  ["unavailable", "UNAVAILABLE"],
]) {
  test(`Public API evidence port preserves ${failure} diagnostics`, async () => {
    await withPublicApiFixture(async (root) => {
      const files = {
        async read() {
          throw new ContainedFileReadError(failure);
        },
      };
      const repository = new FilesystemPublicApiRepository(assertSchema, { ...defaults, files });
      await assert.rejects(
        repository.readReleasedBaseline(root, await existingPolicy(root)),
        ({ problem }) =>
          problem?.code === `PUBLIC_API_EVIDENCE_${suffix}` &&
          problem.phase === "public-api-evidence" &&
          problem.retryable === false,
      );
    });
  });
}

test("Public API baseline bootstrap alone accepts missing evidence", async () => {
  await withPublicApiFixture(async (root) => {
    const files = {
      async read() {
        throw new ContainedFileReadError("missing");
      },
    };
    const repository = new FilesystemPublicApiRepository(assertSchema, { ...defaults, files });
    assert.equal(
      await repository.readReleasedBaseline(
        root,
        await existingPolicy(root),
        undefined,
        "release-promotion",
      ),
      undefined,
    );
  });
});

test("Public API extraction uses the selected source reader without fallback", async () => {
  await withPublicApiFixture(async (root) => {
    const failure = new Error("selected extraction reader failed");
    const files = {
      async read() {
        throw failure;
      },
    };
    await assert.rejects(
      new TypeScriptPublicApiExtractor({ ...defaults, files }).extract(
        root,
        await existingPolicy(root),
        "1.2.3",
      ),
      (error) => error === failure,
    );
  });
});

test("Public API staging preserves Uint8Array bytes and read limits", async () => {
  await withPublicApiFixture(async (root) => {
    const calls = [];
    const files = {
      async read(input) {
        calls.push(input);
        return new Uint8Array(await defaults.files.read(input));
      },
    };
    const staged = await stagePackageSnapshot(
      { root, policy: await existingPolicy(root) },
      { ...defaults, files },
    );
    try {
      assert.ok(calls.length > 0);
      assert.ok(calls.every((input) => input.root === root && input.maxBytes === 32 * 1024 * 1024));
      assert.deepEqual(
        await readFile(join(staged.packageRoot, "dist/index.d.ts")),
        await readFile(join(root, "packages/library/dist/index.d.ts")),
      );
    } finally {
      await rm(staged.stagingRoot, { recursive: true, force: true });
    }
  });
});

test("Public API staging excludes the generated runtime-profile projection", async () => {
  await withPublicApiFixture(async (root) => {
    const { mkdir: makeDirectory } = await import("node:fs/promises");
    await makeDirectory(join(root, ".worker-tmp/profiles/node-source-sha/src"), {
      recursive: true,
    });
    await writeFile(
      join(root, ".worker-tmp/profiles/node-source-sha/src/duplicate.ts"),
      "export const duplicate = 1;\n",
    );
    await writeFile(join(root, ".worker-tmp/installed-dependencies.json"), "{}\n");
    const staged = await stagePackageSnapshot(
      { root, policy: await existingPolicy(root) },
      defaults,
    );
    try {
      await assert.rejects(
        stat(join(staged.stagingRoot, ".worker-tmp")),
        (error) => error.code === "ENOENT",
      );
    } finally {
      await rm(staged.stagingRoot, { recursive: true, force: true });
    }
  });
});

for (const target of ["baseline", "staging"]) {
  test(`Public API ${target} cannot bypass the selected reader byte limit`, async () => {
    await withPublicApiFixture(async (root) => {
      const files = {
        async read(input) {
          return new Uint8Array(input.maxBytes + 1);
        },
      };
      const selected = await existingPolicy(root);
      const actual =
        target === "baseline"
          ? new FilesystemPublicApiRepository(assertSchema, {
              ...defaults,
              files,
            }).readReleasedBaseline(root, selected)
          : stagePackageSnapshot({ root, policy: selected }, { ...defaults, files }).then(
              async (staged) => {
                await rm(staged.stagingRoot, { recursive: true, force: true });
                return null;
              },
            );
      await assert.rejects(
        actual,
        ({ problem }) =>
          problem?.code ===
          (target === "baseline" ? "PUBLIC_API_EVIDENCE_INVALID" : "PUBLIC_API_PATH_INVALID"),
      );
    });
  });
}

test("Changeset YAML uses the explicit parser and propagates its rejection", async () => {
  await withPublicApiFixture(async (root) => {
    await writeFile(
      join(root, ".changeset/selected.md"),
      '---\n"@fixture/public-api": patch\n---\n\nChange\n',
    );
    const failure = new Error("selected YAML parser failed"),
      calls = [];
    const parseYaml = (...args) => {
      calls.push(args);
      throw failure;
    };
    const repository = new FilesystemPublicApiRepository(assertSchema, { ...defaults, parseYaml });
    await assert.rejects(
      repository.readReleaseEvidence(root, ".changeset", await existingPolicy(root)),
      (error) => error === failure,
    );
    assert.deepEqual(calls, [['"@fixture/public-api": patch', "public-api-changeset"]]);
  });
});

test("Public API write path uses the selected symlink observation before effects", async () => {
  await withPublicApiFixture(async (root) => {
    const selected = await existingPolicy(root),
      baselinePath = join(root, selected.releasedBaselinePath);
    const before = await readFile(baselinePath),
      calls = [];
    const paths = {
      async traversesSymbolicLink(...args) {
        calls.push(args);
        return true;
      },
    };
    const repository = new FilesystemPublicApiRepository(assertSchema, { ...defaults, paths });
    await repository.readReleasedBaseline(root, selected);
    await assert.rejects(
      repository.writeReleasedBaseline(root, selected, {}),
      ({ problem }) => problem?.code === "PUBLIC_API_EVIDENCE_SYMLINK_PROHIBITED",
    );
    assert.deepEqual(calls, [[await realpath(root), await realpath(baselinePath)]]);
    assert.deepEqual(await readFile(baselinePath), before);
  });
});

for (const [winner, rejected] of [
  ["first", "second"],
  ["second", "first"],
]) {
  test(`Public API baseline promotion preserves the ${winner} concurrent winner and rejects the ${rejected} stale plan`, async () => {
    await withPublicApiFixture(async (root) => {
      const selected = await existingPolicy(root);
      const baselinePath = join(root, selected.releasedBaselinePath);
      let releaseComparison;
      let reportComparison;
      const comparisonGate = new Promise((resolve) => {
        releaseComparison = resolve;
      });
      const comparisonObserved = new Promise((resolve) => {
        reportComparison = resolve;
      });
      let reads = 0;
      const pausingFiles = {
        async read(input) {
          const bytes = await defaults.files.read(input);
          reads += 1;
          if (reads === 2) {
            reportComparison();
            await comparisonGate;
          }
          return bytes;
        },
      };
      const leading = new FilesystemPublicApiRepository(assertSchema, {
        ...defaults,
        files: pausingFiles,
      });
      const trailing = new FilesystemPublicApiRepository(assertSchema, defaults);
      const [observed] = await Promise.all([
        leading.readReleasedBaseline(root, selected),
        trailing.readReleasedBaseline(root, selected),
      ]);
      const winningSnapshot = { ...observed, extractorVersion: `writer-${winner}` };
      const rejectedSnapshot = { ...observed, extractorVersion: `writer-${rejected}` };
      const winningWrite = leading.writeReleasedBaseline(root, selected, winningSnapshot);
      await comparisonObserved;
      const rejectedWrite = trailing.writeReleasedBaseline(root, selected, rejectedSnapshot);
      let concurrentFailure;
      try {
        concurrentFailure = await rejectedWrite.then(
          () => null,
          (error) => error,
        );
      } finally {
        releaseComparison();
      }
      await winningWrite;
      assert.equal(
        concurrentFailure?.problem?.code,
        "PUBLIC_API_BASELINE_PROMOTION_LOCK_UNAVAILABLE",
      );
      await assert.rejects(
        trailing.writeReleasedBaseline(root, selected, rejectedSnapshot),
        ({ problem }) => problem?.code === "PUBLIC_API_BASELINE_PROMOTION_STALE",
      );
      assert.equal(
        await readFile(baselinePath, "utf8"),
        `${JSON.stringify(winningSnapshot, null, 2)}\n`,
      );
      assert.notEqual(
        await readFile(baselinePath, "utf8"),
        `${JSON.stringify(rejectedSnapshot, null, 2)}\n`,
      );
      assert.equal(
        (await readDirectory(dirname(baselinePath))).some(
          (entry) =>
            entry.startsWith(".public-api-baseline-") || entry === `${basename(baselinePath)}.lock`,
        ),
        false,
      );
    });
  });
}

test("Public API cancellation precedes selected evidence ports", async () => {
  await withPublicApiFixture(async (root) => {
    const selected = await existingPolicy(root),
      calls = [];
    const evidence = {
      ...defaults,
      files: {
        async read() {
          calls.push("read");
          throw new Error("unexpected read");
        },
      },
    };
    for (const operation of [
      new FilesystemPublicApiRepository(assertSchema, evidence).readReleasedBaseline(
        root,
        selected,
        AbortSignal.abort(),
      ),
      new TypeScriptPublicApiExtractor(evidence).extract(
        root,
        selected,
        "1.2.3",
        AbortSignal.abort(),
      ),
    ]) {
      await assert.rejects(operation, ({ problem }) => problem?.code === "EXECUTION_CANCELLED");
    }
    assert.deepEqual(calls, []);
  });
});

for (const oversized of [false, true]) {
  test(`Changesets prerelease evidence preserves the selected reader and its limit (${oversized})`, async () => {
    await withPublicApiFixture(async (root) => {
      const calls = [];
      const files = {
        async read(input) {
          calls.push(input);
          if (basename(input.candidate) === "pre.json") {
            return oversized
              ? new Uint8Array(input.maxBytes + 1)
              : new TextEncoder().encode(
                  JSON.stringify({
                    mode: "pre",
                    tag: "next",
                    initialVersions: { "@fixture/public-api": "1.2.3" },
                  }),
                );
          }
          return defaults.files.read(input);
        },
      };
      const operation = new FilesystemPublicApiRepository(assertSchema, {
        ...defaults,
        files,
      }).readReleaseEvidence(root, ".changeset", await existingPolicy(root));
      if (oversized) {
        await assert.rejects(
          operation,
          ({ problem }) => problem?.code === "CHANGESET_PRERELEASE_STATE_INVALID",
        );
      } else {
        const result = await operation;
        assert.equal(result.prereleaseTag, "next");
        assert.equal(result.prereleaseInitialVersion, "1.2.3");
      }
      assert.equal(
        calls.find((input) => basename(input.candidate) === "pre.json").maxBytes,
        1024 * 1024,
      );
    });
  });
}

test("Public API baseline preserves unknown selected-reader failure identity", async () => {
  await withPublicApiFixture(async (root) => {
    const failure = new Error("selected baseline failed"),
      files = {
        async read() {
          throw failure;
        },
      };
    const repository = new FilesystemPublicApiRepository(assertSchema, { ...defaults, files });
    await assert.rejects(
      repository.readReleasedBaseline(root, await existingPolicy(root)),
      (error) => error === failure,
    );
  });
});

test("audit pinned SDK has exact disjoint ownership and opaque loads elsewhere remain rejected", async () => {
  const { OxcSourceDependencyParser } =
    await import("../packages/engineering-foundation/dist/capabilities/source-dependencies/adapters/outbound/oxc/oxc-source-dependency-parser.js");
  const { readSourceArchitectureHeader, parseSourceArchitecturePolicy } =
    await import("../packages/engineering-foundation/dist/capabilities/source-dependencies/adapters/inbound/configuration/parse-capability-config.js");
  const { evaluateSourceDependencies } =
    await import("../packages/engineering-foundation/dist/capabilities/source-dependencies/application/policies/evaluate-source-dependencies.js");
  const { readdir } = await import("node:fs/promises");
  const root = "packages/engineering-foundation/src/capabilities/public-api-compatibility/adapters";
  const path = `${root}/outbound/api-extractor/load-pinned-audit-sdk.ts`;
  // The actual parser validates the complete v2 configuration, including overlaps.
  const architecturePolicy = parseSourceArchitecturePolicy(
    readSourceArchitectureHeader(
      readArchitectureYaml(
        await readFile("architecture/foundation/source-dependencies.yaml", "utf8"),
      ),
    ),
  );
  const owner = (file) =>
    architecturePolicy.boundaries.filter((boundary) =>
      boundary.roots.some((directory) => file === directory || file.startsWith(`${directory}/`)),
    );
  const loader = owner(path);
  assert.equal(loader.length, 1);
  assert.equal(loader[0].id, "capability.public-api-compatibility.pinned-sdk-loader");
  assert.deepEqual(loader[0].roots, [path]);
  assert.deepEqual(loader[0].entrypoints, [path]);
  assert.deepEqual(loader[0].allowedRuntimeReferences, []);
  const files = (await readdir(root, { recursive: true }))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => `${root}/${file.split(sep).join("/")}`);
  assert.ok(files.length > 10);
  for (const file of files) {
    assert.equal(owner(file).length, 1, file);
    if (file !== path) {
      assert.deepEqual(owner(file)[0].allowedRuntimeReferences, [], file);
    }
  }
  const parser = new OxcSourceDependencyParser();
  const parsed = parser.parse({ path, source: await readFile(path, "utf8") });
  assert.equal(parsed.parseErrorCount, 0);
  assert.deepEqual(parsed.unresolved, []);
  const evaluate = (file, references) =>
    evaluateSourceDependencies({
      policy: {
        ...architecturePolicy,
        boundaries: architecturePolicy.boundaries.map((boundary) => ({
          ...boundary,
          entrypoints: [],
        })),
      },
      graph: {
        nodes: [],
        edges: [],
        parseFailures: [],
        unclassifiedSourcePaths: [],
        unresolvedRuntimeReferences: references.map((reference) => ({
          ...reference,
          path: file,
          boundaryId: owner(file)[0].id,
        })),
      },
    });
  assert.deepEqual(evaluate(path, parsed.unresolved), []);
  const source =
    'import { createRequire } from "node:module"; const load = createRequire("/opaque/sdk.cjs"); load("typescript");';
  for (const file of files) {
    const witness = parser.parse({ path: file, source });
    assert.equal(witness.unresolved.length, 1);
    const rejected = evaluate(file, witness.unresolved);
    assert.equal(rejected.length, 1, file);
    assert.match(rejected[0].message, /Non-literal commonjs reference/);
  }
});

// Focused S1 observation cases; retained under the existing public API test owner.
{
  const { createHash } = await import("node:crypto");

  const { growthDimensions } =
    await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-observation.js");
  const { growthObservationDigest, normalizeGrowthObservation } =
    await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js");
  const digest = `sha256:${"a".repeat(64)}`;
  const fingerprint = {
    sha256(value) {
      return createHash("sha256").update(value).digest("hex");
    },
  };
  function observation() {
    return {
      contractRevision: "foundation:sdk-growth:c0:5",
      observationVersion: "foundation:sdk-growth:observation:1",
      repository: "fixture",
      sourceCommit: "a".repeat(40),
      sourceTree: "b".repeat(40),
      topologyDigest: digest,
      lockDigest: digest,
      toolchainDigest: digest,
      artifactDigests: [digest],
      tool: { version: "1", artifactDigest: digest, extractorVersion: "pinned" },
      coverage: [
        {
          packageName: "fixture",
          classification: "governed",
          dimensions: growthDimensions.map((dimension) => ({
            dimension,
            status: "unavailable",
            reasons: ["unobserved"],
          })),
        },
      ],
      entries: [
        {
          coordinate: {
            packageName: "fixture",
            exportPath: ".",
            resolutionBranch: [{ condition: "import" }, { index: 0 }],
            subject: { kind: "typed", canonicalReference: "opaque" },
          },
          value: { state: "present", digest },
        },
      ],
    };
  }
  test("S1: normalizes set order without mutating input or semantic sequences", () => {
    const original = observation();
    const changed = {
      ...original,
      coverage: original.coverage.map((row) => ({
        ...row,
        dimensions: row.dimensions.toReversed(),
      })),
    };
    assert.equal(
      growthObservationDigest(original, fingerprint),
      growthObservationDigest(changed, fingerprint),
    );
    assert.deepEqual(
      normalizeGrowthObservation(original).entries[0].coordinate.resolutionBranch,
      original.entries[0].coordinate.resolutionBranch,
    );
    const reversed = observation();
    reversed.entries[0].coordinate.resolutionBranch.reverse();
    assert.notEqual(
      growthObservationDigest(original, fingerprint),
      growthObservationDigest(reversed, fingerprint),
    );
  });
  test("S1: rejects identical duplicate coordinates, dimensions, reasons and artifacts", () => {
    for (const alter of [
      (value) => value.entries.push(value.entries[0]),
      (value) => value.coverage[0].dimensions.push(value.coverage[0].dimensions[0]),
      (value) => value.coverage[0].dimensions[0].reasons.push("unobserved"),
      (value) => value.artifactDigests.push(digest),
    ]) {
      const value = observation();
      alter(value);
      assert.throws(
        () => growthObservationDigest(value, fingerprint),
        /duplicate-growth-collection-key/u,
      );
    }
  });
  test("S1: rejects missing coverage and S1 decision authority", () => {
    const missing = observation();
    missing.coverage[0].dimensions.pop();
    assert.throws(
      () => normalizeGrowthObservation(missing),
      /incomplete-growth-coverage-structure/u,
    );
    const active = observation();
    active.coverage[0].dimensions.find((row) => row.dimension === "decision").status = "complete";
    assert.throws(() => normalizeGrowthObservation(active), /s1-decision-evidence-unavailable/u);
  });
  test("S1: rejects malformed identity and package scope", () => {
    assert.throws(
      () => normalizeGrowthObservation({ ...observation(), sourceTree: "not-a-tree" }),
      /invalid-growth-source-identity/u,
    );
    const value = observation();
    value.entries[0].coordinate.packageName = "other";
    assert.throws(
      () => normalizeGrowthObservation(value),
      /growth-entry-package-outside-topology/u,
    );
  });
  test("S1: closed observation shapes reject extra fields and ambiguous union branches", () => {
    for (const alter of [
      (value) => {
        value.surfaceDigest = digest;
      },
      (value) => {
        value.tool.extra = "authority";
      },
      (value) => {
        value.entries[0].coordinate.resolutionBranch[0].index = 0;
      },
      (value) => {
        value.entries[0].value.state = "missing";
      },
      (value) => {
        value.coverage[0].classification = "excluded";
      },
      (value) => {
        value.coverage[0].dimensions[0].status = "trusted";
      },
    ]) {
      const value = observation();
      alter(value);
      assert.throws(() => normalizeGrowthObservation(value), /invalid-growth-observation-shape/u);
    }
  });
  test("S1: binary ordering retains supplementary Unicode order and rejects uncanonical text without normalizing", () => {
    const value = observation();
    const original = value.entries[0];
    value.entries = ["\uE000", "\u{10000}"].map((canonicalReference) => ({
      ...original,
      coordinate: { ...original.coordinate, subject: { kind: "typed", canonicalReference } },
    }));
    assert.deepEqual(
      normalizeGrowthObservation(value).entries.map(
        (row) => row.coordinate.subject.canonicalReference,
      ),
      ["\u{10000}", "\uE000"],
    );
    value.entries[0].coordinate.subject.canonicalReference = "e\u0301";
    assert.throws(
      () => growthObservationDigest(value, fingerprint),
      /growth-canonical-value-unsupported/u,
    );
  });
  test("S1: observation digest matches the frozen-domain canonical UTF-8 vector without newline", () => {
    assert.equal(
      growthObservationDigest(observation(), fingerprint),
      "sha256:db6131b2fc0a3937c8d19ac60c348c38455734f3adc96565055f09b85e44e0ce",
    );
  });
}

await import("./public-api-growth-retention-cases.ts");

await import("./public-api-growth-observation-cases.ts");

await import("./public-api-growth-native-adapters.ts");

test("S1: growth policy and adapter reject direct workspace inventory dependencies", async () => {
  const { readSourceArchitectureHeader, parseSourceArchitecturePolicy } =
    await import("../packages/engineering-foundation/dist/capabilities/source-dependencies/adapters/inbound/configuration/parse-capability-config.js");
  const { evaluateResolvedSourceDependency } =
    await import("../packages/engineering-foundation/dist/capabilities/source-dependencies/application/policies/evaluate-resolved-source-dependency.js");
  const policy = parseSourceArchitecturePolicy(
    readSourceArchitectureHeader(
      readArchitectureYaml(
        await readFile("architecture/foundation/source-dependencies.yaml", "utf8"),
      ),
    ),
  );
  const boundariesById = new Map(policy.boundaries.map((row) => [row.id, row]));
  const root = "packages/engineering-foundation/src/capabilities/public-api-compatibility";
  const adapter = `${root}/adapters/outbound/filesystem/workspace-growth-reader.ts`;
  for (const path of [
    adapter,
    `${root}/application/policies/project-growth-package.ts`,
    `${root}/application/policies/project-growth-resolution.ts`,
    `${root}/application/use-cases/observe-sdk-growth.ts`,
  ]) {
    const owners = policy.boundaries.filter((row) =>
      row.roots.some((dir) => path === dir || path.startsWith(`${dir}/`)),
    );
    assert.equal(owners.length, 1);
    const diagnostics = evaluateResolvedSourceDependency({
      policy,
      boundariesById,
      developmentBoundariesByPackage: new Map(),
      edge: {
        fromPath: path,
        fromBoundaryId: owners[0].id,
        fromWorkspacePackageName: "foundation",
        mode: "type-only",
        specifier: "workspace-inventory/api.js",
        resolution: {
          kind: "local-file",
          workspacePackageName: "foundation",
          path: "packages/engineering-foundation/src/workspace-inventory/api.ts",
          targetBoundaryId: "foundation.workspace-inventory.application",
        },
      },
    });
    assert.deepEqual(
      diagnostics.map((row) => row.ruleId),
      ["architecture.source-dependencies.forbidden-boundary-dependency"],
    );
  }
});

test("S1: growth workspace mapping preserves signal, ordered targets and failure identity", async () => {
  const signal = new AbortController().signal;
  const target = { import: [null, "./index.js"], default: "./fallback.js" };
  const reader = createWorkspaceGrowthReader({
    async read(root, manifest, received) {
      assert.deepEqual([root, manifest, received], ["root", "workspace", signal]);
      return {
        packages: [
          {
            name: "fixture",
            rootPath: "package",
            manifestPath: "package/package.json",
            moduleType: "module",
            exportSurface: { explicit: true, entries: [{ subpath: ".", target }] },
          },
        ],
      };
    },
  });
  const result = await reader.read("root", "workspace", signal);
  const mapped = result.packages[0].exportSurface.entries[0].target;
  assert.deepEqual(mapped, target);
  assert.notEqual(mapped, target);
  assert.deepEqual(Object.keys(mapped), ["import", "default"]);
  const failure = new Error("cancelled");
  await assert.rejects(
    createWorkspaceGrowthReader({
      async read() {
        throw failure;
      },
    }).read("root", "workspace", signal),
    (error) => error === failure,
  );
});

test("S1: wildcard contract rejects multiple occurrences in export and target patterns", async () => {
  const { observedPackageExports } =
    await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-package-export-coverage.js");
  for (const [subpath, target] of [
    ["./*/*", "./schemas/*"],
    ["./schemas/*", "./*/*"],
  ]) {
    assert.throws(
      () =>
        observedPackageExports({
          manifest: { exports: { [subpath]: target } },
          policy: { packageName: "fixture", packageRoot: "package" },
        }),
      /one \*/u,
    );
  }
});

test("S1: local canonical serialization rejects non-data containers without invoking getters", async () => {
  const { growthCanonicalJson } =
    await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js");
  const cycle = {};
  cycle.self = cycle;
  const sparse = [];
  sparse.length = 2;
  const getter = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      throw new Error("getter executed");
    },
  });
  for (const value of [
    cycle,
    getter,
    sparse,
    Object.assign([1], { extra: 2 }),
    { [Symbol("key")]: 1 },
    new Date(),
    { value: undefined },
    1.5,
    Infinity,
  ]) {
    assert.throws(() => growthCanonicalJson(value), /growth-canonical-value-unsupported/u);
  }
  assert.equal(
    growthCanonicalJson({ z: [null, true, -2], a: "$&" }),
    '{"a":"$&","z":[null,true,-2]}',
  );
});

registerGrowthAdmissionCases();
