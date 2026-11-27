import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDocumentationLocalReferencesCapability } from "../dist/capabilities/documentation-local-references/module.js";
import type { HistoricalMarkdownReference } from "../dist/capabilities/documentation-local-references/application/model/documentation-local-references.js";
import type {
  CapabilityReport,
  FoundationCheckReport,
} from "../dist/features/validation-reporting/api.js";
import { assertSchema } from "../dist/schema-catalog.js";

const capability = createDocumentationLocalReferencesCapability({ assertSchema });
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
export const artifactPath = "docs/audit.md";
const infoRule = "documentation.local-references.historical-absolute-reference";
export const invalidArtifactRule = "documentation.local-references.historical-artifact-invalid";
export const invalidReferenceRule = "documentation.local-references.invalid-reference";
export const source = Buffer.from(
  [
    "\uFEFF# Café",
    "",
    "[Historical](/mnt/audit.txt)",
    "![Image](/mnt/image.png)",
    "",
    "[Archive]: /mnt/log.txt",
    "",
    "[Relative](guide.md#ready)",
    "",
  ].join("\r\n"),
  "utf8",
);
const references: readonly HistoricalMarkdownReference[] = [
  { kind: "link", line: 3, column: 1, rawTarget: "/mnt/audit.txt" },
  { kind: "image", line: 4, column: 1, rawTarget: "/mnt/image.png" },
  { kind: "definition", line: 6, column: 1, rawTarget: "/mnt/log.txt" },
];

export function configuration(bytes: Uint8Array = source) {
  return {
    schemaVersion: 2,
    markdownRoots: ["docs", "ai-docs", "architecture"],
    anchorProfile: "github",
    historicalArtifacts: [
      {
        path: artifactPath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        references: references.map((reference) => ({ ...reference })),
      },
    ],
  };
}

export async function writeConfiguration(root: string, config: unknown): Promise<void> {
  await writeFile(join(root, "references.yaml"), JSON.stringify(config), "utf8");
}

export async function withFixture(callback: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "foundation-historical-markdown-"));
  try {
    for (const directory of ["docs", "ai-docs", "architecture"]) {
      await mkdir(join(root, directory));
    }
    await writeFile(join(root, artifactPath), source);
    await writeFile(join(root, "docs/guide.md"), "# Ready\n", "utf8");
    await writeConfiguration(root, configuration());
    await writeFile(
      join(root, "foundation.config.yaml"),
      JSON.stringify({
        schemaVersion: 1,
        project: { id: "historical-markdown-fixture" },
        capabilities: {
          "documentation.local-references": { configPath: "references.yaml" },
        },
      }),
      "utf8",
    );
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function run(root: string): Promise<CapabilityReport> {
  return capability.run({ consumerRoot: root, configPath: "references.yaml" });
}

export function assertHistorical(report: CapabilityReport): void {
  assert.equal(report.capabilityConfigSchemaVersion, 2);
  assert.equal(report.outcome, "passed");
  assert.deepEqual(report.summary, { errors: 0, warnings: 0, infos: 3 });
  assert.equal(report.diagnostics.length, 3);
  assert.deepEqual(
    report.diagnostics.map((entry) => entry.location.start),
    [
      { line: 3, column: 1 },
      { line: 4, column: 1 },
      { line: 6, column: 1 },
    ],
  );
  for (const diagnostic of report.diagnostics) {
    assert.equal(diagnostic.ruleId, infoRule);
    assert.equal(diagnostic.severity, "info");
    assert.equal(diagnostic.location.path, artifactPath);
    assert.ok(
      diagnostic.evidence.some(
        (entry) => entry.kind === "original-rule" && entry.value === invalidReferenceRule,
      ),
    );
    assert.ok(
      diagnostic.evidence.some(
        (entry) => entry.kind === "original-reason" && entry.value === "absolute-path",
      ),
    );
    assert.ok(
      diagnostic.evidence.some(
        (entry) =>
          entry.kind === "artifact-sha256" &&
          entry.value === configuration().historicalArtifacts[0]?.sha256,
      ),
    );
  }
  assert.deepEqual(
    report.diagnostics.map(
      (entry) => entry.evidence.find((item) => item.kind === "raw-target")?.value,
    ),
    references.map((reference) => reference.rawTarget),
  );
}

export async function runCli(
  root: string,
): Promise<{ status: number | null; report: FoundationCheckReport }> {
  const result = spawnSync(
    process.execPath,
    [cliPath, "check", "documentation.local-references", "--consumer", root, "--format", "json"],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  const report: unknown = JSON.parse(result.stdout);
  await assertSchema("foundation-check-report/v1", report, "historical-markdown-test");
  return { status: result.status, report: report as FoundationCheckReport };
}
