import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { captureFailure, runCommand } from "./pack-test-support.mjs";
import type { PublicApiAuditRequest } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/contract/public-api-audit.js";
import type { PublicApiAuditReport } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api-audit-report.js";
import type { AuditObservation } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api-observation.js";
import type { PublicApiSnapshot } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api.js";

interface PackedAuditFixture {
  readonly consumerRoot: string;
  readonly toolEntrypoints: { readonly foundationRoot: string };
  readonly packedManifest: {
    readonly version: string;
    readonly bin: Readonly<Record<string, string>>;
  };
}
interface InvalidAuditReport {
  readonly schemaVersion: 1;
  readonly operation: "public-api-audit";
  readonly releaseEligible: false;
  readonly evidenceComplete: false;
  readonly exitCode: 2;
  readonly errors: readonly string[];
}
type AuditMode = "successful" | "failed-extraction" | "invalid-input";
const packageName = "packed-audit-fixture";
const digest = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
// Exact original synthetic B remains a distinct active refusal input.
const legacyBaseline = JSON.stringify({
  schemaVersion: 1,
  packageName,
  packageVersion: "1.0.0",
  extractorVersion: "7.58.12",
  entrypoints: [{ exportPath: ".", items: [] }],
});
const nativeEmptyOracle: PublicApiSnapshot = {
  schemaVersion: 1,
  packageName,
  packageVersion: "1.0.0",
  extractorVersion: "typescript-native/7.0.2",
  entrypoints: [{ exportPath: ".", items: [] }],
};

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function writeAuditSubject(
  root: string,
  name: "A" | "C",
  mode: AuditMode,
  expectedBytes: Map<string, string>,
) {
  await mkdir(join(root, name));
  const type = name === "A" ? "string" : "number";
  const files = {
    [`${name}/package.json`]: JSON.stringify({
      name: packageName,
      version: "1.0.0",
      exports: { ".": { types: "./index.d.ts" } },
    }),
    [`${name}/index.d.ts`]:
      mode === "failed-extraction"
        ? `type Hidden = ${type}; declare function f(): Hidden; export { f };\n`
        : `/** @internal */\nexport declare function _f(): ${type};\n`,
    [`${name}/tsconfig.json`]: JSON.stringify({
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
    expectedBytes.set(path, bytes);
  }
  const inventory = Object.entries(files).map(([path, bytes]) => ({
    path,
    digest: digest(bytes),
  }));
  return {
    packages: [
      {
        packageName,
        packageVersion: "1.0.0",
        manifestPath: `${name}/package.json`,
        tsconfigPath: `${name}/tsconfig.json`,
        entrypoints: [{ exportPath: ".", declarationEntryPoint: `${name}/index.d.ts` }],
        nonTypeExports: [],
      },
    ],
    files: inventory,
    resolutionUniverse: [{ packageName, exportPath: ".", declarationPath: `${name}/index.d.ts` }],
  };
}

async function auditSchema(
  requireFromConsumer: ReturnType<typeof createRequire>,
  kind: "request" | "report",
) {
  const path = requireFromConsumer.resolve(
    `@agent-teams/engineering-foundation/schemas/package-public-api-audit-${kind}/v1.schema.json`,
  );
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return record(parsed);
}

async function writeAuditInputs(
  root: string,
  expectedBytes: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [path, bytes] of expectedBytes) {
    await writeFile(join(root, path), bytes, { flag: "wx" });
  }
}

interface AuditContext {
  fixture: PackedAuditFixture;
  binary: string;
  validateRequest: ValidateFunction<PublicApiAuditRequest>;
  validateReport: ValidateFunction<PublicApiAuditReport | InvalidAuditReport>;
}
async function auditInNamespace(
  { fixture, binary, validateRequest, validateReport }: AuditContext,
  mode: AuditMode,
  baseline: string,
  exitCode: 0 | 2,
): Promise<PublicApiAuditReport | undefined> {
  // Each invocation gets a fresh namespace. All exclusive writes finish before
  // launching its reader; no invocation can rewrite another audit's live input.
  const root = await mkdtemp(join(tmpdir(), "foundation-packed-public-api-audit-"));
  try {
    const expectedBytes = new Map<string, string>();
    const a = await writeAuditSubject(root, "A", mode, expectedBytes);
    const c = await writeAuditSubject(root, "C", mode, expectedBytes);
    const request: PublicApiAuditRequest = {
      schemaVersion: 1,
      subjects: {
        A: {
          ...a,
          archive: { digest: digest("supplied synthetic archive"), extractedMembers: a.files },
        },
        C: {
          ...c,
          build: {
            sourceIdentity: "synthetic-source",
            buildIdentity: "synthetic-build",
            declarations: c.files.filter((file) => file.path.endsWith(".d.ts")),
          },
        },
        B: { baselines: [{ packageName, path: "baseline.json", digest: digest(baseline) }] },
      },
    };
    assert.ok(validateRequest(request), JSON.stringify(validateRequest.errors));
    expectedBytes.set("baseline.json", baseline);
    expectedBytes.set(
      "request.json",
      JSON.stringify(mode === "invalid-input" ? { ...request, eligible: true } : request),
    );
    await writeAuditInputs(root, expectedBytes);
    const args = [
      binary,
      "public-api-audit",
      "--consumer",
      root,
      "--config",
      "request.json",
      "--format",
      "json",
    ];
    let stdout: string;
    if (exitCode === 0) {
      const result = await runCommand(process.execPath, args, fixture.consumerRoot);
      assert.equal(result.stderr, "");
      stdout = result.stdout;
    } else {
      const failure: unknown = await captureFailure(() =>
        runCommand(process.execPath, args, fixture.consumerRoot),
      );
      const result = record(failure);
      assert.equal(result["code"], exitCode);
      assert.equal(result["signal"], null);
      assert.equal(result["timedOut"], false);
      assert.equal(result["terminationConfirmed"], true);
      assert.equal(result["stderr"], "");
      assert.ok(typeof result["stdout"] === "string");
      stdout = result["stdout"];
    }
    const report: unknown = JSON.parse(stdout);
    assert.ok(validateReport(report), JSON.stringify(validateReport.errors));
    assert.equal(report.releaseEligible, false);
    assert.equal(report.exitCode, exitCode);
    for (const [path, bytes] of expectedBytes) {
      assert.equal(await readFile(join(root, path), "utf8"), bytes, `Audit mutated ${path}`);
    }
    if (mode === "invalid-input") {
      assert.equal(report.evidenceComplete, false);
      assert.ok(report.errors.length > 0);
      assert.ok(!("observations" in report));
      return;
    }
    assert.ok("observations" in report);
    assert.equal(report.foundationVersion, fixture.packedManifest.version);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.custody, {
      supplied: request.subjects,
      archiveProvenanceVerified: false,
      archiveDigestVerified: false,
      archiveInventoryCompletenessVerified: false,
      buildExecutionVerified: false,
    });
    assert.equal(report.observations.length, 2);
    assertObservations(report.observations, mode);
    assert.equal(report.comparisons[2]?.pair, "A-C");
    assert.deepEqual(report.comparisons[2].eligibility, { eligible: true, reasons: [] });
    assert.equal(report.comparisons[2].findings?.classification, "breaking");
    assert.ok(report.comparisons[0]?.limitations.some((reason) => reason.includes("B lacks")));
    return report;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Qualify the installed public binary and schema exports on immutable synthetic evidence. */
export async function assertPublicApiAudit(fixture: PackedAuditFixture): Promise<void> {
  const requireFromConsumer = createRequire(join(fixture.consumerRoot, "package.json"));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validateRequest = ajv.compile<PublicApiAuditRequest>(
    await auditSchema(requireFromConsumer, "request"),
  );
  const validateReport = ajv.compile<PublicApiAuditReport | InvalidAuditReport>(
    await auditSchema(requireFromConsumer, "report"),
  );
  const entry = fixture.packedManifest.bin["agent-teams-foundation"];
  assert.ok(entry);
  const binary = join(fixture.toolEntrypoints.foundationRoot, entry);

  const auditNamespace = (mode: AuditMode, baseline: string, exitCode: 0 | 2) =>
    auditInNamespace(
      { fixture, binary, validateRequest, validateReport },
      mode,
      baseline,
      exitCode,
    );

  // Observe before preparing a new B. The original legacy identity must refuse;
  // its two actual native empty stored surfaces supply the separate positive.
  const legacy = await auditNamespace("successful", legacyBaseline, 2);
  assert.ok(legacy);
  assert.equal(legacy.evidenceComplete, false);
  assert.deepEqual(
    legacy.comparisons.slice(0, 2).map((comparison) => [comparison.pair, comparison.eligibility]),
    [
      ["A-B", { eligible: false, reasons: ["historical-extractor-version-mismatch"] }],
      ["B-C", { eligible: false, reasons: ["historical-extractor-version-mismatch"] }],
    ],
  );
  for (const observation of legacy.observations) {
    assert.deepEqual(observation.storedSurface, nativeEmptyOracle);
    assert.deepEqual(
      observation.items.map((item) => [item.identity.canonicalReference, item.kind, item.excerpt]),
      [
        [
          `${packageName}!_f:function(1)`,
          "Function",
          `export declare function _f(): ${observation.subject === "A" ? "string" : "number"};`,
        ],
      ],
    );
  }
  const native = legacy.observations.find(
    (observation) => observation.subject === "A",
  )?.storedSurface;
  assert.ok(native);
  const nativeBaseline = JSON.stringify(native);
  for (const mode of ["successful", "failed-extraction", "invalid-input"] as const) {
    const report = await auditNamespace(mode, nativeBaseline, mode === "successful" ? 0 : 2);
    if (mode === "invalid-input") {
      continue;
    }
    assert.ok(report);
    assert.equal(report.evidenceComplete, true);
    assert.deepEqual(
      report.comparisons.map((comparison) => [comparison.pair, comparison.eligibility]),
      [
        ["A-B", { eligible: true, reasons: [] }],
        ["B-C", { eligible: true, reasons: [] }],
        ["A-C", { eligible: true, reasons: [] }],
      ],
    );
  }
}

function assertObservations(
  observations: readonly AuditObservation[],
  mode: Exclude<AuditMode, "invalid-input">,
): void {
  assert.deepEqual(
    observations.map((observation) => observation.subject),
    ["A", "C"],
  );
  for (const observation of observations) {
    assert.equal(
      observation.compilerDiagnosticsCollected,
      true,
      JSON.stringify(observation.unsupported),
    );
    assert.equal(observation.inputBytesRevalidated, true);
    assert.equal(observation.modelPresent, true);
    assert.deepEqual(observation.unsupported, []);
    assert.deepEqual(observation.invocation, {
      outcome: "completed",
      succeeded: mode === "successful",
      errorCount: mode === "successful" ? 0 : 1,
      warningCount: 0,
    });
    assert.deepEqual(observation.configurationDependencies.map((file) => file.path).toSorted(), [
      `${observation.subject}/package.json`,
      `${observation.subject}/tsconfig.json`,
    ]);
    assert.ok(
      observation.sourceFiles.some((file) => file.path === `${observation.subject}/index.d.ts`),
    );
    assert.deepEqual(
      observation.diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => [diagnostic.source, diagnostic.id]),
      mode === "failed-extraction" ? [["extractor", "ae-forgotten-export"]] : [],
    );
  }
}
