import assert from "node:assert/strict";
import test from "node:test";

import { promotePublicApiBaselines } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/promote-public-api-baselines.js";

test("rejects public API drift after a package version was already promoted", async () => {
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
