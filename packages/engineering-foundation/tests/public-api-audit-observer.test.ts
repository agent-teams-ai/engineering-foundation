import * as registeredCases1 from "./public-api-audit-binding-cases.ts";
void registeredCases1;
import * as registeredCases2 from "./public-api-audit-environment-cases.ts";
void registeredCases2;
const inputFile = (path: string, text: string) => ({
  path,
  digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
});

import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import { ApiModel, ApiPackage } from "@microsoft/api-extractor-model";

import type { AuditObservation } from "../src/capabilities/public-api-compatibility/application/model/public-api-observation.js";

import { TypeScriptPublicApiExtractor } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/microsoft-public-api-extractor.js";
import { MicrosoftPublicApiObserver } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/microsoft-public-api-observer.js";

import { publicApiAuditEligibility } from "../dist/capabilities/public-api-compatibility/application/policies/public-api-audit-eligibility.js";

type ObserverInput = Parameters<MicrosoftPublicApiObserver["observe"]>[0];
async function fixture(
  source: string,
  action: (observer: MicrosoftPublicApiObserver, input: ObserverInput) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "foundation-audit-observer-test-"));
  try {
    const files = {
      "package.json": JSON.stringify({
        name: "audit-fixture",
        version: "1.0.0",
        types: "index.d.ts",
        exports: { ".": { types: "./index.d.ts" } },
      }),
      "index.d.ts": source,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          strict: true,
          skipLibCheck: false,
        },
        files: ["index.d.ts"],
      }),
    };
    for (const [path, text] of Object.entries(files)) {
      await writeFile(join(root, path), text);
    }
    const declarations: ObserverInput["declarations"] = {
      packages: [
        {
          packageName: "audit-fixture",
          packageVersion: "1.0.0",
          manifestPath: "package.json",
          tsconfigPath: "tsconfig.json",
          entrypoints: [{ exportPath: ".", declarationEntryPoint: "index.d.ts" }],
          nonTypeExports: [],
        },
      ],
      files: Object.entries(files).map(([path, text]) => ({
        path,
        digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
      })),
      resolutionUniverse: [
        { packageName: "audit-fixture", exportPath: ".", declarationPath: "index.d.ts" },
      ],
    };
    await action(new MicrosoftPublicApiObserver(), {
      consumerRoot: root,
      subject: "A",
      declarations,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("observer preserves failed extraction while independently admitting bounded hidden graph", async () => {
  await fixture(
    "type Hidden = string; declare function f(x: Hidden): Hidden; export { f };\n",
    async (observer, input) => {
      const observations = await observer.observe(input);
      assert(observations[0]);
      assert.equal(observations.length, 1);
      const observation = observations[0];
      assert(observation);
      assert.deepEqual(observation.unsupported, []);
      assert.equal(observation.compilerDiagnosticsCollected, true);
      assert.equal(observation.invocation.succeeded, false);
      assert.equal(observation.modelPresent, true);
      assert.deepEqual(
        observation.items.map((item) => item.identity.canonicalReference).toSorted(),
        ["audit-fixture!f:function(1)", "audit-fixture!~Hidden:type"],
      );
      assert.deepEqual(publicApiAuditEligibility(observations), { eligible: true, reasons: [] });
    },
  );
});
test("compiler errors remain independently observable even when SDK throws", async () => {
  await fixture(
    "type Hidden = MissingType; declare function f(x: Hidden): Hidden; export { f };\n",
    async (observer, input) => {
      const observations = await observer.observe(input);
      assert(observations[0]);
      assert.equal(observations[0].compilerDiagnosticsCollected, true);
      assert.equal(observations[0].invocation.outcome, "exception");
      assert.equal(observations[0].modelPresent, false);
      assert.ok(
        observations[0].diagnostics.some(
          (diagnostic) =>
            diagnostic.source === "compiler" &&
            diagnostic.id === "TS2304" &&
            diagnostic.severity === "error",
        ),
      );
      assert.equal(publicApiAuditEligibility(observations).eligible, false);
    },
  );
});
test("finite builtin binding is proved against the pinned libraries", async () => {
  await fixture(
    "export declare function f(signal: AbortSignal, bytes: Uint8Array, map: Readonly<Record<string, string>>, x: NoInfer<string | number>): Promise<Extract<string | number, string> | Error>;\n",
    async (observer, input) => {
      const observations = await observer.observe(input);
      assert(observations[0]);
      assert.deepEqual(observations[0].unsupported, []);
      const references = observations[0].items.flatMap((item) => item.references);
      assert.deepEqual(
        references.map((reference) => [reference.canonicalReference, reference.resolution]),
        [
          "!AbortSignal:interface",
          "!Uint8Array:interface",
          "!Readonly:type",
          "!Record:type",
          "!NoInfer:type",
          "!Promise:interface",
          "!Extract:type",
          "!Error:interface",
        ].map((reference) => [reference, "verified-external-library"]),
      );
      assert.ok(references.every((reference) => (reference.library?.declarations.length ?? 0) > 0));
      assert.equal(
        publicApiAuditEligibility(observations).eligible,
        true,
        JSON.stringify({
          eligibility: publicApiAuditEligibility(observations),
          diagnostics: observations[0].diagnostics,
          references: observations[0].items.flatMap((item) => item.references),
          identities: observations[0].items.map((item) => item.identity.canonicalReference),
        }),
      );
    },
  );
});
test("an explicit non-web lib still binds AbortSignal to the pinned compiler library", async () => {
  await fixture(
    "export declare function f(signal: AbortSignal): void;\n",
    async (observer, input) => {
      const tsconfig = JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          strict: true,
          skipLibCheck: false,
          lib: ["ES2022"],
        },
        files: ["index.d.ts"],
      });
      await writeFile(join(input.consumerRoot, "tsconfig.json"), tsconfig);
      const declarations = {
        ...input.declarations,
        files: [
          ...input.declarations.files.filter((file) => file.path !== "tsconfig.json"),
          inputFile("tsconfig.json", tsconfig),
        ],
      };
      const observations = await observer.observe({ ...input, declarations });
      assert(observations[0]);
      assert.deepEqual(observations[0].unsupported, []);
      assert.equal(observations[0].invocation.outcome, "completed");
      assert.equal(observations[0].invocation.succeeded, true);
      assert(Array.isArray(observations[0].compilerOptions["lib"]));
      assert.ok(observations[0].compilerOptions["lib"].includes("lib.dom.d.ts"));
      assert.deepEqual(
        observations[0].items
          .flatMap((item) => item.references)
          .map((reference) => [reference.canonicalReference, reference.resolution]),
        [["!AbortSignal:interface", "verified-external-library"]],
      );
      assert.deepEqual(publicApiAuditEligibility(observations), { eligible: true, reasons: [] });
    },
  );
});
test("global augmentation cannot pass by matching a builtin spelling", async () => {
  await fixture(
    "declare global { interface Promise<T> { extra: T } } export declare function f(x: Promise<string>): void;\n",
    async (observer, input) => {
      const observations = await observer.observe(input);
      assert(observations[0]);
      assert.ok(
        observations[0].items
          .flatMap((item) => item.references)
          .some(
            (reference) =>
              reference.canonicalReference === "!Promise:interface" &&
              reference.resolution === "unresolved",
          ),
      );
      assert.equal(publicApiAuditEligibility(observations).eligible, false);
    },
  );
});
test("tampered input and cancellation fail closed", async () => {
  await fixture("export declare function f(): void;\n", async (observer, input) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(observer.observe({ ...input, signal: controller.signal }));
    await writeFile(
      join(input.consumerRoot, "index.d.ts"),
      "export declare function changed(): void;\n",
    );
    const observations = await observer.observe(input);
    assert(observations[0]);
    assert.equal(publicApiAuditEligibility(observations).eligible, false);
    assert.equal(observations[0].inputBytesRevalidated, false);
  });
});
test("public members inherit their namespace/class visibility; hidden containers do not export members", async () => {
  await fixture(
    "declare namespace Hidden { export class Box { constructor(); value: string; } } export namespace Visible { class Box { constructor(); value: string; } } declare function f(x: Hidden.Box): void; export { f };\n",
    async (observer, input) => {
      const observations = await observer.observe(input);
      assert(observations[0]);
      const items = observations[0].items;
      const visible = items.filter((item) => item.identity.canonicalReference.includes("Visible"));
      const hidden = items.filter((item) => item.identity.canonicalReference.includes("~Hidden"));
      assert.equal(visible.length, 4);
      assert.equal(hidden.length, 4);
      assert.deepEqual(visible.map((item) => [item.kind, item.public]).toSorted(), [
        ["Class", true],
        ["Constructor", true],
        ["Namespace", true],
        ["Property", true],
      ]);
      assert.deepEqual(hidden.map((item) => [item.kind, item.public]).toSorted(), [
        ["Class", false],
        ["Constructor", false],
        ["Namespace", false],
        ["Property", false],
      ]);
      assert.equal(visible.find((item) => item.kind === "Constructor")?.isExported, null);
      // The native symbol and the official model identify one hidden namespace member.
      // This fixes the prior SDK's inconsistent reference navigation without rewriting evidence.
      assert.equal(
        hidden.find((item) => item.kind === "Class")?.identity.canonicalReference,
        "audit-fixture!~Hidden.Box:class",
      );
      assert.equal(hidden.find((item) => item.kind === "Class")?.isExported, true);
      assert.equal(hidden.find((item) => item.kind === "Class")?.public, false);
      assert.deepEqual(
        items
          .flatMap((item) => item.references)
          .map((reference) => [
            reference.canonicalReference,
            reference.resolution,
            reference.target?.canonicalReference,
          ]),
        [["audit-fixture!~Hidden.Box:class", "local", "audit-fixture!~Hidden.Box:class"]],
      );
      assert.deepEqual(publicApiAuditEligibility(observations), { eligible: true, reasons: [] });
      for (const resolution of ["unresolved", "ambiguous"] as const) {
        const malformed: AuditObservation = {
          ...observations[0],
          items: items.map((item) => ({
            ...item,
            references: item.references.map((reference) => ({
              text: reference.text,
              canonicalReference: "audit-fixture!~Hidden~Box:class",
              resolution,
            })),
          })),
        };
        assert.deepEqual(publicApiAuditEligibility([malformed]), {
          eligible: false,
          reasons: ["incomplete-reference-resolution"],
        });
      }
      const duplicate = { ...observations[0], items: [...items, items[0]!] };
      assert.ok(
        publicApiAuditEligibility([duplicate]).reasons.includes("duplicate-scoped-identity"),
      );
      assert.ok(
        publicApiAuditEligibility([{ ...observations[0], modelPresent: false }]).reasons.includes(
          "missing-model",
        ),
      );
      assert.ok(
        publicApiAuditEligibility([
          {
            ...observations[0],
            invocation: { ...observations[0].invocation, outcome: "exception" },
          },
        ]).reasons.includes("incomplete-invocation"),
      );
      const unexpected = {
        source: "extractor" as const,
        id: "ae-unexpected",
        severity: "error",
        text: "unexpected",
      };
      assert.ok(
        publicApiAuditEligibility([
          { ...observations[0], diagnostics: [...observations[0].diagnostics, unexpected] },
        ]).reasons.includes("non-forgotten-export-error"),
      );
    },
  );
});

