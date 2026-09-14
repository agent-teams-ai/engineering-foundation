import { writeFileSync } from "node:fs";
import { Extractor } from "@microsoft/api-extractor";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import Ajv from "ajv/dist/2020.js";
import { MicrosoftPublicApiObserver } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/microsoft-public-api-observer.js";
import { runPublicApiAudit } from "../dist/capabilities/public-api-compatibility/node.js";
import { runFoundationCli } from "../dist/features/command-host/adapters/inbound/cli/foundation-cli.js";
import { parseArguments } from "../dist/features/command-host/adapters/inbound/cli/cli-arguments.js";
import { FilesystemPublicApiAuditInputs, AUDIT_MAX_BYTES } from "../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-audit-inputs.js";
import { auditPublicApi } from "../dist/capabilities/public-api-compatibility/application/use-cases/audit-public-api.js";
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function schemas() {
  const ajv = new Ajv({ strict: true, allErrors: true });
  const validators = {};
  for (const kind of ["request", "report"]) {validators[`package-public-api-audit-${kind}/v1`] = ajv.compile(JSON.parse(await readFile(new URL(`../schemas/package-public-api-audit-${kind}/v1.schema.json`, import.meta.url), "utf8")));}
  validators["package-public-api-baseline/v1"] = ajv.compile(JSON.parse(await readFile(new URL("../schemas/package-public-api-baseline/v1.schema.json", import.meta.url), "utf8")));
  return async (id, input) => { const validate = validators[id]; assert.ok(validate(input), JSON.stringify(validate.errors)); };
}

test("report comparison bound covers the entire bounded package union without truncation", async () => {
  const request = JSON.parse(await readFile(new URL("../schemas/package-public-api-audit-request/v1.schema.json", import.meta.url), "utf8"));
  const report = JSON.parse(await readFile(new URL("../schemas/package-public-api-audit-report/v1.schema.json", import.meta.url), "utf8"));
  const subjects = request.$defs.subjects.properties;
  const maximum = 3 * (request.$defs.subjectA.properties.packages.maxItems + subjects.B.properties.baselines.maxItems + request.$defs.subjectC.properties.packages.maxItems);
  const comparisons = report.$defs.report.properties.comparisons;
  assert.equal(comparisons.maxItems, maximum);
  const validate = new Ajv({ strict: true }).compile({ type: "array", maxItems: comparisons.maxItems });
  assert.equal(validate(Array(maximum).fill(null)), true);
  assert.equal(validate(Array(maximum + 1).fill(null)), false);
});

