import type { AuditDeclarationInput } from "../src/capabilities/public-api-compatibility/contract/public-api-audit.js";
import { NATIVE_EXTRACTOR_VERSION } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/load-pinned-audit-sdk.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runPublicApiAudit } from "../dist/capabilities/public-api-compatibility/node.js";

import type { Mutable, AuditRequestFixture } from "./public-api-audit-command-fixture.ts";
import { digest, schemas } from "./public-api-audit-command-fixture.ts";
for (const mode of ["hidden", "internal"]) {
  test(`A/B/C ${mode} mutation retains rich findings and historical semantics`, async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation-audit-command-test-"));
    try {
      const { subjects, baseline } = await prepareHistorySubjects(root, mode);
      const request = { schemaVersion: 1 as const, subjects };
      const requestBytes = JSON.stringify(request);
      await writeFile(join(root, "request.json"), requestBytes);
      const assertSchema = await schemas();
      const report = await runPublicApiAudit(
        { consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" },
        assertSchema,
      );
      assert.deepEqual(
        await runPublicApiAudit(
          { consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" },
          assertSchema,
        ),
        report,
      );
      assert.equal(report.releaseEligible, false);
      assert.equal(report.exitCode, mode === "internal" ? 0 : 2);
      assert.equal(report.evidenceComplete, true);
      assert.deepEqual(
        report.comparisons.map((comparison) => [
          comparison.pair,
          comparison.scope,
          comparison.eligibility.eligible,
        ]),
        [
          ["A-B", "historical-stored-surface", true],
          ["B-C", "historical-stored-surface", true],
          ["A-C", "declaration-graph", true],
        ],
      );
      assert.equal(report.comparisons[2]!.findings!.classification, "breaking");
      if (mode === "internal") {
        assert.deepEqual(
          report.observations.map((observation) =>
            observation.items.map((item) => item.identity.canonicalReference),
          ),
          [["audit-fixture!_f:function(1)"], ["audit-fixture!_f:function(1)"]],
        );
        assert.deepEqual(
          report.observations.map(
            (observation) => observation.storedSurface!.entrypoints[0]!.items,
          ),
          [[], []],
        );
        assert.deepEqual(
          report.comparisons.slice(0, 2).map((comparison) => comparison.findings!.classification),
          ["none", "none"],
        );
      }
      assert.ok(report.comparisons[0]!.limitations.some((value) => value.includes("B lacks")));
      assert.equal(await readFile(join(root, "baseline.json"), "utf8"), baseline);
      assert.equal(await readFile(join(root, "request.json"), "utf8"), requestBytes);
      await assert.rejects(
        assertSchema("package-public-api-audit-request/v1", { ...request, eligible: true }),
      );
      // Removing the last typed export produces an observed empty surface, not an
      // invented model or an unavailable comparison. The private tree still compiles.
      const releasedDeclaration =
        "export type Hidden = string; export declare function f(x: Hidden): Hidden;\n";
      await writeFile(join(root, "A/index.d.ts"), releasedDeclaration);
      subjects.A.files = subjects.A.files.map((file) =>
        file.path === "A/index.d.ts" ? { ...file, digest: digest(releasedDeclaration) } : file,
      );
      subjects.A.archive.extractedMembers = subjects.A.files;
      const untypedManifest = JSON.stringify({
        name: "audit-fixture",
        version: "1.0.0",
        exports: { "./package.json": "./package.json" },
      });
      await writeFile(join(root, "C/package.json"), untypedManifest);
      subjects.C.files = subjects.C.files.map((file) =>
        file.path === "C/package.json" ? { ...file, digest: digest(untypedManifest) } : file,
      );
      subjects.C.packages[0]!.entrypoints = [];
      subjects.C.packages[0]!.nonTypeExports = [{ exportPath: "./package.json", kind: "data" }];
      subjects.C.resolutionUniverse = [];
      await writeFile(join(root, "request.json"), JSON.stringify(request));
      const removed = await runPublicApiAudit(
        { consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" },
        assertSchema,
      );
      const empty = removed.observations.find((observation) => observation.subject === "C");
      assert.equal(empty!.exportPath, null);
      assert.equal(empty!.modelExpected, false);
      assert.equal(empty!.modelPresent, false);
      assert.equal(empty!.invocation.outcome, "not-invoked");
      assert.equal(empty!.invocation.succeeded, false);
      assert.equal(empty!.compilerDiagnosticsCollected, true);
      assert.deepEqual(empty!.storedSurface!.entrypoints, []);
      assert.equal(removed.exitCode, 0);
      assert.equal(removed.releaseEligible, false);
      assert.equal(removed.custody.archiveDigestVerified, false);
      assert.equal(removed.custody.archiveInventoryCompletenessVerified, false);
      assert.deepEqual(
        removed.comparisons.find((comparison) => comparison.pair === "A-C")!.findings!
          .removedEntrypoints,
        ["."],
      );
      assert.equal(await readFile(join(root, "baseline.json"), "utf8"), baseline);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function historyDeclarations(
  root: string,
  subject: "A" | "C",
  mode: string,
): Promise<Mutable<AuditDeclarationInput>> {
  await mkdir(join(root, subject));
  const files = {
    [`${subject}/package.json`]: JSON.stringify({
      name: "audit-fixture",
      version: "1.0.0",
      exports: { ".": { types: "./index.d.ts" } },
    }),
    [`${subject}/index.d.ts`]:
      mode === "internal"
        ? `/** @internal */\nexport declare function _f(): ${subject === "A" ? "string" : "number"};\n`
        : `type Hidden = ${subject === "A" ? "string" : "number"}; declare function f(x: Hidden): Hidden; export { f };\n`,
    [`${subject}/tsconfig.json`]: JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        strict: true,
        skipLibCheck: false,
      },
      files: ["index.d.ts"],
    }),
  };
  for (const [path, bytes] of Object.entries(files)) {
    await writeFile(join(root, path), bytes);
  }
  const inventory = Object.entries(files).map(([path, bytes]) => ({
    path,
    digest: digest(bytes),
  }));
  return {
    packages: [
      {
        packageName: "audit-fixture",
        packageVersion: "1.0.0",
        manifestPath: `${subject}/package.json`,
        tsconfigPath: `${subject}/tsconfig.json`,
        entrypoints: [{ exportPath: ".", declarationEntryPoint: `${subject}/index.d.ts` }],
        nonTypeExports: [],
      },
    ],
    files: inventory,
    resolutionUniverse: [
      {
        packageName: "audit-fixture",
        exportPath: ".",
        declarationPath: `${subject}/index.d.ts`,
      },
    ],
  };
}

async function prepareHistorySubjects(root: string, mode: string) {
  const declarationsA = await historyDeclarations(root, "A", mode);
  const declarationsC = await historyDeclarations(root, "C", mode);
  const A: AuditRequestFixture["subjects"]["A"] = {
    ...declarationsA,
    archive: {
      digest: digest("supplied archive assertion"),
      extractedMembers: declarationsA.files,
    },
  };
  const C: AuditRequestFixture["subjects"]["C"] = {
    ...declarationsC,
    build: {
      sourceIdentity: "test-source",
      buildIdentity: "test-build",
      declarations: declarationsC.files.filter((file) => file.path.endsWith(".d.ts")),
    },
  };
  const baseline = JSON.stringify({
    schemaVersion: 1,
    packageName: "audit-fixture",
    packageVersion: "1.0.0",
    extractorVersion: NATIVE_EXTRACTOR_VERSION,
    entrypoints: [
      {
        exportPath: ".",
        items:
          mode === "internal"
            ? []
            : [
                {
                  canonicalReference: "audit-fixture!f:function(1)",
                  kind: "Function",
                  parentReference: "audit-fixture!",
                  parentKind: "EntryPoint",
                  signature: "export declare function f(x: Hidden): Hidden;",
                },
              ],
      },
    ],
  });
  await writeFile(join(root, "baseline.json"), baseline);
  const B: AuditRequestFixture["subjects"]["B"] = {
    baselines: [{ packageName: "audit-fixture", path: "baseline.json", digest: digest(baseline) }],
  };
  return { subjects: { A, C, B }, baseline };
}
