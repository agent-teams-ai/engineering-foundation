import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { assertSchema } from "../dist/schema-catalog.js";
import type { FoundationCheckReport } from "../dist/features/validation-reporting/api.js";
import { check, withFixture } from "./support/dependency-fixtures.mjs";

async function workspaceReport(root: string) {
  const output = check(root, "workspace.dependency-declarations");
  const input: unknown = output.report;
  await assertSchema("foundation-check-report/v1", input, "test-workspace-report");
  const report = input as FoundationCheckReport;
  const capability = report.capabilities[0];
  assert.ok(capability);
  return { status: output.result.status, capability };
}

void test("workspace CLI reports preserve the requested v2 contract on success and input failures", async () => {
  await withFixture(async (root: string) => {
    const configPath = join(root, "architecture/foundation/dependency-declarations.yaml");
    const original = await readFile(configPath, "utf8");
    assert.match(original, /^schemaVersion: 1\n/);
    const config = original.replace("schemaVersion: 1", "schemaVersion: 2");
    await writeFile(configPath, config);
    const success = await workspaceReport(root);
    assert.equal(success.status, 0);
    assert.equal(success.capability.capabilityConfigSchemaVersion, 2);

    await rm(join(root, "pnpm-workspace.yaml"));
    const missingWorkspace = await workspaceReport(root);
    assert.equal(missingWorkspace.status, 2);
    assert.equal(missingWorkspace.capability.capabilityConfigSchemaVersion, 2);

    await writeFile(configPath, config.replace("kind: pnpm", "kind: unsupported"));
    const invalidConfig = await workspaceReport(root);
    assert.equal(invalidConfig.status, 2);
    assert.equal(invalidConfig.capability.problem?.code, "SCHEMA_INVALID");
    assert.equal(invalidConfig.capability.capabilityConfigSchemaVersion, 2);
  });
});
