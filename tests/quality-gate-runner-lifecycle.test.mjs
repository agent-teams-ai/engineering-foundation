import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  cleanupSyntheticFixture,
  createSyntheticFixtureBoundary,
  startBoundedCli,
  waitForFixtureEffect,
  writeFixtureBoundaryClient,
} from "./support/quality-gate-runner-lifecycle.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repositoryRoot, "packages", "engineering-foundation", "dist", "cli.js");

function startCli(arguments_, options = {}) {
  return startBoundedCli(cliPath, arguments_, options);
}

async function writeFixturePnpm(
  root,
  packageManagerRoles = {},
  taskBoundaryEnvironments = {},
) {
  await writeFixtureBoundaryClient(root);
  const entrypoint = join(root, "fixture-pnpm.cjs");
  await writeFile(entrypoint, `const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { readFileSync } = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { connect } = require("./fixture-boundary-client.cjs");

void (async () => {
if (process.argv.length !== 4 || process.argv[2] !== "run") {
  throw new Error("Unexpected fixture pnpm arguments: " + JSON.stringify(process.argv.slice(2)));
}
const scriptId = process.argv[3];
const packageManagerRoles = ${JSON.stringify(packageManagerRoles)};
const taskBoundaryEnvironments = ${JSON.stringify(taskBoundaryEnvironments)};
if (taskBoundaryEnvironments[scriptId] !== undefined) {
  Object.assign(process.env, taskBoundaryEnvironments[scriptId]);
}
let task;
await connect(packageManagerRoles[scriptId] ?? "package-manager", async () => {
  if (task === undefined || task.exitCode !== null || task.signalCode !== null) return;
  task.kill("SIGTERM");
  const closed = await Promise.race([once(task, "close").then(() => true), delay(1000, false)]);
  if (!closed && task.exitCode === null && task.signalCode === null) task.kill("SIGKILL");
  if (!closed) await once(task, "close");
});
const script = JSON.parse(readFileSync("package.json", "utf8")).scripts[scriptId];
const match = /^node ([a-z0-9.-]+\\.cjs)$/u.exec(script);
if (match === null) {
  throw new Error("Fixture pnpm accepts only a single local Node script.");
}
task = spawn(process.execPath, [match[1]], {
  stdio: "inherit"
});
const [code] = await once(task, "exit");
process.exit(code ?? 1);
})().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exit(1);
});
`, "utf8");
  return entrypoint;
}

async function writeNeverEndingTaskFixture(root, filename, effectPath, {
  descendantRole = "descendant",
  parentRole = "parent",
  readinessRoles = ["package-manager", "parent", "descendant"],
} = {}) {
  await writeFixtureBoundaryClient(root);
  const descendantSource = `const { connect } = require("./fixture-boundary-client.cjs");
void (async () => {
  await connect(${JSON.stringify(descendantRole)});
  process.send?.("ready");
  setInterval(() => {}, 60000);
})().catch((error) => { throw error; });
`;
  await writeFile(join(root, filename), `const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { writeFileSync } = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { connect } = require("./fixture-boundary-client.cjs");

void (async () => {
let descendant;
await connect(${JSON.stringify(parentRole)}, async () => {
  if (descendant === undefined || descendant.exitCode !== null || descendant.signalCode !== null) return;
  descendant.kill("SIGTERM");
  const closed = await Promise.race([once(descendant, "close").then(() => true), delay(1000, false)]);
  if (!closed && descendant.exitCode === null && descendant.signalCode === null) descendant.kill("SIGKILL");
  if (!closed) await once(descendant, "close");
});
descendant = spawn(process.execPath, ["--eval", ${JSON.stringify(descendantSource)}], {
  stdio: ["ignore", "ignore", "ignore", "ipc"]
});
await once(descendant, "message");
writeFileSync(${JSON.stringify(effectPath)}, JSON.stringify({
  nonce: process.env.QGR_FIXTURE_NONCE,
  roles: ${JSON.stringify(readinessRoles)}
}) + "\\n", { flag: "wx" });
setInterval(() => {}, 60000);
})().catch((error) => { throw error; });
`, "utf8");
}

