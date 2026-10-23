import * as registeredCases1 from "./public-api-audit-history-cases.ts";
void registeredCases1;
import * as registeredCases2 from "./public-api-audit-baseline-bound-cases.ts";
void registeredCases2;
import { schemas, custodyFixture, admitCustodyFile } from "./public-api-audit-command-fixture.ts";
import { writeFileSync } from "node:fs";
import { ApiPackage } from "@microsoft/api-extractor-model";

import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv from "ajv/dist/2020.js";

import { runPublicApiAudit } from "../dist/capabilities/public-api-compatibility/node.js";
import { runFoundationCli } from "../dist/features/command-host/adapters/inbound/cli/foundation-cli.js";
import { parseArguments } from "../dist/features/command-host/adapters/inbound/cli/cli-arguments.js";

test("report comparison bound covers the entire bounded package union without truncation", async () => {
  const request = JSON.parse(
    await readFile(
      new URL("../schemas/package-public-api-audit-request/v1.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const report = JSON.parse(
    await readFile(
      new URL("../schemas/package-public-api-audit-report/v1.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const subjects = request.$defs.subjects.properties;
  const maximum =
    3 *
    (request.$defs.subjectA.properties.packages.maxItems +
      subjects.B.properties.baselines.maxItems +
      request.$defs.subjectC.properties.packages.maxItems);
  const comparisons = report.$defs.report.properties.comparisons;
  assert.equal(comparisons.maxItems, maximum);
  const validate = new Ajv({ strict: true }).compile({
    type: "array",
    maxItems: comparisons.maxItems,
  });
  assert.equal(validate(Array(maximum).fill(null)), true);
  assert.equal(validate(Array(maximum + 1).fill(null)), false);
});

test("CLI parser requires explicit read-only audit options", () => {
  assert.equal(
    parseArguments([
      "public-api-audit",
      "--consumer",
      ".",
      "--config",
      "audit.json",
      "--format",
      "json",
    ]).command,
    "public-api-audit",
  );
  assert.throws(() => parseArguments(["public-api-audit", "--format", "json"]));
  assert.throws(() =>
    parseArguments(["public-api-audit", "--config", "audit.json", "--format", "json", "--write"]),
  );
});

test("existing CLI renders audit failures as schema-valid exit 2 evidence", async () => {
  const originalWrite = process.stdout.write;
  const originalExit = process.exitCode;
  let output = "";
  process.stdout.write = function (chunk, ...args) {
    if (
      typeof chunk === "string" &&
      chunk.startsWith('{"schemaVersion":1,"operation":"public-api-audit"')
    ) {
      output += chunk;
      return true;
    }
    return originalWrite.call(this, chunk, ...args);
  };
  try {
    await runFoundationCli(
      () => ({
        qualityGate: async () => false,
        cancellation: {
          withSignal: async (_signals, action) => action(new AbortController().signal),
        },
        auditPublicApi: async () => {
          throw new Error("Invalid audit digest");
        },
      }),
      ["public-api-audit", "--consumer", ".", "--config", "request.json", "--format", "json"],
    );
    assert.equal(process.exitCode, 2);
    const report = JSON.parse(output);
    await (
      await schemas()
    )("package-public-api-audit-report/v1", report);
    assert.equal(report.releaseEligible, false);
    assert.deepEqual(report.errors, ["Error: Invalid audit digest"]);
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = originalExit;
  }
});

test("full report rejects undeclared SDK sidecars and escaping mapped sources; admitted maps retain custody", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-audit-custody-"));
  try {
    const request = await custodyFixture(root);
    const assertSchema = await schemas();
    const run = async () => {
      await writeFile(join(root, "request.json"), JSON.stringify(request));
      return runPublicApiAudit(
        { consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" },
        assertSchema,
      );
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
      assert.ok(
        rejected.observations[0].unsupported.some((reason) =>
          reason.includes("Undeclared SDK input"),
        ),
      );
      await rm(join(root, "A", filename));
    }
    await symlink(join(root, "A/package.json"), join(root, "A/index.d.ts.map"));
    const linked = await run();
    assert.equal(linked.exitCode, 2);
    assert.equal(linked.evidenceComplete, false);
    assert.ok(
      linked.observations[0].unsupported.some((reason) => reason.includes("symlink unsupported")),
    );
    await rm(join(root, "A/index.d.ts.map"));
    await admitCustodyFile(
      root,
      request,
      "A/index.d.ts.map",
      JSON.stringify({ version: 3, sources: ["../../escape.ts"], names: [], mappings: "AAAA" }),
    );
    const escaped = await run();
    assert.equal(escaped.exitCode, 2);
    assert.equal(escaped.evidenceComplete, false);
    assert.ok(
      escaped.observations[0].unsupported.some((reason) =>
        reason.includes("escapes verified evidence"),
      ),
    );
    await rm(join(root, "A/index.d.ts.map"));
    request.subjects.A.files = request.subjects.A.files.filter(
      (file) => file.path !== "A/index.d.ts.map",
    );
    request.subjects.A.archive.extractedMembers = request.subjects.A.files;
    const manifestBytes = await readFile(join(root, "A/package.json"), "utf8");
    await admitCustodyFile(
      root,
      request,
      "A/package.json",
      JSON.stringify({ ...JSON.parse(manifestBytes), tsdocMetadata: "../../escape.json" }),
    );
    const metadataEscape = await run();
    assert.equal(metadataEscape.exitCode, 2);
    assert.equal(metadataEscape.evidenceComplete, false);
    assert.ok(
      metadataEscape.observations[0].unsupported.some((reason) =>
        reason.includes("escapes verified evidence: ../../escape.json"),
      ),
    );
    await admitCustodyFile(root, request, "A/package.json", manifestBytes);
    await admitCustodyFile(
      root,
      request,
      "A/source.ts",
      '/** @internal */\nexport function _f(): string { return ""; }\n',
    );
    await admitCustodyFile(
      root,
      request,
      "A/index.d.ts.map",
      JSON.stringify({
        version: 3,
        sourceRoot: ".",
        sources: ["source.ts"],
        names: [],
        mappings: "AAAA;AACA",
      }),
    );
    const admitted = await run();
    assert.equal(admitted.exitCode, 0, JSON.stringify(admitted.observations));
    assert.equal(admitted.evidenceComplete, true);
    assert.equal(admitted.observations[0].inputBytesRevalidated, true);
    assert.deepEqual(await run(), admitted);
    const save = ApiPackage.prototype.saveToJsonFile;
    for (const path of ["A/source.ts", "A/index.d.ts.map"]) {
      const originalBytes = await readFile(join(root, path));
      try {
        ApiPackage.prototype.saveToJsonFile = function (...args) {
          writeFileSync(join(root, path), "changed after staging");
          return save.apply(this, args);
        };
        const mutated = await run();
        assert.equal(mutated.exitCode, 2);
        assert.equal(mutated.evidenceComplete, false);
        assert.equal(mutated.observations[0].inputBytesRevalidated, false);
        assert.equal(mutated.observations[0].modelDigest, admitted.observations[0].modelDigest);
        assert.ok(
          mutated.observations[0].unsupported.some((reason) =>
            reason.includes("changed during observation"),
          ),
        );
      } finally {
        ApiPackage.prototype.saveToJsonFile = save;
        await writeFile(join(root, path), originalBytes);
      }
    }
    await admitCustodyFile(
      root,
      request,
      "A/source.ts",
      '/** @internal */\nexport function _f(): string { return ""; }\n',
    );
    try {
      ApiPackage.prototype.saveToJsonFile = function (...args) {
        writeFileSync(join(root, "A/tsdoc-metadata.json"), "undeclared presence after staging");
        return save.apply(this, args);
      };
      const created = await run();
      assert.equal(created.exitCode, 2);
      assert.equal(created.evidenceComplete, false);
      assert.equal(created.observations[0].inputBytesRevalidated, false);
      assert.ok(
        created.observations[0].unsupported.some((reason) => reason.includes("presence changed")),
      );
    } finally {
      ApiPackage.prototype.saveToJsonFile = save;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
      await admitCustodyFile(
        root,
        request,
        "A/index.d.ts",
        "type Hidden = string; declare function f(x: Hidden): Hidden; export { f };\n",
      );
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
          if (fault !== "permission-restore") {
            throw new Error("injected owned removal failure");
          }
        }
        return originalRm(path, options);
      });
      syncBuiltinESMExports();
      const report = await runPublicApiAudit(
        { consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" },
        await schemas(),
      );
      assert.equal(report.exitCode, 2);
      assert.equal(report.evidenceComplete, false);
      assert.equal(report.releaseEligible, false);
      assert.equal(restoreAttempts, 4);
      assert.equal(removalAttempts, 2);
      assert.equal(report.observations.length, 2);
      const failed = report.observations[0];
      assert.deepEqual(failed.invocation, {
        outcome: "completed",
        succeeded: false,
        errorCount: 1,
        warningCount: 0,
      });
      assert.equal(failed.compilerDiagnosticsCollected, true);
      assert.equal(failed.modelPresent, true);
      assert.ok(failed.modelDigest.startsWith("sha256:"));
      assert.deepEqual(failed.items.map((item) => item.identity.canonicalReference).toSorted(), [
        "audit-custody!f:function(1)",
        "audit-custody!~Hidden:type",
      ]);
      assert.deepEqual(
        failed.diagnostics.filter((d) => d.severity === "error").map((d) => d.id),
        ["ae-forgotten-export"],
      );
      for (const observation of report.observations) {
        assert.deepEqual(
          observation.unsupported.map((reason) => reason.split(": ")[1]),
          fault === "both" ? ["permission-restore", "removal"] : [fault],
        );
        assert.ok(
          observation.unsupported.every(
            (reason) =>
              reason.startsWith("owned-resource-cleanup:") &&
              [...owned].some((path) => reason.includes(path)),
          ),
        );
      }
      assert.equal(
        report.comparisons.find((comparison) => comparison.pair === "A-C").eligibility.eligible,
        false,
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      for (const path of owned) {
        await originalChmod(join(path, "evidence"), 0o700).catch((error) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
        });
        await originalRm(path, { recursive: true, force: true });
      }
      await originalRm(root, { recursive: true, force: true });
    }
  });
}
