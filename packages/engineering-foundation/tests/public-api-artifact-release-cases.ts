import type { AcceptedDecisionEvidence } from "../src/capabilities/public-api-compatibility/application/ports/accepted-decision-evidence.js";
import * as capturedByteCases from "./public-api-artifact-captured-byte-cases.ts";
void capturedByteCases;
import {
  evidence,
  assertSchema,
  fingerprint,
  inventory,
  packagePolicy as fixturePackagePolicy,
  policy as fixturePolicy,
  schema,
  json,
  fixture,
  inspect as fixtureInspect,
  fixate,
} from "./fixtures/public-api-artifact-fixture.mjs";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { comparePackageArtifactInventory } from "../dist/capabilities/public-api-compatibility/application/policies/compare-package-artifact-inventory.js";
import { readArtifactBaseline } from "../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-artifact-baseline.js";
import { ArtifactPublicApiEvidence } from "../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/artifact-public-api-evidence.js";
import { FilesystemPublicApiRepository } from "../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-public-api-repository.js";
import { analyzePublicApiCompatibility } from "../dist/capabilities/public-api-compatibility/application/use-cases/analyze-public-api-compatibility.js";
import { preflightPublicApiPromotions } from "../dist/capabilities/public-api-compatibility/application/use-cases/preflight-public-api-promotions.js";
import { promotePublicApiBaselines } from "../dist/capabilities/public-api-compatibility/application/use-cases/promote-public-api-baselines.js";

type Snapshot =
  import("../src/capabilities/public-api-compatibility/application/model/public-api.js").PublicApiArtifactSnapshot;
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
const packagePolicy =
  fixturePackagePolicy as import("../src/capabilities/public-api-compatibility/application/model/public-api.js").PublicApiPackagePolicy;
const policy =
  fixturePolicy as import("../src/capabilities/public-api-compatibility/application/model/public-api.js").PublicApiCompatibilityPolicy;
const inspect = fixtureInspect as (
  ...args: Parameters<typeof fixtureInspect>
) => Promise<Mutable<Snapshot>>;
function dependencies(current: Snapshot, accepted?: AcceptedDecisionEvidence) {
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
        if (accepted === undefined) {
          throw new Error("Unexpected approval-evidence read in this fixture");
        }
        return Promise.resolve(accepted);
      },
    },
  };
}

void test("artifact breaks use exact fingerprint plus accepted decision and sufficient version", async (t) => {
  const root = await fixture(t);
  const baseline = await inspect(root);
  await fixate(root, baseline);
  await json(root, "package/schemas/v1.schema.json", {
    ...schema,
    properties: { ...schema.properties, value: { type: "string", minLength: 3 } },
  });
  await json(root, "package/package.json", {
    name: packagePolicy.packageName,
    version: "2.0.0",
    exports: { "./schemas/*": "./schemas/*" },
  });
  const current = await inspect(root);
  const change = await comparePackageArtifactInventory(baseline, current, fingerprint);
  const approvedPolicy: typeof policy = {
    ...policy,
    governanceConfigPath: "architecture/foundation/governance.yaml",
    packages: [
      {
        ...packagePolicy,
        approvedBreakingChanges: [{ fingerprint: change.fingerprint!, decisionId: "ADR-0001" }],
      },
    ],
  };
  const input = { consumerRoot: root, policy: approvedPolicy };
  await assert.rejects(
    promotePublicApiBaselines(
      input,
      dependencies(current, { acceptedDecisionIds: [], acceptedDecisionPaths: [] }),
    ),
    (error: unknown) =>
      (error as { problem?: { code?: unknown } }).problem?.code ===
      "PUBLIC_API_BASELINE_PROMOTION_DECISION_NOT_ACCEPTED",
  );
  const acceptedEvidence: AcceptedDecisionEvidence = {
    acceptedDecisionIds: ["ADR-0001"],
    acceptedDecisionPaths: ["docs/decisions/0001-break.md"],
  };
  await promotePublicApiBaselines(input, dependencies(current, acceptedEvidence));
  assert.equal(
    (await readArtifactBaseline(root, packagePolicy, evidence))!.packageVersion,
    "2.0.0",
  );
  // The same approval does not cover another constraint change.
  await json(root, "package/schemas/v1.schema.json", {
    ...schema,
    properties: { ...schema.properties, value: { type: "string", minLength: 4 } },
  });
  assert.notEqual(
    (await comparePackageArtifactInventory(baseline, await inspect(root), fingerprint)).fingerprint,
    change.fingerprint,
  );
});

void test("wildcard JSON data and instance $schema hints are not schema definitions", async (t) => {
  const root = await fixture(t);
  await json(root, "package/schemas/data.json", [1, 2]);
  await json(root, "package/schemas/config.json", {
    $schema: "https://json.schemastore.org/tsconfig",
    compilerOptions: {},
  });
  const current = await inspect(root);
  assert.equal(current.wildcardExports[0]!.members.length, 3);
  assert.equal(current.jsonSchemas.length, 1);
});