function parseOwnedReadiness(boundary, roles) {
  return (source) => {
    const record = JSON.parse(source);
    assert.deepEqual(record, { nonce: boundary.nonce, roles });
    return record;
  };
}

async function writeConsumer(root, profileSource, scripts, packageManagerVersion = "11.20.0") {
  await mkdir(join(root, "architecture", "foundation"), { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "quality-gate-test-consumer",
    private: true,
    packageManager: `pnpm@${packageManagerVersion}`,
    scripts,
  }, null, 2)}\n`, "utf8");
  await writeFile(join(root, "foundation.config.yaml"), `schemaVersion: 1
project:
  id: quality-gate-test
capabilities:
  quality.gate-runner:
    configPath: architecture/foundation/quality-gates.yaml
`, "utf8");
  await writeFile(join(root, "architecture", "foundation", "quality-gates.yaml"), profileSource, "utf8");
}

async function writeConcurrentManagedTaskFixture(root, timeoutMs) {
  const tasks = [
    {
      descendantRole: "descendant-a",
      effectPath: join(root, ".concurrent-a.json"),
      filename: "concurrent-a.cjs",
      packageManagerRole: "package-manager-a",
      parentRole: "parent-a",
      scriptId: "slow-a",
    },
    {
      descendantRole: "descendant-b",
      effectPath: join(root, ".concurrent-b.json"),
      filename: "concurrent-b.cjs",
      packageManagerRole: "package-manager-b",
      parentRole: "parent-b",
      scriptId: "slow-b",
    },
  ].map((task) => ({
    ...task,
    roles: [task.packageManagerRole, task.parentRole, task.descendantRole],
  }));
  const timeoutSource = timeoutMs === undefined ? "" : `\n        timeoutMs: ${timeoutMs}`;
  await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 2
    tasks:
      - id: slow-a${timeoutSource}
      - id: slow-b${timeoutSource}
`, Object.fromEntries(tasks.map(({ filename, scriptId }) => [scriptId, `node ${filename}`])));
  for (const task of tasks) {
    await writeNeverEndingTaskFixture(root, task.filename, task.effectPath, {
      descendantRole: task.descendantRole,
      parentRole: task.parentRole,
      readinessRoles: task.roles,
    });
  }
  return {
    tasks,
  };
}

async function createConcurrentTaskBoundaries(root, tasks) {
  const boundaries = await Promise.all(tasks.map(({ roles }) => (
    createSyntheticFixtureBoundary({ expectedRoles: roles })
  )));
  const fixturePnpm = await writeFixturePnpm(
    root,
    Object.fromEntries(tasks.map(({ packageManagerRole, scriptId }) => [scriptId, packageManagerRole])),
    Object.fromEntries(tasks.map(({ scriptId }, index) => [scriptId, boundaries[index].environment])),
  );
  return { boundaries, fixturePnpm };
}

