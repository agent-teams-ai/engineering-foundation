import assert from "node:assert/strict";
import test from "node:test";

import { promotePublicApiBaselines } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/promote-public-api-baselines.js";

const packagePolicy = {
  packageName: "@fixture/library",
  packageRoot: "packages/library",
  manifestPath: "packages/library/package.json",
  entrypoints: [
    {
      exportPath: ".",
      declarationEntryPoint: "packages/library/dist/index.d.ts",
    },
  ],
  nonTypeExports: [],
  tsconfigPath: "packages/library/tsconfig.json",
  releasedBaselinePath: "architecture/public-api/library.json",
  approvedBreakingChanges: [],
};

function bootstrapDependencies(releaseEvidence, writes = []) {
  return {
    extractor: {
      async extract(_consumerRoot, policy, packageVersion) {
        return {
          schemaVersion: 1,
          packageName: policy.packageName,
          packageVersion,
          extractorVersion: "7.58.12",
          entrypoints: [{ exportPath: ".", items: [] }],
        };
      },
    },
    fingerprint: { sha256: () => "a".repeat(64) },
    repository: {
      async readReleasedBaseline() {
        // The missing value models an absent release-owned baseline.
      },
      async readReleaseEvidence() {
        return releaseEvidence;
      },
      async writeReleasedBaseline(...args) {
        writes.push(args);
      },
    },
    acceptedDecisionEvidence: {
      async readAcceptedDecisionEvidence() {
        return { acceptedDecisionIds: [], acceptedDecisionPaths: [] };
      },
    },
  };
}

const bootstrapInput = {
  consumerRoot: "/fixture",
  policy: {
    schemaVersion: 1,
    acceptedDecisionBaselinePath: "architecture/decisions/accepted-decisions.json",
    changesetDirectory: ".changeset",
    packages: [packagePolicy],
  },
};

test("bootstraps an absent baseline only for a reviewed initial unreleased package", async () => {
  const writes = [];
  const promoted = await promotePublicApiBaselines(
    bootstrapInput,
    bootstrapDependencies(
      {
        packageName: packagePolicy.packageName,
        packageVersion: "0.0.0",
        declaredBump: "minor",
      },
      writes,
    ),
  );

  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].packageName, packagePolicy.packageName);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][4], "create");
});

for (const [name, releaseEvidence, expectedCode] of [
  [
    "released package",
    { packageName: packagePolicy.packageName, packageVersion: "1.0.0", declaredBump: "major" },
    "PUBLIC_API_BASELINE_BOOTSTRAP_NOT_INITIAL",
  ],
  [
    "package without a Changeset",
    { packageName: packagePolicy.packageName, packageVersion: "0.0.0" },
    "PUBLIC_API_BASELINE_BOOTSTRAP_CHANGESET_MISSING",
  ],
  [
    "package with only a patch Changeset",
    { packageName: packagePolicy.packageName, packageVersion: "0.0.0", declaredBump: "patch" },
    "PUBLIC_API_BASELINE_BOOTSTRAP_CHANGESET_INSUFFICIENT",
  ],
]) {
  test(`rejects absent baseline bootstrap for a ${name}`, async () => {
    await assert.rejects(
      promotePublicApiBaselines(bootstrapInput, bootstrapDependencies(releaseEvidence)),
      (error) => error?.problem?.code === expectedCode,
    );
  });
}

test("rejects public API drift after a package version was already promoted", async () => {
  const writes = [];

  await assert.rejects(
    promotePublicApiBaselines(
      {
        consumerRoot: "/fixture",
        policy: {
          schemaVersion: 1,
          acceptedDecisionBaselinePath:
            "architecture/decisions/accepted-decisions.json",
          changesetDirectory: ".changeset",
          packages: [packagePolicy],
        },
      },
      {
        extractor: {
          async extract() {
            return {
              schemaVersion: 1,
              packageName: packagePolicy.packageName,
              packageVersion: "1.1.0",
              extractorVersion: "7.58.12",
              entrypoints: [
                {
                  exportPath: ".",
                  items: [
                    {
                      canonicalReference: "@fixture/api!added:function(1)",
                      kind: "Function",
                      parentKind: "EntryPoint",
                      signature: "export declare function added(): void;",
                    },
                  ],
                },
              ],
            };
          },
        },
        fingerprint: { sha256: () => "a".repeat(64) },
        repository: {
          async readReleasedBaseline() {
            return {
              schemaVersion: 1,
              packageName: packagePolicy.packageName,
              packageVersion: "1.1.0",
              extractorVersion: "7.58.12",
              entrypoints: [{ exportPath: ".", items: [] }],
            };
          },
          async readReleaseEvidence() {
            return {
              packageName: packagePolicy.packageName,
              packageVersion: "1.1.0",
            };
          },
          async writeReleasedBaseline(...args) {
            writes.push(args);
          },
        },
        acceptedDecisionEvidence: {
          async readAcceptedDecisionEvidence() {
            return { acceptedDecisionIds: [], acceptedDecisionPaths: [] };
          },
        },
      },
    ),
    (error) =>
      error?.problem?.code === "PUBLIC_API_BASELINE_PROMOTION_RELEASE_DRIFT",
  );
  assert.deepEqual(writes, []);
});