void test("inventory object ordering does not change compatibility but schema byte ordering does", async (t) => {
  const root = await fixture(t);
  const definition = {
    ...schema,
    properties: { ...schema.properties, kind: { const: { name: "record", version: 1 } } },
  };
  await json(root, "package/schemas/v1.schema.json", definition);
  const current = await inspect(root);
  const baseline = structuredClone(current);
  baseline.jsonSchemas[0]!.discriminators = {
    schemaVersion: { const: 1 },
    kind: { const: { version: 1, name: "record" } },
  };
  await fixate(root, baseline);
  const released = (await readArtifactBaseline(root, packagePolicy, evidence))!;
  assert.deepEqual(released.jsonSchemas, current.jsonSchemas);
  assert.equal(
    (await comparePackageArtifactInventory(released, current, fingerprint)).classification,
    "none",
  );
  assert.deepEqual(
    await analyzePublicApiCompatibility({ consumerRoot: root, policy }, dependencies(current)),
    [],
  );
  await json(root, "package/schemas/v1.schema.json", {
    ...definition,
    properties: { ...definition.properties, kind: { const: { version: 1, name: "record" } } },
  });
  assert.equal(
    (await comparePackageArtifactInventory(released, await inspect(root), fingerprint))
      .classification,
    "breaking",
  );
});

void test("inventory rejects a new wildcard member or changed manifest after schema inspection", async (t) => {
  const { FilesystemPackageArtifactInventory } =
    await import("../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-package-artifact-inventory.js");
  const { AjvJsonSchemaReleaseInspector } =
    await import("../dist/capabilities/contract-json-schema-releases/module.js");
  for (const mutate of [
    (root: string) =>
      json(root, "package/schemas/v2.schema.json", {
        ...schema,
        $id: "https://fixture.test/record/v2",
      }),
    (root: string) =>
      json(root, "package/package.json", {
        name: packagePolicy.packageName,
        version: "1.3.0",
        exports: { "./schemas/*": "./schemas/*" },
      }),
  ]) {
    const root = await fixture(t);
    const racing = new FilesystemPackageArtifactInventory(
      {
        async inspect(input) {
          const result = await new AjvJsonSchemaReleaseInspector(evidence.files).inspect(input);
          await mutate(root);
          return result;
        },
      },
      evidence,
    );
    await assert.rejects(racing.inspect(root, [packagePolicy]), /changed/iu);
  }
});

void test("historical namespace artifacts cannot authorize supported compatibility or release promotion", async (t) => {
  const root = await fixture(t, "0.0.0");
  const current = await inspect(root);
  await json(root, "architecture/public-api/library.artifacts.json", {
    ...current,
    status: "historical-bootstrap",
  });
  await assert.rejects(
    analyzePublicApiCompatibility({ consumerRoot: root, policy }, dependencies(current)),
    /historical/iu,
  );
  await assert.rejects(
    promotePublicApiBaselines({ consumerRoot: root, policy }, dependencies(current)),
    /historical/iu,
  );
});

void test("artifact promotion preserves a baseline swapped after its release comparison", async (t) => {
  const root = await fixture(t);
  await fixate(root, await inspect(root));
  await json(root, "package/package.json", {
    name: packagePolicy.packageName,
    version: "1.3.0",
    exports: { "./schemas/*": "./schemas/*" },
  });
  const current = await inspect(root);
  const normal = dependencies(current);
  const swapped = { ...current, packageVersion: "9.0.0", status: "supported" };
  const racing = {
    ...normal,
    extractor: {
      async extract(...args: Parameters<typeof normal.extractor.extract>) {
        await json(root, "architecture/public-api/library.artifacts.json", swapped);
        return normal.extractor.extract(...args);
      },
    },
  };
  await assert.rejects(
    preflightPublicApiPromotions({ consumerRoot: root, policy }, [racing]),
    /changed|stale/iu,
  );
  assert.deepEqual((await readArtifactBaseline(root, packagePolicy, evidence))!, swapped);
});

void test("wildcard inventory rejects portable path aliases and device names", async (t) => {
  const root = await fixture(t);
  // Compatibility-distinct bytes coexist even on case-insensitive filesystems.
  await json(root, "package/schemas/V１.schema.json", {
    ...schema,
    $id: "https://fixture.test/alias/v1",
  });
  await assert.rejects(inspect(root), /alias|colli|portable/iu);
  await rm(join(root, "package/schemas/V１.schema.json"));
  await writeFile(join(root, "package/schemas/NUL.json"), "{}");
  await assert.rejects(inspect(root), /portable/iu);
});

void test("inventory bounds bytes and cancellation before returning artifact evidence", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "package/schemas/oversized.bin"), Buffer.alloc(32 * 1024 * 1024 + 1));
  await assert.rejects(inspect(root));
  await rm(join(root, "package/schemas/oversized.bin"));
  await assert.rejects(inventory.inspect(root, [packagePolicy], AbortSignal.abort()));
});