test("CLI runs a bounded synthetic consumer through the installed pnpm", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-real-pnpm-"));
  const marker = join(root, ".real-pnpm-smoke.json");
  let boundary;
  let execution;
  let setupExecution;
  try {
    assert.equal(
      typeof process.env.npm_execpath,
      "string",
      "Run this test through the installed pnpm so npm_execpath identifies the real entrypoint.",
    );
    const installedVersion = /^pnpm\/(?<version>\d+\.\d+\.\d+)\b/u.exec(
      process.env.npm_config_user_agent ?? "",
    )?.groups?.version;
    assert.notEqual(installedVersion, undefined, "Installed pnpm did not report its exact version.");
    const installedPnpmEntrypoint = await realpath(process.env.npm_execpath);
    assert.match(installedPnpmEntrypoint, /\.(?:c|m)?js$/u);
    const nodeOnlyPath = join(root, "node-only-path");
    await mkdir(nodeOnlyPath);
    const nodeEntrypoint = join(nodeOnlyPath, process.platform === "win32" ? "node.exe" : "node");
    if (process.platform === "win32") {
      await copyFile(process.execPath, nodeEntrypoint);
    } else {
      await symlink(process.execPath, nodeEntrypoint);
      await symlink("/bin/sh", join(nodeOnlyPath, "sh"));
    }
    await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: smoke
        timeoutMs: 30000
`, {
      smoke: "node real-pnpm-smoke.cjs",
    }, installedVersion);
    const fixtureStore = join(root, ".pnpm-store");
    setupExecution = startBoundedCli(installedPnpmEntrypoint, [
      "install", "--frozen-lockfile=false", "--ignore-scripts", "--store-dir", fixtureStore,
    ], {
      cwd: root,
      env: { ...process.env, npm_config_store_dir: fixtureStore },
    });
    const setupResult = await setupExecution.result;
    assert.equal(setupResult.status, 0, JSON.stringify(setupResult));
    boundary = await createSyntheticFixtureBoundary({ expectedRoles: ["real-pnpm-task"] });
    await writeFixtureBoundaryClient(root);
    await writeFile(join(root, "real-pnpm-smoke.cjs"), `const { realpathSync, writeFileSync } = require("node:fs");
const { connect } = require("./fixture-boundary-client.cjs");
void (async () => {
  if (process.env.npm_lifecycle_event !== "smoke") {
    throw new Error("Installed pnpm did not set npm_lifecycle_event=smoke.");
  }
  const canonicalNpmExecPath = realpathSync(process.env.npm_execpath);
  if (canonicalNpmExecPath !== ${JSON.stringify(installedPnpmEntrypoint)}) {
    throw new Error("Installed pnpm child npm_execpath was not the expected canonical entrypoint.");
  }
  await connect("real-pnpm-task");
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
    invocation: 1,
    lifecycleEvent: process.env.npm_lifecycle_event,
    nonce: process.env.QGR_FIXTURE_NONCE,
    npmExecPath: canonicalNpmExecPath,
    packageManager: "pnpm"
  }) + "\\n", { flag: "wx" });
  process.exit(0);
})().catch((error) => { throw error; });
`, "utf8");
    const childEnvironment = {
      ...process.env,
      PATH: nodeOnlyPath,
      npm_config_store_dir: fixtureStore,
      npm_execpath: installedPnpmEntrypoint,
    };
    delete childEnvironment.PNPM_HOME;
    execution = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], {
      env: childEnvironment,
      fixtureBoundary: boundary,
    });
    const result = await execution.result;
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.equal(JSON.parse(result.stdout).outcome, "passed");
    await boundary.waitForRoles();
    await boundary.assertStopped();
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), {
      invocation: 1,
      lifecycleEvent: "smoke",
      nonce: boundary.nonce,
      npmExecPath: installedPnpmEntrypoint,
      packageManager: "pnpm",
    });
  } finally {
    await cleanupSyntheticFixture({
      boundaries: [boundary],
      executions: [setupExecution, execution],
      roots: [root],
    });
  }
});
test("CLI preserves a failing script exit code and emits versioned JSON evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-cli-"));
  let execution;
  try {
    await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: fail
`, {
      fail: "node failure-fixture.cjs",
    });
    await writeFile(
      join(root, "failure-fixture.cjs"),
      "process.stderr.write('failure-tail'); process.exit(7);\n",
      "utf8",
    );
    const fixturePnpm = await writeFixturePnpm(root);
    execution = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], { env: { ...process.env, npm_execpath: fixturePnpm } });
    const completed = await execution.result;
    assert.equal(completed.status, 7, JSON.stringify(completed));
    const report = JSON.parse(completed.stdout);
    assert.equal(report.reportSchemaVersion, 1);
    assert.equal(report.outcome, "failed");
    assert.equal(report.tasks[0].exitCode, 7);
    assert.match(report.tasks[0].failureTail, /failure-tail$/u);
  } finally {
    await cleanupSyntheticFixture({ executions: [execution], roots: [root] });
  }
});

