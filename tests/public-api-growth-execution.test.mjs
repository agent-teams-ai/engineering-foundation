import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import test from "node:test";
import { check, withPublicApiFixture } from "./support/capability-fixtures.mjs";

test("existing public check route preserves v1 and publishes deterministic incomplete v2 evidence with exit 2", async () => {
  await withPublicApiFixture(async root => {
    assert.equal(check(root).result.status, 0);
    const configPath = join(root, "architecture/foundation/public-api-compatibility.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    const digest = `sha256:${"1".repeat(64)}`;
    config.schemaVersion = 2;
    config.sdkGrowth = {
      workspaceManifestPath: "pnpm-workspace.yaml",
      invocation: { repository: "fixture/sdk", sourceCommit: "1".repeat(40), sourceTree: "2".repeat(40),
        topologyDigest: digest, lockDigest: digest, toolchainDigest: digest, artifactDigests: [digest],
        tool: { version: "fixture", artifactDigest: digest, extractorVersion: "7.58.12" } },
      context: { trustedBasePath: "evidence/base.json", decisionsPath: "evidence/decisions.json", released: [
        { packageName: "@fixture/public-api", kind: "released", observationPath: "evidence/released.json" }
      ] }, report: { path: "reports/sdk.json", expectedPreimage: null }
    };
    await writeFile(configPath, stringify(config));
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await mkdir(join(root, "reports"));
    await mkdir(join(root, "evidence"));
    await writeFile(join(root, "evidence/decisions.json"), "[]");
    const first = check(root);
    assert.equal(first.result.status, 2, JSON.stringify(first.report));
    const capability = first.report.capabilities[0];
    assert.equal(capability.capabilityConfigSchemaVersion, 2);
    assert.equal(capability.problem.code, "SDK_GROWTH_INCOMPLETE");
    assert.ok(capability.diagnostics.some(row => row.ruleId === "package.public-api-compatibility.sdk-growth-report"));
    const bytes = await readFile(join(root, "reports/sdk.json"));
    const report = JSON.parse(bytes);
    assert.equal(report.admission.status, "incomplete");
    assert.equal(report.releaseEligible, false);
    assert.ok(report.comparison.reasons.includes("growth-authority-unverified"));
    assert.deepEqual(check(root).report, first.report);
    assert.deepEqual(await readFile(join(root, "reports/sdk.json")), bytes);
    await writeFile(join(root, "reports/sdk.json"), "another writer");
    const conflicted = check(root);
    assert.equal(conflicted.result.status, 3);
    assert.equal(conflicted.report.capabilities[0].problem.code, "SDK_GROWTH_REPORT_CONFLICT");
    assert.equal(await readFile(join(root, "reports/sdk.json"), "utf8"), "another writer");
  });
});
