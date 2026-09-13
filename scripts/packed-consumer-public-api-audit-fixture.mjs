const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import { captureFailure, runCommand } from "./pack-test-support.mjs";

/** Qualify the installed public binary and schema exports on immutable synthetic evidence. */
export async function assertPublicApiAudit(fixture) {
  const requireFromConsumer = createRequire(join(fixture.consumerRoot, "package.json"));
  const validators = {};
  const ajv = new Ajv({ strict: true, allErrors: true });
  for (const kind of ["request", "report"]) {
    const schemaPath = requireFromConsumer.resolve(`@agent-teams/engineering-foundation/schemas/package-public-api-audit-${kind}/v1.schema.json`);
    validators[kind] = ajv.compile(JSON.parse(await readFile(schemaPath, "utf8")));
  }
  const binary = join(fixture.toolEntrypoints.foundationRoot, fixture.packedManifest.bin["agent-teams-foundation"]);
  const root = await mkdtemp(join(tmpdir(), "foundation-packed-public-api-audit-"));
  try {
    for (const mode of ["successful", "failed-extraction", "invalid-input"]) {
      const expectedBytes = new Map();
      const subjects = {};
      for (const subject of ["A", "C"]) {
        await mkdir(join(root, subject), { recursive: true });
        const type = subject === "A" ? "string" : "number";
        const files = {
          [`${subject}/package.json`]: JSON.stringify({ name: "packed-audit-fixture", version: "1.0.0", exports: { ".": { types: "./index.d.ts" } } }),
          [`${subject}/index.d.ts`]: mode === "failed-extraction"
            ? `type Hidden = ${type}; declare function f(): Hidden; export { f };\n`
            : `/** @internal */\nexport declare function _f(): ${type};\n`,
          [`${subject}/tsconfig.json`]: JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, skipLibCheck: false }, files: ["index.d.ts"] })
        };
        for (const [path, bytes] of Object.entries(files)) {expectedBytes.set(path, bytes);}
        const inventory = Object.entries(files).map(([path, bytes]) => ({ path, digest: digest(bytes) }));
        subjects[subject] = {
          packages: [{ packageName: "packed-audit-fixture", packageVersion: "1.0.0", manifestPath: `${subject}/package.json`, tsconfigPath: `${subject}/tsconfig.json`, entrypoints: [{ exportPath: ".", declarationEntryPoint: `${subject}/index.d.ts` }], nonTypeExports: [] }],
          files: inventory,
          resolutionUniverse: [{ packageName: "packed-audit-fixture", exportPath: ".", declarationPath: `${subject}/index.d.ts` }],
          ...(subject === "A" ? { archive: { digest: digest("supplied synthetic archive"), extractedMembers: inventory } }
            : { build: { sourceIdentity: "synthetic-source", buildIdentity: "synthetic-build", declarations: inventory.filter(file => file.path.endsWith(".d.ts")) } })
        };
      }
      const baseline = JSON.stringify({ schemaVersion: 1, packageName: "packed-audit-fixture", packageVersion: "1.0.0", extractorVersion: "7.58.12", entrypoints: [{ exportPath: ".", items: [] }] });
      expectedBytes.set("baseline.json", baseline);
      subjects.B = { baselines: [{ packageName: "packed-audit-fixture", path: "baseline.json", digest: digest(baseline) }] };
      const request = { schemaVersion: 1, subjects };
      assert.equal(validators.request(request), true, JSON.stringify(validators.request.errors));
      if (mode === "invalid-input") {request.eligible = true;}
      expectedBytes.set("request.json", JSON.stringify(request));
      for (const [path, bytes] of expectedBytes) {await writeFile(join(root, path), bytes);}
      const args = [binary, "public-api-audit", "--consumer", root, "--config", "request.json", "--format", "json"];
      let stdout;
      if (mode === "successful") {
        ({ stdout } = await runCommand(process.execPath, args, fixture.consumerRoot));
      } else {
        const failure = await captureFailure(() => runCommand(process.execPath, args, fixture.consumerRoot));
        assert.equal(failure?.code, 2, `${mode} must exit 2`);
        stdout = failure.stdout;
      }
      const report = JSON.parse(stdout);
      assert.equal(validators.report(report), true, JSON.stringify(validators.report.errors));
      assert.equal(report.releaseEligible, false);
      assert.equal(report.exitCode, mode === "successful" ? 0 : 2);
      assert.equal(report.evidenceComplete, mode !== "invalid-input");
      if (mode === "invalid-input") {
        assert.ok(report.errors.length > 0);
      } else {
        assert.deepEqual(report.comparisons.map(comparison => [comparison.pair, comparison.eligibility.eligible]), [["A-B", true], ["B-C", true], ["A-C", true]]);
        assert.equal(report.comparisons[2].findings.classification, "breaking");
        assert.ok(report.comparisons[0].limitations.some(reason => reason.includes("B lacks")));
        assert.equal(report.observations.length, 2);
        assertObservations(report.observations, mode);
      }
      for (const [path, bytes] of expectedBytes) {assert.equal(await readFile(join(root, path), "utf8"), bytes, `Audit mutated ${path}`);}
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}


function assertObservations(observations, mode) {
        for (const observation of observations) {
          assert.equal(observation.invocation.succeeded, mode === "successful");
          assert.deepEqual(observation.configurationDependencies.map(file => file.path).toSorted(), [`${observation.subject}/package.json`, `${observation.subject}/tsconfig.json`]);
          assert.ok(observation.sourceFiles.some(file => file.path === `${observation.subject}/index.d.ts`));
          if (mode === "failed-extraction") {assert.ok(observation.diagnostics.some(diagnostic => diagnostic.id === "ae-forgotten-export" && diagnostic.severity === "error"));}
        }
}