for (const mode of ["hidden", "internal"]) {test(`A/B/C ${mode} mutation retains rich findings and historical semantics`, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-audit-command-test-"));
  try {
    const subjects = {};
    for (const subject of ["A", "C"]) {
      await mkdir(join(root, subject));
      const files = { [`${subject}/package.json`]: JSON.stringify({ name: "audit-fixture", version: "1.0.0", exports: { ".": { types: "./index.d.ts" } } }),
        [`${subject}/index.d.ts`]: mode === "internal" ? `/** @internal */\nexport declare function _f(): ${subject === "A" ? "string" : "number"};\n` : `type Hidden = ${subject === "A" ? "string" : "number"}; declare function f(x: Hidden): Hidden; export { f };\n`,
        [`${subject}/tsconfig.json`]: JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, skipLibCheck: false }, files: ["index.d.ts"] }) };
      for (const [path, bytes] of Object.entries(files)) {await writeFile(join(root, path), bytes);}
      const inventory = Object.entries(files).map(([path, bytes]) => ({ path, digest: digest(bytes) }));
      subjects[subject] = { packages: [{ packageName: "audit-fixture", packageVersion: "1.0.0", manifestPath: `${subject}/package.json`, tsconfigPath: `${subject}/tsconfig.json`, entrypoints: [{ exportPath: ".", declarationEntryPoint: `${subject}/index.d.ts` }], nonTypeExports: [] }], files: inventory,
        resolutionUniverse: [{ packageName: "audit-fixture", exportPath: ".", declarationPath: `${subject}/index.d.ts` }],
        ...(subject === "A" ? { archive: { digest: digest("supplied archive assertion"), extractedMembers: inventory } } : { build: { sourceIdentity: "test-source", buildIdentity: "test-build", declarations: inventory.filter(file => file.path.endsWith(".d.ts")) } }) };
    }
    const baseline = JSON.stringify({ schemaVersion: 1, packageName: "audit-fixture", packageVersion: "1.0.0", extractorVersion: "7.58.12", entrypoints: [{ exportPath: ".", items: mode === "internal" ? [] : [{ canonicalReference: "audit-fixture!f:function(1)", kind: "Function", parentReference: "audit-fixture!", parentKind: "EntryPoint", signature: "export declare function f(x: Hidden): Hidden;" }] }] });
    await writeFile(join(root, "baseline.json"), baseline);
    subjects.B = { baselines: [{ packageName: "audit-fixture", path: "baseline.json", digest: digest(baseline) }] };
    const request = { schemaVersion: 1, subjects };
    const requestBytes = JSON.stringify(request);
    await writeFile(join(root, "request.json"), requestBytes);
    const assertSchema = await schemas();
    const report = await runPublicApiAudit({ consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" }, assertSchema);
    assert.deepEqual(await runPublicApiAudit({ consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" }, assertSchema), report);
    assert.equal(report.releaseEligible, false);
    assert.equal(report.exitCode, mode === "internal" ? 0 : 2);
    assert.equal(report.evidenceComplete, true);
    assert.deepEqual(report.comparisons.map(comparison => [comparison.pair, comparison.scope, comparison.eligibility.eligible]), [["A-B", "historical-stored-surface", true], ["B-C", "historical-stored-surface", true], ["A-C", "declaration-graph", true]]);
    assert.equal(report.comparisons[2].findings.classification, "breaking");
    if (mode === "internal") {
      assert.deepEqual(report.observations.map(observation => observation.items.map(item => item.identity.canonicalReference)), [["audit-fixture!_f:function(1)"], ["audit-fixture!_f:function(1)"]]);
      assert.deepEqual(report.observations.map(observation => observation.storedSurface.entrypoints[0].items), [[], []]);
      assert.deepEqual(report.comparisons.slice(0, 2).map(comparison => comparison.findings.classification), ["none", "none"]);
    }
    assert.ok(report.comparisons[0].limitations.some(value => value.includes("B lacks")));
    assert.equal(await readFile(join(root, "baseline.json"), "utf8"), baseline);
    assert.equal(await readFile(join(root, "request.json"), "utf8"), requestBytes);
    await assert.rejects(assertSchema("package-public-api-audit-request/v1", { ...request, eligible: true }));
    // Removing the last typed export produces an observed empty surface, not an
    // invented model or an unavailable comparison. The private tree still compiles.
    const releasedDeclaration = "export type Hidden = string; export declare function f(x: Hidden): Hidden;\n";
    await writeFile(join(root, "A/index.d.ts"), releasedDeclaration);
    subjects.A.files = subjects.A.files.map(file => file.path === "A/index.d.ts" ? { ...file, digest: digest(releasedDeclaration) } : file);
    subjects.A.archive.extractedMembers = subjects.A.files;
    const untypedManifest = JSON.stringify({ name: "audit-fixture", version: "1.0.0", exports: { "./package.json": "./package.json" } });
    await writeFile(join(root, "C/package.json"), untypedManifest);
    subjects.C.files = subjects.C.files.map(file => file.path === "C/package.json" ? { ...file, digest: digest(untypedManifest) } : file);
    subjects.C.packages[0].entrypoints = [];
    subjects.C.packages[0].nonTypeExports = [{ exportPath: "./package.json", kind: "data" }];
    subjects.C.resolutionUniverse = [];
    await writeFile(join(root, "request.json"), JSON.stringify(request));
    const removed = await runPublicApiAudit({ consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" }, assertSchema);
    const empty = removed.observations.find(observation => observation.subject === "C");
    assert.equal(empty.exportPath, null);
    assert.equal(empty.modelExpected, false);
    assert.equal(empty.modelPresent, false);
    assert.equal(empty.invocation.outcome, "not-invoked");
    assert.equal(empty.invocation.succeeded, false);
    assert.equal(empty.compilerDiagnosticsCollected, true);
    assert.deepEqual(empty.storedSurface.entrypoints, []);
    assert.equal(removed.exitCode, 0);
    assert.equal(removed.releaseEligible, false);
    assert.equal(removed.custody.archiveDigestVerified, false);
    assert.equal(removed.custody.archiveInventoryCompletenessVerified, false);
    assert.deepEqual(removed.comparisons.find(comparison => comparison.pair === "A-C").findings.removedEntrypoints, ["."]);
    assert.equal(await readFile(join(root, "baseline.json"), "utf8"), baseline);
  } finally { await rm(root, { recursive: true, force: true }); }
});}
test("CLI parser requires explicit read-only audit options", () => {
  assert.equal(parseArguments(["public-api-audit", "--consumer", ".", "--config", "audit.json", "--format", "json"]).command, "public-api-audit");
  assert.throws(() => parseArguments(["public-api-audit", "--format", "json"]));
  assert.throws(() => parseArguments(["public-api-audit", "--config", "audit.json", "--format", "json", "--write"]));
});

test("existing CLI renders audit failures as schema-valid exit 2 evidence", async () => {
  const originalWrite = process.stdout.write;
  const originalExit = process.exitCode;
  let output = "";
  process.stdout.write = function (chunk, ...args) {
    if (typeof chunk === "string" && chunk.startsWith('{"schemaVersion":1,"operation":"public-api-audit"')) { output += chunk; return true; }
    return originalWrite.call(this, chunk, ...args);
  };
  try {
    await runFoundationCli(() => ({ qualityGate: async () => false,
      cancellation: { withSignal: async (_signals, action) => action(new AbortController().signal) },
      auditPublicApi: async () => { throw new Error("Invalid audit digest"); }
    }), ["public-api-audit", "--consumer", ".", "--config", "request.json", "--format", "json"]);
    assert.equal(process.exitCode, 2);
    const report = JSON.parse(output);
    await (await schemas())("package-public-api-audit-report/v1", report);
    assert.equal(report.releaseEligible, false);
    assert.deepEqual(report.errors, ["Error: Invalid audit digest"]);
  } finally { process.stdout.write = originalWrite; process.exitCode = originalExit; }
});

async function custodyFixture(root) {
  const subjects = {};
  for (const subject of ["A", "C"]) {
    await mkdir(join(root, subject));
    const files = {
      [`${subject}/package.json`]: JSON.stringify({ name: "audit-custody", version: "1.0.0", exports: { ".": { types: "./index.d.ts" } } }),
      [`${subject}/index.d.ts`]: '/** @internal */\nexport declare function _f(): string;\n',
      [`${subject}/tsconfig.json`]: JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, skipLibCheck: false }, files: ["index.d.ts"] })
    };
    for (const [path, content] of Object.entries(files)) { await writeFile(join(root, path), content); }
    const inventory = Object.entries(files).map(([path, content]) => ({ path, digest: digest(content) }));
    subjects[subject] = {
      packages: [{ packageName: "audit-custody", packageVersion: "1.0.0", manifestPath: `${subject}/package.json`, tsconfigPath: `${subject}/tsconfig.json`, entrypoints: [{ exportPath: ".", declarationEntryPoint: `${subject}/index.d.ts` }], nonTypeExports: [] }],
      files: inventory, resolutionUniverse: [{ packageName: "audit-custody", exportPath: ".", declarationPath: `${subject}/index.d.ts` }],
      ...(subject === "A" ? { archive: { digest: digest("supplied"), extractedMembers: inventory } }
        : { build: { sourceIdentity: "synthetic", buildIdentity: "synthetic", declarations: inventory.filter(file => file.path.endsWith(".d.ts")) } })
    };
  }
  const baseline = JSON.stringify({ schemaVersion: 1, packageName: "audit-custody", packageVersion: "1.0.0", extractorVersion: "7.58.12", entrypoints: [{ exportPath: ".", items: [] }] });
  await writeFile(join(root, "baseline.json"), baseline);
  subjects.B = { baselines: [{ packageName: "audit-custody", path: "baseline.json", digest: digest(baseline) }] };
  return { schemaVersion: 1, subjects };
}

