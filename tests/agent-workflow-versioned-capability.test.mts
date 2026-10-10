import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRepositoryAgentWorkflowCapability } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/module.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";

const instructions = {
  canonical: "AGENTS.md", claude: "CLAUDE.md", gemini: "GEMINI.md",
  copilot: ".github/copilot-instructions.md",
};
const scripts = { changed: "check:changed", fast: "check:fast", full: "verify" };
const capability = createRepositoryAgentWorkflowCapability({ assertSchema });

async function withConsumer(operation: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "foundation-versioned-workflow-TEST-"));
  try {
    await mkdir(join(root, ".github"));
    await writeFile(join(root, "DISPOSABLE_SANDBOX"), "Versioned capability integration fixture.\n");
    await writeFile(join(root, "AGENTS.md"), "Run check:changed, check:fast and verify.\n");
    await writeFile(join(root, "CLAUDE.md"), "@AGENTS.md\n");
    await writeFile(join(root, "GEMINI.md"), "@AGENTS.md\n");
    await writeFile(join(root, instructions.copilot), "Read AGENTS.md.\n");
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// RED: ordinary check keeps the v1-only loader after the CLI gains v2, or the
// shared schema assembly omits the newly packaged schema identity.
test("workflow capability validates both schema versions with their own changed route", async () => withConsumer(async (root) => {
  for (const version of [1, 2] as const) {
    const policy = version === 1
      ? { schemaVersion: 1, instructions, scripts, changedChecks: [{ id: "lint", script: "lint", extensions: [".ts"] }], fullScanPaths: ["package.json"] }
      : { schemaVersion: 2, instructions, scripts, scopes: [{ id: "repository", roots: ["*"], requiredFacets: ["lint"], checks: ["lint"] }], checks: [{ id: "lint", script: "lint", prerequisites: [], supplies: ["lint"], observation: "command" }], exclusions: [], escalationCheck: "lint" };
    await writeFile(join(root, "workflow.json"), JSON.stringify(policy));
    const route = version === 1 ? "changed" : "check-changed";
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      "check:changed": `agent-teams-foundation agent-workflow ${route} --consumer .`,
      "check:fast": "echo fast", verify: "echo full", lint: "echo lint",
    } }));
    const report = await capability.run({ consumerRoot: root, configPath: "workflow.json" });
    assert.equal(report.outcome, "passed", JSON.stringify(report));
    assert.equal(report.capabilityConfigSchemaVersion, version);
    if (version === 2) {
      await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
        "check:changed": "agent-teams-foundation agent-workflow changed --consumer .",
        "check:fast": "echo fast", verify: "echo full", lint: "echo lint",
      } }));
      const rejected = await capability.run({ consumerRoot: root, configPath: "workflow.json" });
      assert.equal(rejected.outcome, "violations");
      assert.ok(rejected.diagnostics.some((item) => item.ruleId === "repository.agent-workflow.changed-runner-invalid"));
    }
  }
}));

// RED: invalid v2 input is reported as historical v1 because version tracking
// happens only after the versioned loader succeeds.
test("workflow capability retains v2 identity on configuration rejection", async () => withConsumer(async (root) => {
  await writeFile(join(root, "workflow.json"), JSON.stringify({ schemaVersion: 2 }));
  const report = await capability.run({ consumerRoot: root, configPath: "workflow.json" });
  assert.equal(report.outcome, "invalid-input");
  assert.equal(report.capabilityConfigSchemaVersion, 2);
}));
