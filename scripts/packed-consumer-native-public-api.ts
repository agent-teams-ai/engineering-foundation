import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { captureFailure, runCommand } from "./pack-test-support.mjs";
import type { PublicApiAuditReport } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api-audit-report.js";
import type { PublicApiAuditRequest } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/contract/public-api-audit.js";
import type { PublicApiSnapshot } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api.js";
import type { FoundationCheckReport } from "../packages/engineering-foundation/dist/features/validation-reporting/api.js";

interface PackedFixture {
  readonly consumerRoot: string;
  readonly toolEntrypoints: { readonly foundationCli: string };
  readonly packedManifest: { readonly version: string };
}
const baselinePath = "architecture/public-api/public-api.json";
const packageName = "@fixture/public-api";
const nativeVersion = "typescript-native/7.0.2";
const packageFiles = ["package.json", "tsconfig.json", "dist/index.d.ts", "dist/local-mode.d.ts"] as const;
const entrypoints = [".", "./local-mode"] as const;
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const jsonBytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function validator<T>(root: string, name: string) {
  const require = createRequire(join(root, "package.json"));
  const schema: unknown = JSON.parse(await readFile(require.resolve(`@agent-teams/engineering-foundation/schemas/${name}/v1.schema.json`), "utf8"));
  return new Ajv2020({ strict: true, allErrors: true }).compile<T>(record(schema));
}
async function failedJson(root: string, cli: string, args: readonly string[], exitCode: number): Promise<unknown> {
  const failure: unknown = await captureFailure(() => runCommand(process.execPath, [cli, ...args], root));
  const result = record(failure);
  assert.equal(result["code"], exitCode);
  assert.equal(result["signal"], null);
  assert.equal(result["timedOut"], false);
  assert.equal(result["terminationConfirmed"], true);
  assert.equal(result["stderr"], "");
  const stdout = result["stdout"]; assert.ok(typeof stdout === "string");
  return JSON.parse(stdout) as unknown;
}
async function nativeStandardLibraryPaths(root: string): Promise<ReadonlySet<string>> {
  const consumer = createRequire(join(root, "package.json"));
  const foundation = createRequire(consumer.resolve("@agent-teams/engineering-foundation/package.json"));
  const sdkManifest = foundation.resolve("typescript/package.json");
  const sdk = record(JSON.parse(await readFile(sdkManifest, "utf8")) as unknown);
  assert.equal(sdk["name"], "typescript"); assert.equal(sdk["version"], "7.0.2");
  const platformName = `@typescript/typescript-${process.platform}-${process.arch}`;
  assert.equal(record(sdk["optionalDependencies"])[platformName], "7.0.2");
  const platformManifest = createRequire(sdkManifest).resolve(`${platformName}/package.json`);
  const platform = record(JSON.parse(await readFile(platformManifest, "utf8")) as unknown);
  assert.equal(platform["name"], platformName); assert.equal(platform["version"], "7.0.2");
  return new Set(await Promise.all(["lib.dom.d.ts", "lib.es5.d.ts"].map(async name =>
    (await realpath(join(dirname(platformManifest), "lib", name))).replaceAll("\\", "/"))));
}
function observedSnapshot(report: PublicApiAuditReport, subject: "A" | "C", legacy: PublicApiSnapshot, standardLibraries: ReadonlySet<string>): PublicApiSnapshot {
  const selected = report.observations.filter(observation => observation.subject === subject);
  assert.deepEqual(selected.map(observation => observation.exportPath), entrypoints);
  for (const observation of selected) {
    assert.equal(observation.packageName, packageName);
    assert.equal(observation.packageVersion, "1.2.3");
    assert.equal(observation.compilerDiagnosticsCollected, true);
    assert.equal(observation.inputBytesRevalidated, true);
    assert.equal(observation.modelPresent, true);
    assert.deepEqual(observation.invocation, { outcome: "completed", succeeded: true, errorCount: 0, warningCount: 0 });
    // Keep every native diagnostic. These pinned standard-library deprecations
    // are suggestions, and must agree in all four complete observations.
    assert.deepEqual(observation.diagnostics, report.observations[0]?.diagnostics);
    for (const diagnostic of observation.diagnostics) {
      assert.equal(diagnostic.source, "compiler"); assert.equal(diagnostic.id, "TS6385");
      assert.equal(diagnostic.severity, "suggestion"); assert.ok(diagnostic.file);
      assert.ok(standardLibraries.has(diagnostic.file.replaceAll("\\", "/")));
    }
    assert.deepEqual(observation.unsupported, []);
    assert.ok(observation.storedSurface);
    const expected = legacy.entrypoints?.find(entry => entry.exportPath === observation.exportPath); assert.ok(expected);
    assert.deepEqual(observation.storedSurface, { ...legacy, extractorVersion: nativeVersion, entrypoints: [expected] });
  }
  const first = selected[0]?.storedSurface; assert.ok(first);
  return { ...first, entrypoints: selected.flatMap(observation => observation.storedSurface?.entrypoints ?? []) };
}