test("static capability check validates an opted-in profile without running scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-static-"));
  const marker = join(root, "must-not-exist");
  let execution;
  try {
    await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: guarded
`, {
      guarded: `node --eval "require('node:fs').writeFileSync('${marker}', '')"`,
    });
    execution = startCli([
      "check", "quality.gate-runner", "--consumer", root, "--format", "json",
    ]);
    const completed = await execution.result;
    assert.equal(completed.status, 0, JSON.stringify(completed));
    assert.equal(JSON.parse(completed.stdout).outcome, "passed");
    assert.equal(await import("node:fs").then(({ existsSync }) => existsSync(marker)), false);
  } finally {
    await cleanupSyntheticFixture({ executions: [execution], roots: [root] });
  }
});

test("CLI rejects missing scripts, recursion, invalid timeout, and cycles before execution", async () => {
  const cases = [
    {
      source: "      - id: missing\n",
      scripts: {},
      expected: "QUALITY_GATE_SCRIPTS_INVALID",
    },
    {
      source: "      - id: recursive\n",
      scripts: { recursive: "agent-teams-foundation gate run verify" },
      expected: "QUALITY_GATE_SCRIPTS_INVALID",
    },
    {
      source: "      - id: pass\n        timeoutMs: 0\n",
      scripts: { pass: "node --version" },
      expected: "SCHEMA_INVALID",
    },
    {
      source: "      - id: one\n        needs: [two]\n      - id: two\n        needs: [one]\n",
      scripts: { one: "node --version", two: "node --version" },
      expected: "QUALITY_GATE_RUNNER_CONFIG_INVALID",
    },
  ];
  for (const [index, candidate] of cases.entries()) {
    const root = await mkdtemp(join(tmpdir(), `foundation-quality-gate-invalid-${index}-`));
    let execution;
    try {
      await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
${candidate.source}`, candidate.scripts);
      execution = startCli([
        "gate", "run", "verify", "--consumer", root,
      ]);
      const completed = await execution.result;
      assert.equal(completed.status, 2);
      assert.match(completed.stderr, new RegExp(`^${candidate.expected}:`, "u"));
    } finally {
      await cleanupSyntheticFixture({ executions: [execution], roots: [root] });
    }
  }
});