void test("independent surface versions finish an interrupted two-surface promotion", async (t) => {
  const firstRoot = await fixture(t);
  const secondRoot = await fixture(t);
  for (const root of [firstRoot, secondRoot]) {
    await fixate(root, await inspect(root));
    await json(root, "package/package.json", {
      name: packagePolicy.packageName,
      version: "1.3.0",
      exports: { "./schemas/*": "./schemas/*" },
    });
  }
  const first = dependencies(await inspect(firstRoot));
  const second = dependencies(await inspect(secondRoot));
  const secondRepository: import("../src/capabilities/public-api-compatibility/application/ports/public-api-repository.js").PublicApiRepository =
    {
      describeReleasedBaselineWrite: (
        _root: string,
        ...args: Parameters<typeof second.repository.describeReleasedBaselineWrite> extends [
          string,
          ...infer Rest,
        ]
          ? Rest
          : never
      ) => second.repository.describeReleasedBaselineWrite(secondRoot, ...args),
      readReleasedBaseline: ((
        _root: string,
        ...args: Parameters<typeof second.repository.readReleasedBaseline> extends [
          string,
          ...infer Rest,
        ]
          ? Rest
          : never
      ) =>
        second.repository.readReleasedBaseline(
          secondRoot,
          ...args,
        )) as typeof second.repository.readReleasedBaseline,
      readReleaseEvidence: (
        _root: string,
        ...args: Parameters<typeof second.repository.readReleaseEvidence> extends [
          string,
          ...infer Rest,
        ]
          ? Rest
          : never
      ) => second.repository.readReleaseEvidence(secondRoot, ...args),
      writeReleasedBaseline: (
        _root: string,
        ...args: Parameters<typeof second.repository.writeReleasedBaseline> extends [
          string,
          ...infer Rest,
        ]
          ? Rest
          : never
      ) => second.repository.writeReleasedBaseline(secondRoot, ...args),
    };
  const secondSurface = { ...second, repository: secondRepository };
  const interrupted = {
    ...secondSurface,
    repository: {
      ...secondRepository,
      writeReleasedBaseline() {
        throw new Error("simulated interruption after first surface");
      },
    },
  };
  const input = { consumerRoot: firstRoot, policy };
  await assert.rejects(preflightPublicApiPromotions(input, [first, interrupted]), /interruption/u);
  assert.equal(
    (await readArtifactBaseline(firstRoot, packagePolicy, evidence))!.packageVersion,
    "1.3.0",
  );
  assert.equal(
    (await readArtifactBaseline(secondRoot, packagePolicy, evidence))!.packageVersion,
    "1.2.0",
  );
  const firstBytes = await readFile(
    join(firstRoot, "architecture/public-api/library.artifacts.json"),
  );
  await preflightPublicApiPromotions(input, [first, secondSurface]);
  assert.deepEqual(
    await readFile(join(firstRoot, "architecture/public-api/library.artifacts.json")),
    firstBytes,
  );
  assert.equal(
    (await readArtifactBaseline(secondRoot, packagePolicy, evidence))!.packageVersion,
    "1.3.0",
  );
});

void test("oversized artifact record fails before replacing readable evidence", async (t) => {
  const root = await fixture(t);
  await fixate(root, await inspect(root));
  const path = join(root, "architecture/public-api/library.artifacts.json");
  const before = await readFile(path);
  const current = await inspect(root);
  const oversized = {
    ...current,
    jsonSchemas: [],
    wildcardExports: [
      {
        exportPath: "./schemas/*",
        targetPattern: "schemas/*",
        members: Array.from(
          { length: 12000 },
          (_, i) => `schemas/${"a".repeat(400)}/${String(i).padStart(5, "0")}.bin`,
        ),
      },
    ],
  };
  await assert.rejects(
    preflightPublicApiPromotions({ consumerRoot: root, policy }, [dependencies(oversized)]),
    /4 MiB/u,
  );
  assert.deepEqual(await readFile(path), before);
});

void test("supported same-version schema mutation cannot promote even with a Changeset", async (t) => {
  const root = await fixture(t);
  await fixate(root, await inspect(root));
  const path = join(root, "architecture/public-api/library.artifacts.json");
  const before = await readFile(path);
  await writeFile(
    join(root, ".changeset/change.md"),
    '---\n"@fixture/library": major\n---\n\nSchema change.\n',
  );
  await json(root, "package/schemas/v1.schema.json", { ...schema, minProperties: 2 });
  await assert.rejects(
    promotePublicApiBaselines({ consumerRoot: root, policy }, dependencies(await inspect(root))),
    (error: unknown) =>
      (error as { problem?: { code?: unknown } }).problem?.code ===
      "PUBLIC_API_BASELINE_PROMOTION_RELEASE_DRIFT",
  );
  assert.deepEqual(await readFile(path), before);
});
