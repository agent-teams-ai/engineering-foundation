import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, symlink, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MicrosoftPublicApiObserver } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/microsoft-public-api-observer.js";
import { runPublicApiAudit } from "../dist/capabilities/public-api-compatibility/node.js";

import {
  FilesystemPublicApiAuditInputs,
  AUDIT_MAX_BYTES,
} from "../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-audit-inputs.js";
import { auditPublicApi } from "../dist/capabilities/public-api-compatibility/application/use-cases/audit-public-api.js";
import { digest, schemas, custodyFixture } from "./public-api-audit-command-fixture.ts";
test("all B-only entries validate in isolation, including aggregate exhaustion", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-audit-b-only-"));
  try {
    const request = await custodyFixture(root);
    const changed = "/** @internal */\nexport declare function _f(): number;\n";
    await writeFile(join(root, "C/index.d.ts"), changed);
    request.subjects.C.files = request.subjects.C.files.map((file) =>
      file.path === "C/index.d.ts" ? { ...file, digest: digest(changed) } : file,
    );
    request.subjects.C.build.declarations = request.subjects.C.files.filter((file) =>
      file.path.endsWith(".d.ts"),
    );
    const assertSchema = await schemas();
    const input = { consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" };
    await writeFile(join(root, "request.json"), JSON.stringify(request));
    const valid = await runPublicApiAudit(input, assertSchema);
    assert.equal(valid.exitCode, 0);
    assert.equal(valid.comparisons[2]!.findings!.classification, "breaking");
    const inputs = new FilesystemPublicApiAuditInputs(
      (value) => assertSchema("package-public-api-audit-request/v1", value),
      (value) => assertSchema("package-public-api-baseline/v1", value),
    );
    // Reuse admitted synthetic observations to keep filesystem cases independent of SDK cost.
    const dependencies = {
      inputs,
      observer: {
        observe: async ({ subject }: Parameters<MicrosoftPublicApiObserver["observe"]>[0]) =>
          valid.observations.filter((value) => value.subject === subject),
      },
      fingerprint: { sha256: (value: string) => digest(value).slice(7) },
    };
    const baseline = request.subjects.B.baselines[0]!;
    const only = JSON.stringify({
      schemaVersion: 1,
      packageName: "z-only",
      packageVersion: "1.0.0",
      extractorVersion: "7.58.12",
      items: [],
    });
    await writeFile(join(root, "only.json"), only);
    await symlink(join(root, "only.json"), join(root, "alias.json"));
    const oversized = await open(join(root, "oversized.json"), "w");
    try {
      await oversized.truncate(AUDIT_MAX_BYTES + 1);
    } finally {
      await oversized.close();
    }
    await writeFile(join(root, "invalid.json"), "{}");
    for (const [path, hash, error] of [
      ["only.json", digest(only), undefined],
      ["missing.json", digest(only), /ENOENT/u],
      ["../escape.json", digest(only), /Invalid audit path/u],
      ["alias.json", digest(only), /symlink/u],
      ["oversized.json", digest(only), /byte budget exhausted/u],
      ["only.json", digest("wrong"), /Baseline digest mismatch/u],
      ["invalid.json", digest("{}"), /AssertionError/u],
    ] as const) {
      request.subjects.B.baselines = [baseline, { packageName: "z-only", path, digest: hash }];
      await writeFile(join(root, "request.json"), JSON.stringify(request));
      const report = await auditPublicApi(input, dependencies);
      await assertSchema("package-public-api-audit-report/v1", report);
      assert.equal(report.exitCode, 2);
      assert.equal(report.evidenceComplete, false);
      assert.equal(report.releaseEligible, false);
      assert.deepEqual(
        report.comparisons.find(
          (value) => value.pair === "A-C" && value.packageName === "audit-custody",
        ),
        valid.comparisons[2],
      );
      assert.ok(
        report.comparisons
          .filter((value) => value.packageName === "z-only")
          .every((value) => !value.eligibility.eligible && value.findings === undefined),
      );
      if (error) {
        assert.equal(report.errors.length, 1);
        assert.match(report.errors[0]!, /^B\/z-only:/u);
        assert.match(report.errors[0]!, error);
      } else {
        assert.deepEqual(report.errors, []);
      }
    }
    const padded = only.padEnd(16 * 1024, " ");
    await writeFile(join(root, "only.json"), padded);
    // Even identity-invalid bytes consume B's cumulative budget. The request
    // stays within the schema's 4,096-entry limit and each file is only 16 KiB.
    request.subjects.B.baselines = [
      baseline,
      ...Array.from({ length: AUDIT_MAX_BYTES / Buffer.byteLength(padded) }, (_, index) => ({
        packageName: `z-${String(index).padStart(4, "0")}`,
        path: "only.json",
        digest: digest(padded),
      })),
    ];
    await writeFile(join(root, "request.json"), JSON.stringify(request));
    const exhausted = await runPublicApiAudit(input, assertSchema);
    await assertSchema("package-public-api-audit-report/v1", exhausted);
    assert.equal(exhausted.comparisons.length, 3 * request.subjects.B.baselines.length);
    for (const entry of request.subjects.B.baselines) {
      assert.deepEqual(
        exhausted.comparisons
          .filter((value) => value.packageName === entry.packageName)
          .map((value) => value.pair),
        ["A-B", "B-C", "A-C"],
      );
    }
    assert.equal(exhausted.exitCode, 2);
    assert.equal(exhausted.evidenceComplete, false);
    assert.equal(exhausted.releaseEligible, false);
    assert.match(exhausted.errors.at(-1)!, /byte budget exhausted/u);
    assert.deepEqual(
      exhausted.comparisons.find(
        (value) => value.pair === "A-C" && value.packageName === "audit-custody",
      ),
      valid.comparisons[2],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public audit retains the combined maximum errors and rejects one beyond the schema bound", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foundation-audit-error-bound-"));
  try {
    const requestSchema = JSON.parse(
      await readFile(
        new URL("../schemas/package-public-api-audit-request/v1.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const reportSchema = JSON.parse(
      await readFile(
        new URL("../schemas/package-public-api-audit-report/v1.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const baselineMaximum = requestSchema.$defs.subjects.properties.B.properties.baselines.maxItems;
    const maximum = baselineMaximum + 2 + 1;
    assert.equal(maximum, 4099);
    assert.equal(reportSchema.$defs.report.properties.errors.maxItems, maximum);
    const request = await custodyFixture(root);
    request.subjects.B.baselines = Array.from({ length: baselineMaximum }, (_, index) => ({
      packageName: `b-${String(index).padStart(4, "0")}`,
      path: "missing.json",
      digest: digest("missing"),
    }));
    await writeFile(join(root, "request.json"), JSON.stringify(request));
    const observe = MicrosoftPublicApiObserver.prototype.observe;
    const subjects: string[] = [];
    t.mock.method(
      MicrosoftPublicApiObserver.prototype,
      "observe",
      async function (
        this: MicrosoftPublicApiObserver,
        input: Parameters<MicrosoftPublicApiObserver["observe"]>[0],
      ) {
        subjects.push(input.subject);
        // Initial request/custody validation succeeds. Subsequent observation and
        // revalidation see a real missing input, without invoking the SDK.
        await rm(join(root, input.subject, "package.json"));
        return observe.call(this, input);
      },
    );
    const assertSchema = await schemas();
    const report = await runPublicApiAudit(
      { consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" },
      assertSchema,
    );
    assert.deepEqual(subjects, ["A", "C"]);
    assert.equal(report.errors.length, maximum);
    assert.match(report.errors[0]!, /^A:.*ENOENT/u);
    assert.match(report.errors[1]!, /^C:.*ENOENT/u);
    assert.match(report.errors[2]!, /^Input revalidation failed:.*ENOENT/u);
    assert.deepEqual(
      report.errors.slice(3).map((error) => error.split(":")[0]),
      request.subjects.B.baselines.map((entry) => `B/${entry.packageName}`),
    );
    assert.equal(report.comparisons.length, 3 * (baselineMaximum + 1));
    assert.deepEqual(
      [...new Set(report.comparisons.map((value) => value.packageName))],
      ["audit-custody", ...request.subjects.B.baselines.map((entry) => entry.packageName)],
    );
    assert.ok(report.comparisons.every((value) => !value.eligibility.eligible));
    assert.deepEqual(report.observations, []);
    assert.deepEqual(report.custody.supplied, request.subjects);
    assert.equal(report.requestDigest, digest(JSON.stringify(request)));
    assert.equal(report.exitCode, 2);
    assert.equal(report.evidenceComplete, false);
    assert.equal(report.releaseEligible, false);
    await assertSchema("package-public-api-audit-report/v1", report);
    await assert.rejects(
      assertSchema("package-public-api-audit-report/v1", {
        ...report,
        errors: [...report.errors, "overflow"],
      }),
      /maxItems/u,
    );
  } finally {
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});