test("CLI enforces a real per-task timeout and returns 124", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-timeout-"));
  const effectPath = join(root, ".timeout-readiness.json");
  const roles = ["package-manager", "parent", "descendant"];
  let boundary;
  let execution;
  try {
    boundary = await createSyntheticFixtureBoundary({ expectedRoles: roles });
    await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: slow
        timeoutMs: 10000
`, {
      slow: "node timeout-fixture.cjs",
    });
    await writeNeverEndingTaskFixture(root, "timeout-fixture.cjs", effectPath);
    const fixturePnpm = await writeFixturePnpm(root);
    execution = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], {
      env: {
        ...process.env,
        npm_execpath: fixturePnpm,
      },
      fixtureBoundary: boundary,
    });
    await waitForFixtureEffect(effectPath, execution, parseOwnedReadiness(boundary, roles));
    await boundary.waitForRoles();
    const result = await execution.result;
    assert.equal(result.status, 124, JSON.stringify(result));
    assert.equal(JSON.parse(result.stdout).tasks[0].outcome, "timed-out");
    await boundary.assertStopped();
  } finally {
    await cleanupSyntheticFixture({
      boundaries: [boundary],
      executions: [execution],
      roots: [root],
    });
  }
});

test("concurrency two times out both simultaneous task-specific managed boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-concurrent-timeout-"));
  let boundaries = [];
  let execution;
  try {
    const fixture = await writeConcurrentManagedTaskFixture(root, 10_000);
    const managed = await createConcurrentTaskBoundaries(
      root,
      fixture.tasks,
    );
    boundaries = managed.boundaries;
    execution = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], {
      env: { ...process.env, npm_execpath: managed.fixturePnpm },
    });
    await Promise.all(fixture.tasks.map(({ effectPath, roles }, index) => (
      waitForFixtureEffect(effectPath, execution, parseOwnedReadiness(boundaries[index], roles))
    )));
    await Promise.all(boundaries.map((boundary) => boundary.waitForRoles()));
    await Promise.all(boundaries.map((boundary) => boundary.assertActive()));
    const result = await execution.result;
    assert.equal(result.status, 124, JSON.stringify(result));
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "failed");
    assert.deepEqual(
      report.tasks.map(({ id, outcome }) => [id, outcome]),
      [["slow-a", "timed-out"], ["slow-b", "timed-out"]],
    );
    await Promise.all(boundaries.map((boundary) => boundary.assertStopped()));
  } finally {
    await cleanupSyntheticFixture({
      boundaries,
      executions: [execution],
      roots: [root],
    });
  }
});

test("readiness failure cleans up and awaits the nonce-owned fixture boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-readiness-failure-"));
  const effectPath = join(root, ".invalid-readiness.json");
  const roles = ["package-manager", "parent", "descendant"];
  let boundary;
  let execution;
  try {
    boundary = await createSyntheticFixtureBoundary({ expectedRoles: roles });
    await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: slow
        timeoutMs: 90000
`, {
      slow: "node readiness-failure-fixture.cjs",
    });
    await writeNeverEndingTaskFixture(root, "readiness-failure-fixture.cjs", effectPath);
    const fixturePnpm = await writeFixturePnpm(root);
    execution = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], {
      env: {
        ...process.env,
        npm_execpath: fixturePnpm,
      },
      fixtureBoundary: boundary,
    });
    await assert.rejects(
      waitForFixtureEffect(effectPath, execution, (source) => {
        const record = JSON.parse(source);
        assert.equal(record.nonce, "intentionally-not-owned", "readiness nonce mismatch");
      }),
      /readiness nonce mismatch/u,
    );
    await boundary.waitForRoles();
    await execution.stop();
    await boundary.assertStopped();
  } finally {
    await cleanupSyntheticFixture({
      boundaries: [boundary],
      executions: [execution],
      roots: [root],
    });
  }
});

