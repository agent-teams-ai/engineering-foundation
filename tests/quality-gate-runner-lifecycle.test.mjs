import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
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

async function writeFixturePnpm(root, taskAuthorities = {}) {
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
const taskAuthorities = ${JSON.stringify(taskAuthorities)};
const authority = taskAuthorities[scriptId];
if (authority?.packageManager !== undefined) {
  Object.assign(process.env, authority.packageManager);
}
let task;
await connect(async () => {
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
  env: authority?.task === undefined ? process.env : { ...process.env, ...authority.task },
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
  descendantEnvironment,
  readinessRoles = ["package-manager", "parent", "descendant"],
} = {}) {
  await writeFixtureBoundaryClient(root);
  const descendantSource = `const { connect } = require("./fixture-boundary-client.cjs");
void (async () => {
  await connect();
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
const stopDescendant = async () => {
  if (descendant === undefined || descendant.exitCode !== null || descendant.signalCode !== null) return;
  descendant.kill("SIGTERM");
  const closed = await Promise.race([once(descendant, "close").then(() => true), delay(1000, false)]);
  if (!closed && descendant.exitCode === null && descendant.signalCode === null) descendant.kill("SIGKILL");
  if (!closed) await once(descendant, "close");
};
await connect(stopDescendant);
descendant = spawn(process.execPath, ["--eval", ${JSON.stringify(descendantSource)}], {
  env: { ...process.env, ...${JSON.stringify(descendantEnvironment)} },
  stdio: ["ignore", "ignore", "ignore", "ipc"]
});
await once(descendant, "message");
writeFileSync(${JSON.stringify(effectPath)}, JSON.stringify({
  evidenceId: process.env.QGR_FIXTURE_BOUNDARY_ID,
  roles: ${JSON.stringify(readinessRoles)}
}) + "\\n", { flag: "wx" });
setInterval(() => {}, 60000);
})().catch((error) => { throw error; });
`, "utf8");
}

function parseOwnedReadiness(boundary, roles) {
  return (source) => {
    const record = JSON.parse(source);
    assert.deepEqual(record, { evidenceId: boundary.evidenceId, roles });
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

async function writeConcurrentManagedTaskFixture(root) {
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
  await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 2
    tasks:
      - id: slow-a
      - id: slow-b
`, Object.fromEntries(tasks.map(({ filename, scriptId }) => [scriptId, `node ${filename}`])));
  return {
    tasks,
  };
}

async function createConcurrentTaskBoundaries(root, tasks) {
  const boundaries = await Promise.all(tasks.map(({ roles }) => (
    createSyntheticFixtureBoundary({ expectedRoles: roles, shutdownGraceMs: 20_000 })
  )));
  for (const [index, task] of tasks.entries()) {
    await writeNeverEndingTaskFixture(root, task.filename, task.effectPath, {
      descendantEnvironment: boundaries[index].environmentFor(task.descendantRole),
      readinessRoles: task.roles,
    });
  }
  const fixturePnpm = await writeFixturePnpm(root, Object.fromEntries(
    tasks.map(({ packageManagerRole, parentRole, scriptId }, index) => [scriptId, {
      packageManager: boundaries[index].environmentFor(packageManagerRole),
      task: boundaries[index].environmentFor(parentRole),
    }]),
  ));
  return { boundaries, fixturePnpm };
}

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

test("readiness failure cleans up and awaits the credential-owned fixture boundary", async () => {
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
`, {
      slow: "node readiness-failure-fixture.cjs",
    });
    await writeNeverEndingTaskFixture(root, "readiness-failure-fixture.cjs", effectPath, {
      descendantEnvironment: boundary.environmentFor("descendant"),
    });
    const fixturePnpm = await writeFixturePnpm(root, {
      slow: {
        packageManager: boundary.environmentFor("package-manager"),
        task: boundary.environmentFor("parent"),
      },
    });
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
        assert.equal(
          record.evidenceId,
          "intentionally-not-owned",
          "readiness evidence ID mismatch",
        );
      }),
      /readiness evidence ID mismatch/u,
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
await connect(async () => {
  if (nested === undefined || nested.exitCode !== null || nested.signalCode !== null) return;
  nested.kill("SIGTERM");
  const closed = await Promise.race([once(nested, "close").then(() => true), delay(1000, false)]);
  if (!closed && nested.exitCode === null && nested.signalCode === null) nested.kill("SIGKILL");
  if (!closed) await once(nested, "close");
});
writeFileSync(${JSON.stringify(effectPath)}, JSON.stringify({
  evidenceId: process.env.QGR_FIXTURE_BOUNDARY_ID,
  roles: ["package-manager", "recursion"]
}) + "\\n", { flag: "wx" });
nested = spawn(process.execPath, [
  process.env.GATE_CLI, "gate", "run", "verify", "--consumer", process.cwd()
], { stdio: "inherit" });
const [code] = await once(nested, "exit");
process.exit(code ?? 1);
})().catch((error) => { throw error; });
`, "utf8");
    const fixturePnpm = await writeFixturePnpm(root, {
      dynamic: {
        packageManager: boundary.environmentFor("package-manager"),
        task: boundary.environmentFor("recursion"),
      },
    });
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
    await writeNeverEndingTaskFixture(root, "cancellation-fixture.cjs", effectPath, {
      descendantEnvironment: boundary.environmentFor("descendant"),
    });
    const fixturePnpm = await writeFixturePnpm(root, {
      slow: {
        packageManager: boundary.environmentFor("package-manager"),
        task: boundary.environmentFor("parent"),
      },
    });
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
    let cliCompleted = false;
    const completion = execution.result.then((result) => {
      cliCompleted = true;
      return result;
    });
    assert.equal(execution.command.kill("SIGTERM"), true);
    await boundary.assertStopped();
    assert.equal(cliCompleted, false, "owned roles must stop before final CLI completion");
    const result = await completion;
    assert.deepEqual(
      { code: result.status, signal: result.signal },
      { code: 143, signal: null },
    );
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "cancelled");
    assert.equal(report.tasks[0].outcome, "cancelled");
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
    let cliCompleted = false;
    const completion = execution.result.then((result) => {
      cliCompleted = true;
      return result;
    });
    assert.equal(execution.command.kill("SIGTERM"), true);
    await Promise.all(boundaries.map((boundary) => boundary.assertStopped()));
    assert.equal(cliCompleted, false, "owned boundaries must stop before final CLI completion");
    const result = await completion;
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
  } finally {
    await cleanupSyntheticFixture({
      boundaries,
      executions: [execution],
      roots: [root],
    });
  }
});
