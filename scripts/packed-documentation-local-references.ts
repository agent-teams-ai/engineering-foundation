import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCommand } from "./pack-test-support.mjs";

const capabilityId = "documentation.local-references";
const infoRule = `${capabilityId}.historical-absolute-reference`;
const invalidArtifactRule = `${capabilityId}.historical-artifact-invalid`;
const invalidReferenceRule = `${capabilityId}.invalid-reference`;
const artifactPath = "docs/audit.md";
const source = Buffer.from(
  "\uFEFF# Café\r\n\r\n[Archive](/mnt/historical-proof.txt)\r\n[Current](guide.md#ready)\r\n",
  "utf8",
);

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function records(value: unknown): readonly Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map((entry: unknown) => record(entry));
}

function configuration(bytes: Uint8Array = source) {
  return {
    schemaVersion: 2,
    markdownRoots: ["docs", "ai-docs", "architecture"],
    anchorProfile: "github",
    historicalArtifacts: [
      {
        path: artifactPath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        references: [
          {
            kind: "link",
            line: 3,
            column: 1,
            rawTarget: "/mnt/historical-proof.txt",
          },
        ],
      },
    ],
  };
}

async function writeConfiguration(root: string, bytes: Uint8Array = source): Promise<void> {
  await writeFile(join(root, "references.yaml"), JSON.stringify(configuration(bytes)), "utf8");
}

async function check(cliPath: string, root: string, expectedCode: 0 | 1) {
  let value: unknown;
  let code = 0;
  try {
    value = await runCommand(
      process.execPath,
      [cliPath, "check", capabilityId, "--consumer", root, "--format", "json"],
      root,
    );
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.cause, undefined);
    const failure = record(error);
    assert.equal(failure["timedOut"], false);
    assert.equal(failure["killed"], false);
    assert.equal(failure["signal"], null);
    assert.equal(failure["terminationConfirmed"], true);
    value = error;
    const actualCode = failure["code"];
    assert.ok(typeof actualCode === "number");
    code = actualCode;
  }
  assert.equal(code, expectedCode, "Installed historical Markdown CLI exit code");
  const result = record(value);
  assert.equal(result["stderr"], "");
  const stdout = result["stdout"];
  assert.ok(typeof stdout === "string");
  const decoded: unknown = JSON.parse(stdout);
  const report = record(decoded);
  const expectedOutcome = expectedCode === 0 ? "passed" : "violations";
  assert.equal(report["reportSchemaVersion"], 1);
  assert.equal(report["outcome"], expectedOutcome);
  const capabilities = records(report["capabilities"]);
  assert.equal(capabilities.length, 1);
  const capability = capabilities[0];
  assert.ok(capability);
  assert.equal(capability["capabilityId"], capabilityId);
  assert.equal(capability["capabilityConfigSchemaVersion"], 2);
  assert.equal(capability["outcome"], expectedOutcome);
  assert.deepEqual(capability["summary"], report["summary"]);
  return { report, diagnostics: records(capability["diagnostics"]) };
}

export async function verifyInstalledHistoricalMarkdown(input: {
  readonly cliPath: string;
  readonly consumerRoot: string;
}): Promise<void> {
  const root = join(input.consumerRoot, "historical-markdown-consumer");
  for (const directory of ["docs", "ai-docs", "architecture"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, artifactPath), source);
  await writeFile(join(root, "docs/guide.md"), "# Ready\n", "utf8");
  await writeConfiguration(root);
  await writeFile(
    join(root, "foundation.config.yaml"),
    JSON.stringify({
      schemaVersion: 1,
      project: { id: "installed-historical-markdown" },
      capabilities: { [capabilityId]: { configPath: "references.yaml" } },
    }),
    "utf8",
  );

  const admitted = await check(input.cliPath, root, 0);
  assert.deepEqual(admitted.report["summary"], { errors: 0, warnings: 0, infos: 1 });
  assert.equal(admitted.diagnostics.length, 1);
  const diagnostic = admitted.diagnostics[0];
  assert.ok(diagnostic);
  assert.equal(diagnostic["ruleId"], infoRule);
  assert.equal(diagnostic["severity"], "info");
  const location = record(diagnostic["location"]);
  assert.equal(location["path"], artifactPath);
  assert.deepEqual(location["start"], { line: 3, column: 1 });
  const evidence = records(diagnostic["evidence"]);
  for (const [kind, value] of [
    ["original-rule", invalidReferenceRule],
    ["original-reason", "absolute-path"],
    ["raw-target", "/mnt/historical-proof.txt"],
    ["artifact-sha256", createHash("sha256").update(source).digest("hex")],
  ]) {
    assert.ok(evidence.some((entry) => entry["kind"] === kind && entry["value"] === value));
  }

  await writeFile(join(root, artifactPath), Buffer.concat([source, Buffer.from("Changed.\n")]));
  const drift = await check(input.cliPath, root, 1);
  assert.deepEqual(drift.report["summary"], { errors: 2, warnings: 0, infos: 0 });
  assert.deepEqual(
    drift.diagnostics.map((entry) => entry["ruleId"]).sort(),
    [invalidArtifactRule, invalidReferenceRule].sort(),
  );

  const undeclared = Buffer.concat([source, Buffer.from("[New](/mnt/undeclared.txt)\n")]);
  await writeFile(join(root, artifactPath), undeclared);
  await writeConfiguration(root, undeclared);
  const renewed = await check(input.cliPath, root, 1);
  assert.deepEqual(renewed.report["summary"], { errors: 3, warnings: 0, infos: 0 });
  assert.equal(
    renewed.diagnostics.filter((entry) => entry["ruleId"] === invalidReferenceRule).length,
    2,
  );
  assert.ok(renewed.diagnostics.some((entry) => entry["ruleId"] === invalidArtifactRule));

  await writeFile(join(root, artifactPath), source);
  await writeConfiguration(root);
  await writeFile(join(root, "architecture/current.md"), "[Broken](missing.md)\n", "utf8");
  const ordinary = await check(input.cliPath, root, 1);
  assert.deepEqual(ordinary.report["summary"], { errors: 1, warnings: 0, infos: 1 });
  assert.deepEqual(
    ordinary.diagnostics.map((entry) => entry["ruleId"]).sort(),
    [`${capabilityId}.broken-link`, infoRule].sort(),
  );
}
