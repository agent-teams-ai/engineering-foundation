import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveQualificationExecutables } from "../tools/executable-policy.mts";
import { resolvePnpmInvocation } from "../tools/pnpm-command.mts";
import { assertExplicitSourceGitAuthority, assertPnpmProfileQualificationRoot, prepareProfileProjection } from "../tools/dev.mts";
import test from "node:test";
import { assertFeatureOutsideSchemaCycles, assertSchemaAssemblyImportRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { loadAgentWorkflowPolicy } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/inbound/configuration/load-agent-workflow-policy.js";
import { parseAgentWorkflowPolicy } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/inbound/configuration/parse-agent-workflow-policy.js";
import { CapabilityInputError } from "../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import { assertSchema as assertFoundationSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
import { BunPackageScriptRunner } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/bun/bun-package-script-runner.js";

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
  assert.equal(policy.packageManager, "pnpm");
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

// Catches Bun workflow checks being passed through pnpm or receiving shell-like arguments.
test("repository agent workflow Bun adapter runs one declared script and bounded paths", async () => {
  const calls = [];
  const result = await new BunPackageScriptRunner(
    { bunExecutablePath: "/verified/bun" },
    async (command, args, options) => {
      calls.push([command, args, options.cwd]);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  ).run({
    packageManager: "bun",
    consumerRoot: "/fixture",
    script: "lint:fast:files",
    paths: ["src/a.ts"],
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [[
    "/verified/bun",
    ["run", "lint:fast:files", "--", "src/a.ts"],
    "/fixture"
  ]]);
});

// Version 1 remains pnpm-only; Bun needs its explicit published policy version.
test("agent workflow v2 admits only an explicit Bun or pnpm manager", async () => {
  for (const packageManager of ["bun", "pnpm"]) {
    const input = { ...configuration(), schemaVersion: 2, packageManager };
    const calls = [];
    const policy = await loadAgentWorkflowPolicy({
      async readYaml() { return input; },
      async assertSchema(...args) { calls.push(args[0]); await assertFoundationSchema(...args); }
    }, "explicit-memory-consumer", "workflow.yaml");
    assert.deepEqual(calls, ["repository-agent-workflow/v2"]);
    assert.equal(policy.packageManager, packageManager);
  }
  for (const input of [
    { ...configuration(), schemaVersion: 2 },
    { ...configuration(), schemaVersion: 2, packageManager: "npm" },
    { ...configuration(), schemaVersion: 3, packageManager: "bun" },
    { ...configuration(), schemaVersion: 1, packageManager: "bun" }
  ]) {
    await assert.rejects(loadAgentWorkflowPolicy({
      async readYaml() { return input; },
      assertSchema: assertFoundationSchema
    }, "explicit-memory-consumer", "workflow.yaml"));
  }
  assert.throws(() => parseAgentWorkflowPolicy({ ...configuration(), schemaVersion: 3 }, "workflow.yaml"), /schemaVersion/u);
  assert.throws(() => parseAgentWorkflowPolicy({ ...configuration(), schemaVersion: 2, packageManager: "npm" }, "workflow.yaml"), /packageManager/u);
  assert.equal(parseAgentWorkflowPolicy(configuration(), "workflow.yaml").packageManager, "pnpm");
});

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function ownedTemporaryRoot(prefix) {
  const parent = join(repositoryRoot, ".worker-tmp/profiles");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}

async function minimalSource(root) {
  await mkdir(join(root, "architecture/foundation"), { recursive: true });
  await mkdir(join(root, ".worker-tmp/profiles"), { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "TEST-workflow-manager-source", private: true, packageManager: "bun@1.4.3",
    workspaces: { packages: ["packages/*"], catalog: {}, catalogs: {} },
    catalog: {}, catalogs: {}, overrides: {}
  }, null, 2)}\n`);
  await writeFile(join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\ncatalog: {}\ncatalogs: {}\noverrides: {}\n');
  await copyFile(join(repositoryRoot, "architecture/foundation/dependency-declarations.yaml"),
    join(root, "architecture/foundation/dependency-declarations.yaml"));
  await copyFile(join(repositoryRoot, "architecture/foundation/repository-runtime.json"),
    join(root, "architecture/foundation/repository-runtime.json"));
}

test("actual changed workflow follows Bun source and recorded pnpm Node projection policies", async () => {
  const parent = await ownedTemporaryRoot("changed-profile-managers-");
  const sourceRoot = join(parent, "source");
  const targetRoot = join(sourceRoot, ".worker-tmp/profiles/node");
  const observation = join(parent, "runtime.ndjson");
  const tools = await resolveQualificationExecutables("bun");
  const pnpm = await resolvePnpmInvocation(tools.node, "11.20.0");
  const pnpmEntrypoint = pnpm.kind === "javascript" ? pnpm.args[0] : pnpm.command;
  assert.ok(pnpmEntrypoint);
  assert.ok(tools.bun);
  try {
    await minimalSource(sourceRoot);
    const workflowPath = "architecture/foundation/repository-agent-workflow.yaml";
    await writeFile(join(sourceRoot, workflowPath), `schemaVersion: 2
packageManager: bun
instructions: { canonical: AGENTS.md, claude: CLAUDE.md, gemini: GEMINI.md, copilot: .github/copilot-instructions.md }
scripts: { changed: check:changed, fast: check:fast, full: check }
changedChecks: [{ id: observe, script: "check:fast", extensions: [.ts], passPaths: false }]
fullScanPaths: [architecture]
`);
    const manifestPath = join(sourceRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest["scripts"] = { "check:fast": `node ${JSON.stringify(join(repositoryRoot, "tools/repository-command.mts"))} tool runtime-observe` };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(sourceRoot, ".gitignore"), ".worker-tmp\nnode_modules\n");
    await writeFile(join(sourceRoot, ".npmrc"), "verify-deps-before-run=false\n");
    await writeFile(join(sourceRoot, "foundation.config.yaml"), `schemaVersion: 1
project: { id: changed-runtime-fixture }
capabilities:
  repository.agent-workflow: { configPath: architecture/foundation/repository-agent-workflow.yaml }
`);
    await writeFile(join(sourceRoot, "changed.ts"), "export const value = 1;\n");
    const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
    const configuredName = spawnSync("git", ["config", "--get", "user.name"], { encoding: "utf8", env: gitEnvironment }).stdout.trim();
    const configuredEmail = spawnSync("git", ["config", "--get", "user.email"], { encoding: "utf8", env: gitEnvironment }).stdout.trim();
    for (const args of [
      ["init", "--initial-branch=main"],
      ["add", "--all"],
      ["-c", `user.name=${configuredName || "Foundation fixture"}`, "-c", `user.email=${configuredEmail || "fixture@agent-teams.invalid"}`, "commit", "--message", "test: initialize runtime fixture"]
    ]) {
      const result = spawnSync("git", args, { cwd: sourceRoot, encoding: "utf8", env: gitEnvironment });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    const authority = await assertExplicitSourceGitAuthority(sourceRoot);
    await prepareProfileProjection({ profile: "node", sourceRoot, targetRoot, sourceSha: authority.sourceCommit });
    await assertPnpmProfileQualificationRoot(targetRoot, sourceRoot, false);
    await writeFile(join(sourceRoot, "changed.ts"), "export const value = 2;\n");
    for (const [profile, root, executable] of [
      ["bun", sourceRoot, tools.bun], ["node", targetRoot, tools.node]
    ]) {
      const result = spawnSync(executable, [
        join(repositoryRoot, "packages/engineering-foundation/dist/cli.js"),
        "agent-workflow", "changed", "--base", "HEAD", "--consumer", root, "--format", "json"
      ], { cwd: root, encoding: "utf8", env: {
        ...process.env, ...authority.environment,
        GIT_WORK_TREE: root,
        AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: profile,
        AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: tools.node,
        AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: tools.bun,
        AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT: pnpmEntrypoint,
        AGENT_TEAMS_FOUNDATION_RUNTIME_OBSERVATION: observation,
        npm_execpath: pnpmEntrypoint
      } });
      assert.equal(result.status, 0, `${profile}: ${result.stdout}${result.stderr}`);
    }
    const records = (await readFile(observation, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.match(records[0]?.managerUserAgent ?? "", /^bun\/1\.4\.3/u);
    assert.equal(records[0]?.profile, "bun");
    assert.equal(records[0]?.leafBunVersion, "1.4.3");
    assert.match(records[1]?.managerUserAgent ?? "", /^pnpm\/11\.20\.0/u);
    assert.equal(records[1]?.profile, "node");
    assert.equal(records[1]?.leafBunVersion, null);
    assert.equal(records[1]?.leafNodeVersion, "26.11.1");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
