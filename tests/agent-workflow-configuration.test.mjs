import assert from "node:assert/strict";
import test from "node:test";
import { assertFeatureOutsideSchemaCycles, assertSchemaAssemblyImportRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { loadAgentWorkflowPolicy } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/inbound/configuration/load-agent-workflow-policy.js";
import { parseAgentWorkflowPolicy } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/inbound/configuration/parse-agent-workflow-policy.js";
import { CapabilityInputError } from "../packages/engineering-foundation/dist/features/validation-reporting/api.js";

function configuration() {
  return {
    schemaVersion: 1,
    instructions: { canonical: "AGENTS.md", claude: "CLAUDE.md", gemini: "GEMINI.md", copilot: ".github/copilot-instructions.md" },
    scripts: { changed: "check:changed", fast: "check:fast", full: "verify" },
    changedChecks: [{ id: "typescript", script: "lint", extensions: [".TS", ".Tsx"] }],
    fullScanPaths: ["package.json", "architecture"]
  };
}

test("agent workflow configuration no longer joins the module schema assembly cycle", async () => {
  await assertFeatureOutsideSchemaCycles("repository-agent-workflow");
});

test("source policy rejects reintroducing schema assembly inside the agent workflow adapter", async () => {
  await assertSchemaAssemblyImportRejected(
    "packages/engineering-foundation/src/capabilities/repository-agent-workflow/adapters/inbound/configuration/load-agent-workflow-policy.ts",
    "../../../../../schema-catalog.js"
  );
});

test("agent workflow configuration retains dependency order and changed-check routing", async () => {
  const input = configuration(), calls = [], signal = new AbortController().signal;
  const policy = await loadAgentWorkflowPolicy({
    async readYaml(...args) { calls.push(["read", ...args]); return input; },
    async assertSchema(...args) { calls.push(["schema", ...args]); }
  }, "explicit-memory-consumer", "workflow.yaml", signal);
  assert.deepEqual(calls, [
    ["read", "explicit-memory-consumer", "workflow.yaml", "repository-agent-workflow-config", signal],
    ["schema", "repository-agent-workflow/v1", input, "repository-agent-workflow-config"]
  ]);
  assert.deepEqual(policy.changedChecks, [{ id: "typescript", script: "lint", extensions: [".ts", ".tsx"], passPaths: true }]);
  assert.deepEqual(policy.fullScanPaths, [".github/copilot-instructions.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "architecture", "foundation.config.yaml", "package.json", "workflow.yaml"]);
  assert.deepEqual(parseAgentWorkflowPolicy(input, "workflow.yaml"), policy);
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.fullScanPaths));
  assert.ok(Object.isFrozen(policy.changedChecks[0].extensions));
});

test("agent workflow configuration preserves schema rejection before policy parsing", async () => {
  const failure = new Error("explicit schema rejection");
  await assert.rejects(loadAgentWorkflowPolicy({
    async readYaml() { return null; },
    async assertSchema() { throw failure; }
  }, "explicit-memory-consumer", "workflow.yaml"), (error) => error === failure);
});

test("pure agent workflow parsing preserves recursion and path-role diagnostics", () => {
  const recursive = configuration();
  recursive.scripts.fast = recursive.scripts.changed;
  assert.throws(() => parseAgentWorkflowPolicy(recursive, "workflow.yaml"), (error) => {
    assert.ok(error instanceof CapabilityInputError);
    assert.equal(error.problem.code, "REPOSITORY_AGENT_WORKFLOW_CONFIG_INVALID");
    assert.equal(error.problem.phase, "repository-agent-workflow-config");
    assert.equal(error.message, "The fast workflow script cannot be the changed workflow script.");
    return true;
  });
  const duplicate = configuration();
  duplicate.instructions.claude = duplicate.instructions.canonical;
  assert.throws(() => parseAgentWorkflowPolicy(duplicate, "workflow.yaml"), /Instruction file paths must be unique/u);
});