/** Observe a distinct synthetic native predecessor through the installed PUBLIC
 * read-only auditor. Its historical B mismatch stays a reported refusal. */
export async function preparePackedNativePublicApiBaseline(fixture: PackedFixture): Promise<Buffer> {
  const root = fixture.consumerRoot; const cli = fixture.toolEntrypoints.foundationCli;
  const original = await readFile(join(root, baselinePath));
  const validateBaseline = await validator<PublicApiSnapshot>(root, "package-public-api-baseline");
  const legacy: unknown = JSON.parse(original.toString("utf8")); assert.ok(validateBaseline(legacy));
  assert.equal(legacy.packageName, packageName); assert.equal(legacy.packageVersion, "1.2.3");
  assert.equal(legacy.extractorVersion, "7.58.12");
  assert.deepEqual(legacy.entrypoints?.map(entry => entry.exportPath), entrypoints);
  const temporary = await mkdtemp(join(tmpdir(), "foundation-packed-native-predecessor-"));
  try {
    const files = new Map<string, Buffer>([["baseline.json", original]]);
    for (const subject of ["A", "C"] as const) {
      for (const path of packageFiles) { files.set(`${subject}/${path}`, await readFile(join(root, "packages/library", path))); }
      const originalConfig = files.get(`${subject}/tsconfig.json`); assert.ok(originalConfig);
      const configuration: unknown = JSON.parse(originalConfig.toString("utf8"));
      const compilerOptions = { module: "NodeNext", moduleResolution: "NodeNext", strict: true, target: "ES2024" };
      assert.deepEqual(configuration, { compilerOptions, include: ["dist/*.d.ts"] });
      // Rich audit requires explicit roots. Keep the original ordinary config as
      // captured data and name this distinct, equivalent synthetic audit input.
      files.set(`${subject}/tsconfig.audit.json`, jsonBytes({ compilerOptions, files: ["dist/index.d.ts", "dist/local-mode.d.ts"] }));
    }
    for (const path of packageFiles) { assert.deepEqual(files.get(`A/${path}`), files.get(`C/${path}`)); }
    const declarations = (subject: "A" | "C") => ({
      packages: [{ packageName, packageVersion: "1.2.3", manifestPath: `${subject}/package.json`, tsconfigPath: `${subject}/tsconfig.audit.json`,
        entrypoints: entrypoints.map((exportPath, index) => ({ exportPath, declarationEntryPoint: `${subject}/dist/${index === 0 ? "index" : "local-mode"}.d.ts` })), nonTypeExports: [] }],
      files: [...files].filter(([path]) => path.startsWith(`${subject}/`)).map(([path, bytes]) => ({ path, digest: digest(bytes) })),
      resolutionUniverse: entrypoints.map((exportPath, index) => ({ packageName, exportPath, declarationPath: `${subject}/dist/${index === 0 ? "index" : "local-mode"}.d.ts` }))
    });
    const a = declarations("A"); const c = declarations("C");
    const request: PublicApiAuditRequest = { schemaVersion: 1, subjects: {
      A: { ...a, archive: { digest: digest(jsonBytes(a.files)), extractedMembers: a.files } },
      B: { baselines: [{ packageName, path: "baseline.json", digest: digest(original) }] },
      C: { ...c, build: { sourceIdentity: "synthetic-packed-declaration-fixture", buildIdentity: "copied-declarations-not-an-executed-build", declarations: c.files.filter(file => file.path.endsWith(".d.ts")) } }
    } };
    assert.ok((await validator<PublicApiAuditRequest>(root, "package-public-api-audit-request"))(request));
    files.set("request.json", jsonBytes(request));
    for (const [path, bytes] of files) { await mkdir(dirname(join(temporary, path)), { recursive: true }); await writeFile(join(temporary, path), bytes, { flag: "wx" }); }
    const parsed = await failedJson(root, cli, ["public-api-audit", "--consumer", temporary, "--config", "request.json", "--format", "json"], 2);
    const validate = await validator<PublicApiAuditReport>(root, "package-public-api-audit-report"); assert.ok(validate(parsed), JSON.stringify(validate.errors));
    assert.equal(parsed.foundationVersion, fixture.packedManifest.version);
    assert.equal(parsed.releaseEligible, false); assert.equal(parsed.evidenceComplete, false); assert.equal(parsed.exitCode, 2);
    assert.deepEqual(parsed.custody, { supplied: request.subjects, archiveProvenanceVerified: false, archiveDigestVerified: false,
      archiveInventoryCompletenessVerified: false, buildExecutionVerified: false });
    assert.deepEqual(parsed.errors, []); assert.equal(parsed.observations.length, 4);
    assert.deepEqual(parsed.comparisons.map(comparison => [comparison.pair, comparison.packageName, comparison.eligibility]), [
      ["A-B", packageName, { eligible: false, reasons: ["historical-extractor-version-mismatch"] }],
      ["B-C", packageName, { eligible: false, reasons: ["historical-extractor-version-mismatch"] }],
      ["A-C", packageName, { eligible: true, reasons: [] }]
    ]);
    assert.equal(parsed.comparisons[2]?.findings?.classification, "none");
    const standardLibraries = await nativeStandardLibraryPaths(root);
    const snapshot = observedSnapshot(parsed, "A", legacy, standardLibraries);
    assert.deepEqual(observedSnapshot(parsed, "C", legacy, standardLibraries), snapshot);
    // The original literal stable-function/two-entrypoint fixture is an independent
    // semantic oracle. Serialize the observed snapshot, never a relabelled B.
    assert.deepEqual(snapshot, { ...legacy, extractorVersion: nativeVersion });
    for (const [path, bytes] of files) { assert.deepEqual(await readFile(join(temporary, path)), bytes, `Public audit mutated ${path}`); }
    for (const path of packageFiles) { assert.deepEqual(await readFile(join(root, "packages/library", path)), files.get(`A/${path}`)); }
    assert.deepEqual(await readFile(join(root, baselinePath)), original);
    await writeFile(join(root, baselinePath), jsonBytes(snapshot));
    return original;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** The original exact synthetic B remains an active ordinary refusal control. */
export async function assertPackedLegacyPublicApiBaseline(fixture: PackedFixture & { readonly legacyPublicApiBaseline: Uint8Array }, expectedCapabilities: readonly string[]): Promise<void> {
  const root = fixture.consumerRoot; const path = join(root, baselinePath);
  const native = await readFile(path); const legacy = Buffer.from(fixture.legacyPublicApiBaseline);
  try {
    await writeFile(path, legacy);
    const parsed = await failedJson(root, fixture.toolEntrypoints.foundationCli, ["check", "--consumer", root, "--format", "json"], 1);
    const validate = await validator<FoundationCheckReport>(root, "foundation-check-report"); assert.ok(validate(parsed), JSON.stringify(validate.errors));
    assert.equal(parsed.foundationVersion, fixture.packedManifest.version);
    assert.equal(parsed.coverage, "full"); assert.equal(parsed.outcome, "violations");
    assert.deepEqual(parsed.summary, { errors: 1, warnings: 0, infos: 0 });
    assert.deepEqual(parsed.capabilities.map(capability => capability.capabilityId), expectedCapabilities);
    for (const capability of parsed.capabilities) {
      const typed = capability.capabilityId === "package.public-api-compatibility";
      assert.equal(capability.problem, undefined); assert.equal(capability.outcome, typed ? "violations" : "passed");
      assert.deepEqual(capability.summary, { errors: typed ? 1 : 0, warnings: 0, infos: 0 });
    }
    const diagnostics = parsed.capabilities.flatMap(capability => capability.diagnostics);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.ruleId, "package.public-api-compatibility.baseline-tool-mismatch");
    assert.equal(diagnostics[0]?.subject, packageName); assert.equal(diagnostics[0]?.location?.path, baselinePath);
    assert.deepEqual(await readFile(path), legacy);
  } finally { await writeFile(path, native); }
  assert.deepEqual(await readFile(path), native);
}
