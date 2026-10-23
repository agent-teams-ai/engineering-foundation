import type {
  PublicApiSnapshot,
  PublicApiArtifactSnapshot,
  PublicApiPackagePolicy,
} from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api.js";
import type { GrowthEvidence } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-observation.js";
import type { MutableFixture } from "./support/growth-authority-test-ports.ts";
function available<T>(evidence: GrowthEvidence<T>): T {
  assert.equal(evidence.status, "available");
  return evidence.value;
}
import assert from "node:assert/strict";
import test from "node:test";
// Focused S1 observation cases; retained under the existing public API test owner.
{
  const { retainGrowthCompatibility } =
    await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/retain-growth-compatibility.js");

  const policy: PublicApiPackagePolicy = {
    packageName: "fixture",
    packageRoot: ".",
    manifestPath: "package.json",
    tsconfigPath: "tsconfig.json",
    releasedBaselinePath: "unused.json",
    approvedBreakingChanges: [],
    entrypoints: [],
    nonTypeExports: [],
  };
  const typed: MutableFixture<PublicApiSnapshot> = {
    schemaVersion: 1,
    packageName: "fixture",
    packageVersion: "1.0.0",
    extractorVersion: "pinned",
    entrypoints: [
      {
        exportPath: ".",
        items: [
          {
            canonicalReference: "opaque",
            kind: "Function",
            parentKind: "EntryPoint",
            signature: " exact\nbytes ",
          },
          {
            canonicalReference: "empty-parent",
            kind: "Function",
            parentKind: "EntryPoint",
            parentReference: "",
            signature: "x",
          },
        ],
      },
    ],
  };
  const artifact: PublicApiArtifactSnapshot = {
    status: "release-candidate",
    schemaVersion: 1,
    packageName: "fixture",
    packageVersion: "1.0.0",
    wildcardExports: [],
    jsonSchemas: [],
  };
  function input(
    subjects?: Parameters<typeof retainGrowthCompatibility>[0]["subjects"],
  ): Parameters<typeof retainGrowthCompatibility>[0] {
    return {
      consumerRoot: "/unused",
      subjects: subjects ?? [{ policy, packageVersion: "1.0.0" }],
      extractorVersion: "pinned",
      cancellation: { throwIfCancelled() {} },
    };
  }
  function ports(
    overrides: Partial<Parameters<typeof retainGrowthCompatibility>[1]> = {},
  ): Parameters<typeof retainGrowthCompatibility>[1] {
    return {
      typed: {
        async extract() {
          return typed;
        },
      },
      artifact: {
        async inspect() {
          return [artifact];
        },
      },
      ...overrides,
    };
  }
  void test("S1: retains separate lossless v1 branches and invokes each observer once", async () => {
    let typedCalls = 0;
    let artifactCalls = 0;
    const rows = await retainGrowthCompatibility(
      input(),
      ports({
        typed: {
          async extract() {
            typedCalls++;
            return typed;
          },
        },
        artifact: {
          async inspect() {
            artifactCalls++;
            return [artifact];
          },
        },
      }),
    );
    assert.equal(typedCalls, 1);
    assert.equal(artifactCalls, 1);
    assert.deepEqual(rows[0].compatibility.typed, {
      kind: "typed",
      snapshot: { status: "available", value: typed },
    });
    assert.equal(
      Object.hasOwn(
        available(rows[0].compatibility.typed.snapshot).entrypoints[0].items[0],
        "parentReference",
      ),
      false,
    );
    assert.equal(
      available(rows[0].compatibility.typed.snapshot).entrypoints[0].items[1].parentReference,
      "",
    );
    assert.equal(
      available(rows[0].compatibility.artifact.snapshot).extractorVersion,
      "package-artifact-inventory/1",
    );
    assert.deepEqual(available(rows[0].compatibility.artifact.snapshot).entrypoints, []);
  });
  void test("S1: rejects duplicate packages before either observer runs", async () => {
    const subject = input().subjects[0];
    await assert.rejects(
      retainGrowthCompatibility(input([subject, subject]), ports()),
      /duplicate-compatibility-package/u,
    );
  });
  void test("S1: rejects cross-branch provenance and missing artifact rows", async () => {
    await assert.rejects(
      retainGrowthCompatibility(
        input(),
        ports({
          typed: {
            async extract() {
              return { ...typed, extractorVersion: "package-artifact-inventory/1" };
            },
          },
        }),
      ),
      /typed-observer-provenance-mismatch/u,
    );
    await assert.rejects(
      retainGrowthCompatibility(
        input(),
        ports({
          artifact: {
            async inspect() {
              return [];
            },
          },
        }),
      ),
      /artifact-observer-provenance-mismatch/u,
    );
  });
  void test("S1: retains independent branch failure with stable reasons", async () => {
    const result = await retainGrowthCompatibility(
      input(),
      ports({
        typed: {
          async extract() {
            throw new Error("random temporary path");
          },
        },
      }),
    );
    assert.deepEqual(result[0].compatibility.typed.snapshot, {
      status: "unavailable",
      reasons: ["typed-observation-unavailable"],
    });
    assert.equal(result[0].compatibility.artifact.snapshot.status, "available");
  });
  void test("S1: propagates cancellation after an observer throws", async () => {
    let cancelled = false;
    const request = {
      ...input(),
      cancellation: {
        throwIfCancelled() {
          if (cancelled) {
            throw new Error("cancelled");
          }
        },
      },
    };
    await assert.rejects(
      retainGrowthCompatibility(
        request,
        ports({
          typed: {
            async extract() {
              cancelled = true;
              throw new Error("io");
            },
          },
        }),
      ),
      /cancelled/u,
    );
  });
  void test("S1: retained snapshots keep unchanged v1 comparator fingerprints independently", async () => {
    const { classifyPublicApiChange } =
      await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/evaluate-public-api-compatibility.js");
    const { artifactApiProjection } =
      await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/artifact-api-projection.js");
    const { createHash } = await import("node:crypto");
    const fingerprint = {
      sha256(value: string) {
        return createHash("sha256").update(value).digest("hex");
      },
    };
    const beforeTyped = structuredClone(typed);
    beforeTyped.entrypoints[0].items[0].signature = "old signature";
    const beforeArtifact = {
      ...artifact,
      wildcardExports: [
        { exportPath: "./schemas/*", targetPattern: "schemas/*", members: ["schemas/old.json"] },
      ],
    };
    const [row] = await retainGrowthCompatibility(input(), ports());
    assert.deepEqual(
      classifyPublicApiChange(
        beforeTyped,
        available(row.compatibility.typed.snapshot),
        fingerprint,
      ),
      classifyPublicApiChange(beforeTyped, typed, fingerprint),
    );
    assert.deepEqual(
      classifyPublicApiChange(
        artifactApiProjection(beforeArtifact),
        available(row.compatibility.artifact.snapshot),
        fingerprint,
      ),
      classifyPublicApiChange(
        artifactApiProjection(beforeArtifact),
        artifactApiProjection(artifact),
        fingerprint,
      ),
    );
  });
  void test("S1: later artifact observation cannot mutate retained typed evidence", async () => {
    const mutable = structuredClone(typed);
    const [row] = await retainGrowthCompatibility(
      input(),
      ports({
        typed: {
          async extract() {
            return mutable;
          },
        },
        artifact: {
          async inspect() {
            mutable.entrypoints[0].items[0].signature = "mutated";
            return [artifact];
          },
        },
      }),
    );
    assert.equal(
      available(row.compatibility.typed.snapshot).entrypoints[0].items[0].signature,
      typed.entrypoints[0].items[0].signature,
    );
  });
}