test("runtime marker rejects dynamically assembled recursive gate commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-recursion-"));
  const effectPath = join(root, ".recursion-readiness.json");
  const roles = ["package-manager", "recursion"];
  let boundary;
  let execution;
  try {
    boundary = await createSyntheticFixtureBoundary({ expectedRoles: roles });
    await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: dynamic
`, {
      dynamic: "node recursion-fixture.cjs",
    });
    await writeFile(join(root, "recursion-fixture.cjs"), `const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { writeFileSync } = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { connect } = require("./fixture-boundary-client.cjs");

void (async () => {
let nested;
await connect("recursion", async () => {
  if (nested === undefined || nested.exitCode !== null || nested.signalCode !== null) return;
  nested.kill("SIGTERM");
  const closed = await Promise.race([once(nested, "close").then(() => true), delay(1000, false)]);
  if (!closed && nested.exitCode === null && nested.signalCode === null) nested.kill("SIGKILL");
  if (!closed) await once(nested, "close");
});
writeFileSync(${JSON.stringify(effectPath)}, JSON.stringify({
  nonce: process.env.QGR_FIXTURE_NONCE,
  roles: ["package-manager", "recursion"]
}) + "\\n", { flag: "wx" });
nested = spawn(process.execPath, [
  process.env.GATE_CLI, "gate", "run", "verify", "--consumer", process.cwd()
], { stdio: "inherit" });
const [code] = await once(nested, "exit");
process.exit(code ?? 1);
})().catch((error) => { throw error; });
`, "utf8");
    const fixturePnpm = await writeFixturePnpm(root);
    execution = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], {
      env: {
        ...process.env,
        GATE_CLI: cliPath,
        npm_execpath: fixturePnpm,
      },
      fixtureBoundary: boundary,
    });
    await waitForFixtureEffect(effectPath, execution, parseOwnedReadiness(boundary, roles));
    await boundary.waitForRoles();
    const result = await execution.result;
    assert.equal(result.status, 2, JSON.stringify(result));
    const report = JSON.parse(result.stdout);
    assert.equal(report.tasks[0].outcome, "failed");
    assert.match(report.tasks[0].failureTail, /QUALITY_GATE_RECURSION/u);
    await boundary.assertStopped();
  } finally {
    await cleanupSyntheticFixture({
      boundaries: [boundary],
      executions: [execution],
      roots: [root],
    });
  }
});

test("SIGTERM cancels an active gate with the documented exit code", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-sigterm-"));
  const effectPath = join(root, ".cancellation-readiness.json");
  const roles = ["package-manager", "parent", "descendant"];
  let boundary;
  let execution;
  try {
    boundary = await createSyntheticFixtureBoundary({ expectedRoles: roles });
    await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: slow
`, {
      slow: "node cancellation-fixture.cjs",
    });
    await writeNeverEndingTaskFixture(root, "cancellation-fixture.cjs", effectPath);
    const fixturePnpm = await writeFixturePnpm(root);
    execution = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], {
      env: {
        ...process.env,
        npm_execpath: fixturePnpm,
      },
      fixtureBoundary: boundary,
    });
    await waitForFixtureEffect(effectPath, execution, parseOwnedReadiness(boundary, roles));
    await boundary.waitForRoles();
    assert.equal(execution.command.kill("SIGTERM"), true);
    const result = await execution.result;
    assert.deepEqual(
      { code: result.status, signal: result.signal },
      { code: 143, signal: null },
    );
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "cancelled");
    assert.equal(report.tasks[0].outcome, "cancelled");
    await boundary.assertStopped();
  } finally {
    await cleanupSyntheticFixture({
      boundaries: [boundary],
      executions: [execution],
      roots: [root],
    });
  }
});

test("SIGTERM closes both simultaneous task-specific managed boundaries", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-concurrent-sigterm-"));
  let boundaries = [];
  let execution;
  try {
    const fixture = await writeConcurrentManagedTaskFixture(root);
    const managed = await createConcurrentTaskBoundaries(
      root,
      fixture.tasks,
    );
    boundaries = managed.boundaries;
    execution = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], {
      env: { ...process.env, npm_execpath: managed.fixturePnpm },
    });
    await Promise.all(fixture.tasks.map(({ effectPath, roles }, index) => (
      waitForFixtureEffect(effectPath, execution, parseOwnedReadiness(boundaries[index], roles))
    )));
    await Promise.all(boundaries.map((boundary) => boundary.waitForRoles()));
    await Promise.all(boundaries.map((boundary) => boundary.assertActive()));
    assert.equal(execution.command.kill("SIGTERM"), true);
    const result = await execution.result;
    assert.deepEqual(
      { code: result.status, signal: result.signal },
      { code: 143, signal: null },
    );
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "cancelled");
    assert.deepEqual(
      report.tasks.map(({ id, outcome }) => [id, outcome]),
      [["slow-a", "cancelled"], ["slow-b", "cancelled"]],
    );
    await Promise.all(boundaries.map((boundary) => boundary.assertStopped()));
  } finally {
    await cleanupSyntheticFixture({
      boundaries,
      executions: [execution],
      roots: [root],
    });
  }
});