test("production extraction excludes forgotten exports and rejects failure before model loading", async () => {
  await fixture(
    "type Hidden = string; declare function f(x: Hidden): Hidden; export { f };\n",
    async (_observer, input) => {
      const originalLoad = ApiModel.prototype.loadPackage;
      const originalSave = ApiPackage.prototype.saveToJsonFile;
      let modelLoads = 0;
      let modelSaves = 0;
      ApiModel.prototype.loadPackage = function () {
        modelLoads++;
        throw new Error("MODEL_LOAD_MUST_NOT_RUN");
      };
      ApiPackage.prototype.saveToJsonFile = function (...args) {
        modelSaves++;
        return originalSave.apply(this, args);
      };
      try {
        const extractor = new TypeScriptPublicApiExtractor({
          files: { read: async ({ candidate }) => readFile(candidate) },
          paths: { traversesSymbolicLink: async () => false },
        });
        const pkg = input.declarations.packages[0];
        assert(pkg);
        const policy = {
          ...pkg,
          packageRoot: ".",
          releasedBaselinePath: "baseline.json",
          approvedBreakingChanges: [],
        };
        await assert.rejects(
          extractor.extract(input.consumerRoot, policy, "1.0.0"),
          (error: unknown) =>
            error instanceof Error && error.message.includes("ae-forgotten-export"),
        );
        assert.equal(modelLoads, 0);
        assert.equal(modelSaves, 0);
      } finally {
        ApiModel.prototype.loadPackage = originalLoad;
        ApiPackage.prototype.saveToJsonFile = originalSave;
      }
    },
  );
});
test("production extraction trims internal exports while rich observation retains them", async () => {
  await fixture(
    "/** @internal */ export declare function internal(): void;\n/** @public */ export declare function visible(): void;\n",
    async (observer, input) => {
      const extractor = new TypeScriptPublicApiExtractor({
        files: { read: async ({ candidate }) => readFile(candidate) },
        paths: { traversesSymbolicLink: async () => false },
      });
      const pkg = input.declarations.packages[0];
      assert(pkg);
      const policy = {
        ...pkg,
        packageRoot: ".",
        releasedBaselinePath: "baseline.json",
        approvedBreakingChanges: [],
      };
      const snapshot = await extractor.extract(input.consumerRoot, policy, "1.0.0");
      assert.deepEqual(
        snapshot.entrypoints[0]?.items.map((item) => item.canonicalReference),
        ["audit-fixture!visible:function(1)"],
      );
      const observed = await observer.observe(input);
      assert(observed[0]);
      assert.deepEqual(
        observed[0]?.items.map((item) => item.identity.canonicalReference).toSorted(),
        ["audit-fixture!internal:function(1)", "audit-fixture!visible:function(1)"],
      );
    },
  );
});
test("a locally shadowed builtin remains a local declaration rather than a library boundary", async () => {
  await fixture(
    "interface Promise<T> { local: T } declare function f(x: Promise<string>): void; export { f };\n",
    async (observer, input) => {
      const observations = await observer.observe(input);
      assert(observations[0]);
      const references = observations[0].items.flatMap((item) => item.references);
      assert.ok(
        references.some(
          (reference) =>
            reference.canonicalReference === "audit-fixture!~Promise:interface" &&
            reference.resolution === "local",
        ),
        JSON.stringify({ references, observation: observations[0] }),
      );
      assert.ok(
        references.every((reference) => reference.resolution !== "verified-external-library"),
      );
      assert.deepEqual(publicApiAuditEligibility(observations), { eligible: true, reasons: [] });
    },
  );
});
