import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  PublicApiCompatibilityPolicy,
  PublicApiItem,
  PublicApiSnapshot,
} from "../src/capabilities/public-api-compatibility/application/model/public-api.js";
import type { PublicApiSignatureEquivalence } from "../src/capabilities/public-api-compatibility/application/ports/public-api-signature-equivalence.js";
import { classifyPublicApiChange } from "../dist/capabilities/public-api-compatibility/application/policies/evaluate-public-api-compatibility.js";
import { promotePublicApiBaselines } from "../dist/capabilities/public-api-compatibility/application/use-cases/promote-public-api-baselines.js";
import { CapabilityInputError } from "../dist/features/validation-reporting/api.js";

const fingerprint = {
  sha256: (value: string) => createHash("sha256").update(value).digest("hex"),
};

function snapshot(valueType: "string" | "number", names = ["first", "second"]): PublicApiSnapshot {
  return {
    schemaVersion: 1,
    packageName: "async-proof-fixture",
    packageVersion: "1.0.0",
    extractorVersion: "fixture",
    entrypoints: [
      {
        exportPath: ".",
        items: names.map((name): PublicApiItem => ({
          canonicalReference: `async-proof-fixture!${name}:function(1)`,
          kind: "Function",
          parentKind: "EntryPoint",
          parentReference: "async-proof-fixture!",
          signature: `export declare function ${name}(value: ${valueType}): string;`,
        })),
      },
    ],
  };
}

function waitForEntry(work: Promise<unknown>, entry: PromiseWithResolvers<void>): Promise<void> {
  void work.then(
    () => entry.reject(new Error("Comparison completed before the expected proof request.")),
    (error: unknown) => entry.reject(error),
  );
  return entry.promise;
}

function registerSequentialProofCase(): void {
  void test("async signature comparisons await each proof in deterministic order", async () => {
    const before = snapshot("string");
    const after = snapshot("number");
    const first = Promise.withResolvers<boolean>();
    const second = Promise.withResolvers<boolean>();
    const firstEntered = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const calls: string[] = [];
    let active = 0;
    let maxInFlight = 0;
    const signatures: PublicApiSignatureEquivalence = {
      equivalent: async (released) => {
        calls.push(released.canonicalReference);
        active += 1;
        maxInFlight = Math.max(maxInFlight, active);
        const current = calls.length === 1 ? first : second;
        (calls.length === 1 ? firstEntered : secondEntered).resolve();
        try {
          return await current.promise;
        } finally {
          active -= 1;
        }
      },
    };
    const pending = classifyPublicApiChange(before, after, fingerprint, undefined, signatures);
    try {
      await waitForEntry(pending, firstEntered);
      assert.deepEqual(calls, ["async-proof-fixture!first:function(1)"]);
      assert.equal(active, 1);
      first.resolve(false);
      await waitForEntry(pending, secondEntered);
      assert.equal(maxInFlight, 1, "Logical SDK proofs must not overlap.");
      assert.deepEqual(calls, [
        "async-proof-fixture!first:function(1)",
        "async-proof-fixture!second:function(1)",
      ]);
      second.resolve(false);
      assert.deepEqual(await pending, await classifyPublicApiChange(before, after, fingerprint));
      assert.equal(active, 0);
      assert.equal(calls.length, 2, "Each eligible pair must be proved exactly once.");
    } finally {
      first.resolve(false);
      second.resolve(false);
      await pending.catch(() => {});
    }
  });
}

function registerProofRejectionCases(): void {
  void test("a rejected async proof cannot become an accepted classification", async () => {
    await assert.rejects(
      classifyPublicApiChange(snapshot("string"), snapshot("number"), fingerprint, undefined, {
        equivalent: async () => {
          throw new Error("proof rejected");
        },
      }),
      /proof rejected/u,
    );
  });
  void test("unchanged signatures do not acquire an async proof session", async () => {
    let acquired = 0;
    const before = snapshot("string");
    const change = await classifyPublicApiChange(before, before, fingerprint, undefined, {
      equivalent: async () => {
        acquired += 1;
        throw new Error("unexpected proof");
      },
    });
    assert.equal(change.classification, "none");
    assert.equal(acquired, 0);
  });
}

function promotionPolicy(approvedFingerprint: string): PublicApiCompatibilityPolicy {
  return {
    schemaVersion: 1,
    acceptedDecisionBaselinePath: "architecture/decisions/accepted.json",
    governanceConfigPath: "architecture/foundation/governance.yaml",
    changesetDirectory: ".changeset",
    packages: [
      {
        packageName: "async-proof-fixture",
        packageRoot: "packages/library",
        manifestPath: "packages/library/package.json",
        tsconfigPath: "packages/library/tsconfig.json",
        releasedBaselinePath: "architecture/public-api/library.json",
        approvedBreakingChanges: [{ fingerprint: approvedFingerprint, decisionId: "ADR-0001" }],
        entrypoints: [{ exportPath: ".", declarationEntryPoint: "packages/library/index.d.ts" }],
        nonTypeExports: [],
      },
    ],
  };
}

function registerCancelledPromotionCase(): void {
  void test("cancellation during a pending proof closes it before approval reads or baseline effects", async () => {
    const before = snapshot("string", ["first"]);
    const after = { ...snapshot("number", ["first"]), packageVersion: "2.0.0" };
    const unproved = await classifyPublicApiChange(before, after, fingerprint);
    assert.ok(unproved.fingerprint);
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<boolean>();
    const events: string[] = [];
    const effects: string[] = [];
    const pending = promotePublicApiBaselines(
      {
        consumerRoot: "fixture",
        policy: promotionPolicy(unproved.fingerprint),
        signal: controller.signal,
      },
      {
        extractor: { extract: async () => after },
        fingerprint,
        signatures: {
          equivalent: async () => {
            events.push("proof-entered");
            entered.resolve();
            try {
              return await gate.promise;
            } finally {
              events.push("proof-closed");
            }
          },
        },
        repository: {
          readReleasedBaseline: async () => before,
          readReleaseEvidence: async () => ({
            packageName: before.packageName,
            packageVersion: "2.0.0",
            declaredBump: "major",
          }),
          describeReleasedBaselineWrite: async () => {
            effects.push("describe-write");
            return {
              destination: "baseline.json",
              operation: "replace",
              preimageDigest: null,
              proposedDigest: `sha256:${"0".repeat(64)}`,
            };
          },
          writeReleasedBaseline: async () => {
            effects.push("write");
          },
        },
        acceptedDecisionEvidence: {
          readAcceptedDecisionEvidence: async () => {
            effects.push("read-approval");
            return {
              acceptedDecisionIds: ["ADR-0001"],
              acceptedDecisionPaths: ["docs/decisions/0001.md"],
            };
          },
        },
      },
    );
    try {
      await waitForEntry(pending, entered);
      controller.abort();
      assert.deepEqual(events, ["proof-entered"]);
      assert.deepEqual(effects, []);
      gate.resolve(false);
      await assert.rejects(
        pending,
        (error: unknown) =>
          error instanceof CapabilityInputError && error.problem.code === "EXECUTION_CANCELLED",
      );
      assert.deepEqual(events, ["proof-entered", "proof-closed"]);
      assert.deepEqual(
        effects,
        [],
        "Cancellation must be checked immediately after the proof await.",
      );
    } finally {
      gate.resolve(false);
      await pending.catch(() => {});
    }
  });
}

export function registerAsyncClassificationCases(): void {
  registerSequentialProofCase();
  registerProofRejectionCases();
  registerCancelledPromotionCase();
}
