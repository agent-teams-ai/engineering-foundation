import assert from "node:assert/strict";
import test from "node:test";
import { API } from "typescript/unstable/async";
import type { PublicApiItem } from "../src/capabilities/public-api-compatibility/application/model/public-api.js";
import type { NativeSignatureSessionFactory } from "../src/capabilities/public-api-compatibility/adapters/outbound/api-extractor/native-type-parenthesis-equivalence.js";
import { createNativeTypeParenthesisEquivalence } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/native-type-parenthesis-equivalence.js";
import { NATIVE_EXTRACTOR_VERSION } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/load-pinned-audit-sdk.js";

const versions: { readonly released: string; readonly current: string } = {
  released: NATIVE_EXTRACTOR_VERSION,
  current: NATIVE_EXTRACTOR_VERSION,
};
const released: PublicApiItem = {
  canonicalReference: "async-signature-fixture!Literal:type",
  kind: "TypeAlias",
  parentKind: "EntryPoint",
  signature: 'export type Literal = "ready";',
};
const current: PublicApiItem = { ...released, signature: "export type Literal = 'ready';" };

type FailureStage = "update" | "config" | "syntax" | "source";

function rejectingSession(stage: FailureStage, events: string[]): NativeSignatureSessionFactory {
  const failure = new Error(`deliberate async ${stage} rejection`);
  return () => ({
    async updateSnapshot() {
      events.push("update");
      if (stage === "update") {
        throw failure;
      }
      return {
        getProject: () => ({
          program: {
            async getConfigFileParsingDiagnostics() {
              events.push("config");
              if (stage === "config") {
                throw failure;
              }
              return [];
            },
            async getSyntacticDiagnostics() {
              events.push("syntax");
              if (stage === "syntax") {
                throw failure;
              }
              return [];
            },
            async getSourceFile() {
              events.push("source");
              if (stage === "source") {
                throw failure;
              }
              return undefined;
            },
          },
        }),
        async dispose() {
          events.push("dispose");
        },
      };
    },
    async close() {
      events.push("close");
    },
  });
}

function trackedNativeSession(
  events: string[],
  rejectAfter: "dispose" | "close" | undefined,
): NativeSignatureSessionFactory {
  return (options) => {
    const api = new API(options);
    return {
      async updateSnapshot(input) {
        const snapshot = await api.updateSnapshot(input);
        events.push("snapshot");
        return {
          getProject: (configPath) => snapshot.getProject(configPath),
          async dispose() {
            await snapshot.dispose();
            events.push("disposed");
            if (rejectAfter === "dispose") {
              throw new Error("deliberate rejection after real snapshot cleanup");
            }
          },
        };
      },
      async close() {
        await api.close();
        events.push("closed");
        if (rejectAfter === "close") {
          throw new Error("deliberate rejection after real API cleanup");
        }
      },
    };
  };
}

export function registerNativeAsyncSignatureCases(): void {
  void test("public async native signature proof retains the actual quote oracle", async () => {
    const proof = createNativeTypeParenthesisEquivalence();
    assert.equal(await proof.equivalent(released, current, versions), true);
    assert.equal(await proof.equivalent(current, released, versions), true);
    assert.equal(
      await proof.equivalent(
        released,
        { ...current, signature: "export type Literal = 'different';" },
        versions,
      ),
      false,
    );
  });

  for (const [stage, expected] of [
    ["update", ["update", "close"]],
    ["config", ["update", "config", "dispose", "close"]],
    ["syntax", ["update", "config", "syntax", "dispose", "close"]],
    ["source", ["update", "config", "syntax", "source", "dispose", "close"]],
  ] as const) {
    void test(`async signature ${stage} rejection yields no proof and closes owned resources`, async () => {
      const events: string[] = [];
      const proof = createNativeTypeParenthesisEquivalence(rejectingSession(stage, events));
      assert.equal(await proof.equivalent(released, current, versions), false);
      assert.deepEqual(events, expected);
    });
  }

  for (const rejectAfter of [undefined, "dispose", "close"] as const) {
    void test(`real async signature cleanup ${rejectAfter ?? "control"} preserves fail-closed results`, async () => {
      const events: string[] = [];
      const proof = createNativeTypeParenthesisEquivalence(
        trackedNativeSession(events, rejectAfter),
      );
      assert.equal(await proof.equivalent(released, current, versions), rejectAfter === undefined);
      // These are awaited public SDK cleanup calls, not a physical child-drain assertion.
      assert.deepEqual(events, ["snapshot", "disposed", "closed"]);
    });
  }

  void test("async signature metadata and character limits refuse before acquiring a native session", async () => {
    let acquired = 0;
    const proof = createNativeTypeParenthesisEquivalence(() => {
      acquired += 1;
      throw new Error("guarded inputs must not acquire a session");
    });
    const cases: readonly (readonly [PublicApiItem, PublicApiItem, typeof versions])[] = [
      [{ ...released, kind: "Interface" }, current, versions],
      [released, { ...current, kind: "Function" }, versions],
      [
        released,
        { ...current, canonicalReference: "async-signature-fixture!Other:type" },
        versions,
      ],
      [released, { ...current, parentKind: "Namespace" }, versions],
      [
        released,
        { ...current, parentReference: "async-signature-fixture!Other:namespace" },
        versions,
      ],
      [released, current, { ...versions, released: "unsupported/extractor" }],
      [released, current, { ...versions, current: "unsupported/extractor" }],
      [{ ...released, signature: "x".repeat(10_001) }, current, versions],
      [released, { ...current, signature: "x".repeat(10_001) }, versions],
    ];
    for (const [before, after, extractorVersions] of cases) {
      assert.equal(await proof.equivalent(before, after, extractorVersions), false);
      assert.equal(acquired, 0);
    }
  });
}