for (const fault of ["missing", "digest-mismatch"]) {
  test(`filesystem historical B ${fault} retains valid A-C findings`, async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation-audit-baseline-isolation-"));
    try {
      const request = await custodyFixture(root);
      const changed = '/** @internal */\nexport declare function _f(): number;\n';
      await writeFile(join(root, "C/index.d.ts"), changed);
      request.subjects.C.files = request.subjects.C.files.map(file => file.path === "C/index.d.ts" ? { ...file, digest: digest(changed) } : file);
      request.subjects.C.build.declarations = request.subjects.C.files.filter(file => file.path.endsWith(".d.ts"));
      const assertSchema = await schemas();
      const run = async () => {
        await writeFile(join(root, "request.json"), JSON.stringify(request));
        return runPublicApiAudit({ consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" }, assertSchema);
      };
      const valid = await run();
      assert.equal(valid.exitCode, 0);
      const rich = valid.comparisons.find(comparison => comparison.pair === "A-C");
      assert.equal(rich.eligibility.eligible, true);
      assert.equal(rich.findings.classification, "breaking");
      if (fault === "missing") { await rm(join(root, "baseline.json")); }
      else { await writeFile(join(root, "baseline.json"), "{}\n"); }
      const report = await run();
      await assertSchema("package-public-api-audit-report/v1", report);
      assert.equal(report.exitCode, 2);
      assert.equal(report.evidenceComplete, false);
      assert.equal(report.releaseEligible, false);
      assert.deepEqual(report.observations, valid.observations);
      assert.deepEqual(report.comparisons.find(comparison => comparison.pair === "A-C"), rich);
      assert.equal(report.errors.length, 1);
      assert.match(report.errors[0], /^B\/audit-custody: /u);
      assert.match(report.errors[0], fault === "missing" ? /ENOENT/u : /Baseline digest mismatch/u);
      for (const historicalComparison of report.comparisons.filter(comparison => comparison.pair !== "A-C")) {
        assert.equal(historicalComparison.eligibility.eligible, false);
        assert.ok(historicalComparison.eligibility.reasons.includes("stored-surface-unavailable"));
        assert.equal(historicalComparison.findings, undefined);
      }
      // Duplicate identities remain structural errors even when the first B is unreadable.
      request.subjects.B.baselines.push({ ...request.subjects.B.baselines[0], path: "other.json" });
      await assert.rejects(run(), /Duplicate historical package/u);
      request.subjects.B.baselines.pop();
      // B isolation must not relax the initial validation of either subject's custody.
      for (const subject of ["A", "C"]) {
        const custody = subject === "A" ? request.subjects.A.archive.extractedMembers : request.subjects.C.build.declarations;
        const original = custody[0];
        // Custody and input inventory entries share objects in the fixture.
        // Replace the custody entry so only custody fails, while input bytes stay valid.
        const independentCustody = custody.map((file, index) => index === 0 ? { ...file, digest: digest("invalid custody") } : file);
        if (subject === "A") { request.subjects.A.archive.extractedMembers = independentCustody; }
        else { request.subjects.C.build.declarations = independentCustody; }
        await assert.rejects(run(), /Audit digest mismatch/u);
        independentCustody[0] = original;
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

async function admitCustodyFile(root, request, path, content) {
  await writeFile(join(root, path), content);
  const subject = request.subjects.A;
  subject.files = [...subject.files.filter(file => file.path !== path), { path, digest: digest(content) }];
  subject.archive.extractedMembers = subject.files;
}

test("full report rejects undeclared SDK sidecars and escaping mapped sources; admitted maps retain custody", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-audit-custody-"));
  try {
    const request = await custodyFixture(root);
    const assertSchema = await schemas();
    const run = async () => {
      await writeFile(join(root, "request.json"), JSON.stringify(request));
      return runPublicApiAudit({ consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" }, assertSchema);
    };
    const before = await run();
    assert.equal(before.exitCode, 0);
    assert.equal(before.evidenceComplete, true);
    for (const filename of ["index.d.ts.map", "tsdoc-metadata.json"]) {
      await writeFile(join(root, "A", filename), "{}");
      const rejected = await run();
      assert.equal(rejected.requestDigest, before.requestDigest);
      assert.equal(rejected.exitCode, 2);
      assert.equal(rejected.evidenceComplete, false);
      assert.equal(rejected.observations[0].inputBytesRevalidated, false);
      assert.ok(rejected.observations[0].unsupported.some(reason => reason.includes("Undeclared SDK input")));
      await rm(join(root, "A", filename));
    }
    await symlink(join(root, "A/package.json"), join(root, "A/index.d.ts.map"));
    const linked = await run();
    assert.equal(linked.exitCode, 2);
    assert.equal(linked.evidenceComplete, false);
    assert.ok(linked.observations[0].unsupported.some(reason => reason.includes("symlink unsupported")));
    await rm(join(root, "A/index.d.ts.map"));
    await admitCustodyFile(root, request, "A/index.d.ts.map", JSON.stringify({ version: 3, sources: ["../../escape.ts"], names: [], mappings: "AAAA" }));
    const escaped = await run();
    assert.equal(escaped.exitCode, 2);
    assert.equal(escaped.evidenceComplete, false);
    assert.ok(escaped.observations[0].unsupported.some(reason => reason.includes("escapes verified evidence")));
    await rm(join(root, "A/index.d.ts.map"));
    request.subjects.A.files = request.subjects.A.files.filter(file => file.path !== "A/index.d.ts.map");
    request.subjects.A.archive.extractedMembers = request.subjects.A.files;
    const manifestBytes = await readFile(join(root, "A/package.json"), "utf8");
    await admitCustodyFile(root, request, "A/package.json", JSON.stringify({ ...JSON.parse(manifestBytes), tsdocMetadata: "../../escape.json" }));
    const metadataEscape = await run();
    assert.equal(metadataEscape.exitCode, 2);
    assert.equal(metadataEscape.evidenceComplete, false);
    assert.ok(metadataEscape.observations[0].unsupported.some(reason => reason.includes("escapes verified evidence: ../../escape.json")));
    await admitCustodyFile(root, request, "A/package.json", manifestBytes);
    await admitCustodyFile(root, request, "A/source.ts", '/** @internal */\nexport function _f(): string { return ""; }\n');
    await admitCustodyFile(root, request, "A/index.d.ts.map", JSON.stringify({ version: 3, sourceRoot: ".", sources: ["source.ts"], names: [], mappings: "AAAA;AACA" }));
    const admitted = await run();
    assert.equal(admitted.exitCode, 0, JSON.stringify(admitted.observations));
    assert.equal(admitted.evidenceComplete, true);
    assert.equal(admitted.observations[0].inputBytesRevalidated, true);
    assert.deepEqual(await run(), admitted);
    const invoke = Extractor.invoke;
    for (const path of ["A/source.ts", "A/index.d.ts.map"]) {
      const originalBytes = await readFile(join(root, path));
      try {
        Extractor.invoke = function (...args) {
          writeFileSync(join(root, path), "changed after staging");
          return invoke.apply(this, args);
        };
        const mutated = await run();
        assert.equal(mutated.exitCode, 2);
        assert.equal(mutated.evidenceComplete, false);
        assert.equal(mutated.observations[0].inputBytesRevalidated, false);
        assert.equal(mutated.observations[0].modelDigest, admitted.observations[0].modelDigest);
        assert.ok(mutated.observations[0].unsupported.some(reason => reason.includes("changed during observation")));
      } finally { Extractor.invoke = invoke; await writeFile(join(root, path), originalBytes); }
    }
    await admitCustodyFile(root, request, "A/source.ts", '/** @internal */\nexport function _f(): string { return ""; }\n');
    try {
      Extractor.invoke = function (...args) {
        writeFileSync(join(root, "A/tsdoc-metadata.json"), "undeclared presence after staging");
        return invoke.apply(this, args);
      };
      const created = await run();
      assert.equal(created.exitCode, 2);
      assert.equal(created.evidenceComplete, false);
      assert.equal(created.observations[0].inputBytesRevalidated, false);
      assert.ok(created.observations[0].unsupported.some(reason => reason.includes("presence changed")));
    } finally { Extractor.invoke = invoke; }


  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const fault of ["permission-restore", "removal", "both"]) {
  test(`cleanup ${fault} failure retains failed extraction and reports incomplete exit 2`, async (t) => {
    const fs = (await import("node:fs/promises")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const root = await mkdtemp(join(tmpdir(), "foundation-audit-cleanup-test-"));
    const owned = new Set();
    const originalChmod = fs.chmod;
    const originalRm = fs.rm;
    let restoreAttempts = 0;
    let removalAttempts = 0;
    try {
      const request = await custodyFixture(root);
      await admitCustodyFile(root, request, "A/index.d.ts", "type Hidden = string; declare function f(x: Hidden): Hidden; export { f };\n");
      await writeFile(join(root, "request.json"), JSON.stringify(request));
      t.mock.method(fs, "chmod", async (path, mode) => {
        if (String(path).includes("foundation-public-api-audit-") && mode === 0o700) {
          restoreAttempts++;
          if (fault !== "removal" && /[\\/][AC]$/u.test(String(path))) {
            await originalChmod(path, mode);
            throw new Error("injected permission restoration failure");
          }
        }
        return originalChmod(path, mode);
      });
      t.mock.method(fs, "rm", async (path, options) => {
        if (String(path).includes("foundation-public-api-audit-")) {
          removalAttempts++;
          owned.add(path);
          if (fault !== "permission-restore") { throw new Error("injected owned removal failure"); }
        }
        return originalRm(path, options);
      });
      syncBuiltinESMExports();
      const report = await runPublicApiAudit({ consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" }, await schemas());
      assert.equal(report.exitCode, 2);
      assert.equal(report.evidenceComplete, false);
      assert.equal(report.releaseEligible, false);
      assert.equal(restoreAttempts, 4);
      assert.equal(removalAttempts, 2);
      assert.equal(report.observations.length, 2);
      const failed = report.observations[0];
      assert.deepEqual(failed.invocation, { outcome: "completed", succeeded: false, errorCount: 1, warningCount: 0 });
      assert.equal(failed.compilerDiagnosticsCollected, true);
      assert.equal(failed.modelPresent, true);
      assert.ok(failed.modelDigest.startsWith("sha256:"));
      assert.deepEqual(failed.items.map(item => item.identity.canonicalReference).toSorted(), ["audit-custody!f:function(1)", "audit-custody!~Hidden:type"]);
      assert.deepEqual(failed.diagnostics.filter(d => d.severity === "error").map(d => d.id), ["ae-forgotten-export"]);
      for (const observation of report.observations) {
        assert.deepEqual(observation.unsupported.map(reason => reason.split(": ")[1]), fault === "both" ? ["permission-restore", "removal"] : [fault]);
        assert.ok(observation.unsupported.every(reason => reason.startsWith("owned-resource-cleanup:") && [...owned].some(path => reason.includes(path))));
      }
      assert.equal(report.comparisons.find(comparison => comparison.pair === "A-C").eligibility.eligible, false);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      for (const path of owned) {
        await originalChmod(join(path, "evidence"), 0o700).catch(error => { if (error.code !== "ENOENT") { throw error; } });
        await originalRm(path, { recursive: true, force: true });
      }
      await originalRm(root, { recursive: true, force: true });
    }
  });
}

test("all B-only entries validate in isolation, including aggregate exhaustion", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-audit-b-only-"));
  try {
    const request = await custodyFixture(root);
    const changed = '/** @internal */\nexport declare function _f(): number;\n';
    await writeFile(join(root, "C/index.d.ts"), changed);
    request.subjects.C.files = request.subjects.C.files.map(file => file.path === "C/index.d.ts" ? { ...file, digest: digest(changed) } : file);
    request.subjects.C.build.declarations = request.subjects.C.files.filter(file => file.path.endsWith(".d.ts"));
    const assertSchema = await schemas();
    const input = { consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" };
    await writeFile(join(root, "request.json"), JSON.stringify(request));
    const valid = await runPublicApiAudit(input, assertSchema);
    assert.equal(valid.exitCode, 0);
    assert.equal(valid.comparisons[2].findings.classification, "breaking");
    const inputs = new FilesystemPublicApiAuditInputs(value => assertSchema("package-public-api-audit-request/v1", value), value => assertSchema("package-public-api-baseline/v1", value));
    // Reuse admitted synthetic observations to keep filesystem cases independent of SDK cost.
    const dependencies = { inputs, observer: { observe: async ({ subject }) => valid.observations.filter(value => value.subject === subject) }, fingerprint: { sha256: value => digest(value).slice(7) } };
    const baseline = request.subjects.B.baselines[0];
    const only = JSON.stringify({ schemaVersion: 1, packageName: "z-only", packageVersion: "1.0.0", extractorVersion: "7.58.12", items: [] });
    await writeFile(join(root, "only.json"), only);
    await symlink(join(root, "only.json"), join(root, "alias.json"));
    const oversized = await open(join(root, "oversized.json"), "w");
    try { await oversized.truncate(AUDIT_MAX_BYTES + 1); } finally { await oversized.close(); }
    await writeFile(join(root, "invalid.json"), "{}");
    for (const [path, hash, error] of [
      ["only.json", digest(only), undefined],
      ["missing.json", digest(only), /ENOENT/u],
      ["../escape.json", digest(only), /Invalid audit path/u],
      ["alias.json", digest(only), /symlink/u],
      ["oversized.json", digest(only), /byte budget exhausted/u],
      ["only.json", digest("wrong"), /Baseline digest mismatch/u],
      ["invalid.json", digest("{}"), /AssertionError/u]
    ]) {
      request.subjects.B.baselines = [baseline, { packageName: "z-only", path, digest: hash }];
      await writeFile(join(root, "request.json"), JSON.stringify(request));
      const report = await auditPublicApi(input, dependencies);
      await assertSchema("package-public-api-audit-report/v1", report);
      assert.equal(report.exitCode, 2);
      assert.equal(report.evidenceComplete, false);
      assert.equal(report.releaseEligible, false);
      assert.deepEqual(report.comparisons.find(value => value.pair === "A-C" && value.packageName === "audit-custody"), valid.comparisons[2]);
      assert.ok(report.comparisons.filter(value => value.packageName === "z-only").every(value => !value.eligibility.eligible && value.findings === undefined));
      if (error) { assert.equal(report.errors.length, 1); assert.match(report.errors[0], /^B\/z-only:/u); assert.match(report.errors[0], error); }
      else { assert.deepEqual(report.errors, []); }
    }
    const padded = only.padEnd(16 * 1024, " ");
    await writeFile(join(root, "only.json"), padded);
    // Even identity-invalid bytes consume B's cumulative budget. The request
    // stays within the schema's 4,096-entry limit and each file is only 16 KiB.
    request.subjects.B.baselines = [baseline, ...Array.from({ length: AUDIT_MAX_BYTES / Buffer.byteLength(padded) }, (_, index) => ({ packageName: `z-${String(index).padStart(4, "0")}`, path: "only.json", digest: digest(padded) }))];
    await writeFile(join(root, "request.json"), JSON.stringify(request));
    const exhausted = await runPublicApiAudit(input, assertSchema);
    await assertSchema("package-public-api-audit-report/v1", exhausted);
    assert.equal(exhausted.comparisons.length, 3 * request.subjects.B.baselines.length);
    for (const entry of request.subjects.B.baselines) {
      assert.deepEqual(exhausted.comparisons.filter(value => value.packageName === entry.packageName).map(value => value.pair), ["A-B", "B-C", "A-C"]);
    }
    assert.equal(exhausted.exitCode, 2);
    assert.equal(exhausted.evidenceComplete, false);
    assert.equal(exhausted.releaseEligible, false);
    assert.match(exhausted.errors.at(-1), /byte budget exhausted/u);
    assert.deepEqual(exhausted.comparisons.find(value => value.pair === "A-C" && value.packageName === "audit-custody"), valid.comparisons[2]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("public audit retains the combined maximum errors and rejects one beyond the schema bound", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foundation-audit-error-bound-"));
  try {
    const requestSchema = JSON.parse(await readFile(new URL("../schemas/package-public-api-audit-request/v1.schema.json", import.meta.url), "utf8"));
    const reportSchema = JSON.parse(await readFile(new URL("../schemas/package-public-api-audit-report/v1.schema.json", import.meta.url), "utf8"));
    const baselineMaximum = requestSchema.$defs.subjects.properties.B.properties.baselines.maxItems;
    const maximum = baselineMaximum + 2 + 1;
    assert.equal(maximum, 4099);
    assert.equal(reportSchema.$defs.report.properties.errors.maxItems, maximum);
    const request = await custodyFixture(root);
    request.subjects.B.baselines = Array.from({ length: baselineMaximum }, (_, index) => ({
      packageName: `b-${String(index).padStart(4, "0")}`, path: "missing.json", digest: digest("missing")
    }));
    await writeFile(join(root, "request.json"), JSON.stringify(request));
    const observe = MicrosoftPublicApiObserver.prototype.observe;
    const subjects = [];
    t.mock.method(MicrosoftPublicApiObserver.prototype, "observe", async function (input) {
      subjects.push(input.subject);
      // Initial request/custody validation succeeds. Subsequent observation and
      // revalidation see a real missing input, without invoking the SDK.
      await rm(join(root, input.subject, "package.json"));
      return observe.call(this, input);
    });
    const assertSchema = await schemas();
    const report = await runPublicApiAudit({ consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" }, assertSchema);
    assert.deepEqual(subjects, ["A", "C"]);
    assert.equal(report.errors.length, maximum);
    assert.match(report.errors[0], /^A:.*ENOENT/u);
    assert.match(report.errors[1], /^C:.*ENOENT/u);
    assert.match(report.errors[2], /^Input revalidation failed:.*ENOENT/u);
    assert.deepEqual(report.errors.slice(3).map(error => error.split(":")[0]), request.subjects.B.baselines.map(entry => `B/${entry.packageName}`));
    assert.equal(report.comparisons.length, 3 * (baselineMaximum + 1));
    assert.deepEqual([...new Set(report.comparisons.map(value => value.packageName))], ["audit-custody", ...request.subjects.B.baselines.map(entry => entry.packageName)]);
    assert.ok(report.comparisons.every(value => !value.eligibility.eligible));
    assert.deepEqual(report.observations, []);
    assert.deepEqual(report.custody.supplied, request.subjects);
    assert.equal(report.requestDigest, digest(JSON.stringify(request)));
    assert.equal(report.exitCode, 2);
    assert.equal(report.evidenceComplete, false);
    assert.equal(report.releaseEligible, false);
    await assertSchema("package-public-api-audit-report/v1", report);
    await assert.rejects(assertSchema("package-public-api-audit-report/v1", { ...report, errors: [...report.errors, "overflow"] }), /maxItems/u);
  } finally { t.mock.restoreAll(); await rm(root, { recursive: true, force: true }); }
});
