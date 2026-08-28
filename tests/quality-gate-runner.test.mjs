import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assert as assertProperty, integer, property } from "fast-check";

import { PackageScriptTimeoutError } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/ports/package-script-executor.js";
import { FilesystemPackageScriptCatalogReader } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/outbound/filesystem/filesystem-package-script-catalog-reader.js";
import {
  QualityGateGraphError,
  validateQualityGatePolicy,
} from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/policies/validate-quality-gate-graph.js";
import { runQualityGateProfile } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/use-cases/run-quality-gate-profile.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repositoryRoot, "packages", "engineering-foundation", "dist", "cli.js");
// This bounds a whole child CLI fixture on a loaded host. It is test-harness
// safety only and is independent from every QGR task timeout under test.
const TEST_HARNESS_WATCHDOG_MS = 120_000;
const TEST_HARNESS_SHUTDOWN_GRACE_MS = 5_000;

function policy(tasks, concurrency = 2) {
  return { packageManager: "pnpm", profiles: [{ id: "verify", concurrency, tasks }] };
}

function startCli(arguments_, options = {}) {
  const command = spawn(process.execPath, [cliPath, ...arguments_], {
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  command.stderr.setEncoding("utf8");
  command.stdout.setEncoding("utf8");
  command.stderr.on("data", (chunk) => { stderr += chunk; });
  command.stdout.on("data", (chunk) => { stdout += chunk; });

  let watchdogExpired = false;
  let forcedShutdown;
  const watchdog = setTimeout(() => {
    watchdogExpired = true;
    if (command.exitCode === null && command.signalCode === null) {
      command.kill("SIGTERM");
      forcedShutdown = setTimeout(() => {
        if (command.exitCode === null && command.signalCode === null) {
          command.kill("SIGKILL");
        }
      }, TEST_HARNESS_SHUTDOWN_GRACE_MS);
    }
  }, TEST_HARNESS_WATCHDOG_MS);

  const result = new Promise((resolve, reject) => {
    command.once("error", reject);
    command.once("close", (status, signal) => {
      if (watchdogExpired) {
        reject(new Error(
          `Test-harness watchdog expired after ${TEST_HARNESS_WATCHDOG_MS}ms; ` +
          "QGR task timeout semantics were not changed.",
        ));
        return;
      }
      resolve({ signal, status, stderr, stdout });
    });
  }).finally(() => {
    clearTimeout(watchdog);
    clearTimeout(forcedShutdown);
  });
  return { command, result };
}

function missingFile(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readFixtureEffect(path, parse) {
  return parse(await readFile(path, "utf8"));
}

async function waitForFixtureEffect(path, execution, parse = (source) => source) {
  let watcher;
  let reading = false;
  const effect = new Promise((resolve, reject) => {
    const observe = async () => {
      if (reading) {
        return;
      }
      reading = true;
      try {
        resolve(await readFixtureEffect(path, parse));
      } catch (error) {
        if (!missingFile(error)) {
          reject(error);
        }
      } finally {
        reading = false;
      }
    };
    watcher = watch(dirname(path), { persistent: false }, () => { void observe(); });
    watcher.once("error", reject);
    void observe();
  });
  const commandClosed = execution.result.then(async (result) => {
    try {
      return await readFixtureEffect(path, parse);
    } catch (error) {
      if (!missingFile(error)) {
        throw error;
      }
      throw new Error(`CLI exited before fixture readiness: ${JSON.stringify(result)}`, {
        cause: error,
      });
    }
  });
  try {
    return await Promise.race([effect, commandClosed]);
  } finally {
    watcher?.close();
  }
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function forceStopProcess(pid) {
  if (!Number.isSafeInteger(pid) || !processIsRunning(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

function parseProcessRecord(source) {
  const record = JSON.parse(source);
  assert.equal(Number.isSafeInteger(record.parent) && record.parent > 0, true);
  assert.equal(Number.isSafeInteger(record.descendant) && record.descendant > 0, true);
  return record;
}

function assertProcessTreeStopped(record) {
  assert.equal(processIsRunning(record.parent), false, `fixture parent ${record.parent} survived`);
  assert.equal(
    processIsRunning(record.descendant),
    false,
    `fixture descendant ${record.descendant} survived`,
  );
}

async function writeFixturePnpm(root) {
  const entrypoint = join(root, "fixture-pnpm.cjs");
  await writeFile(entrypoint, `const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
if (process.argv.length !== 4 || process.argv[2] !== "run") {
  throw new Error("Unexpected fixture pnpm arguments: " + JSON.stringify(process.argv.slice(2)));
}
const script = JSON.parse(readFileSync("package.json", "utf8")).scripts[process.argv[3]];
const match = /^node ([a-z0-9.-]+\\.cjs)$/u.exec(script);
if (match === null) {
  throw new Error("Fixture pnpm accepts only a single local Node script.");
}
const task = spawn(process.execPath, [match[1]], {
  stdio: "inherit"
});
task.once("error", (error) => { throw error; });
task.once("exit", (code) => { process.exit(code ?? 1); });
`, "utf8");
  return entrypoint;
}

async function writeNeverEndingTaskFixture(root, filename, effectPath) {
  await writeFile(join(root, filename), `const { spawn } = require("node:child_process");
const { renameSync, writeFileSync } = require("node:fs");
const descendant = spawn(process.execPath, ["--eval", "setInterval(() => {}, 60000)"], {
  stdio: "ignore"
});
const temporary = ${JSON.stringify(effectPath)} + "." + process.pid + ".tmp";
writeFileSync(temporary, JSON.stringify({ parent: process.pid, descendant: descendant.pid }) + "\\n");
renameSync(temporary, ${JSON.stringify(effectPath)});
setInterval(() => {}, 60000);
`, "utf8");
}

test("rejects duplicate, unknown, self, overlapping, and cyclic dependencies", () => {
  const invalid = [
    policy([{ id: "a", needs: [], after: [] }, { id: "a", needs: [], after: [] }]),
    policy([{ id: "a", needs: ["missing"], after: [] }]),
    policy([{ id: "a", needs: ["a"], after: [] }]),
    policy([{ id: "a", needs: [], after: [] }, { id: "b", needs: ["a"], after: ["a"] }]),
    policy([{ id: "a", needs: ["b"], after: [] }, { id: "b", needs: [], after: ["a"] }]),
  ];
  for (const candidate of invalid) {
    assert.throws(() => validateQualityGatePolicy(candidate), QualityGateGraphError);
  }
});

test("accepts generated DAGs regardless of dependency density", () => {
  assertProperty(
    property(integer({ min: 1, max: 48 }), integer({ min: 0, max: 7 }), (size, divisor) => {
      const tasks = Array.from({ length: size }, (_, index) => ({
        id: `t${index}`,
        needs: Array.from({ length: index }, (_unused, dependency) => dependency)
          .filter((dependency) => (dependency + index) % (divisor + 2) === 0)
          .map((dependency) => `t${dependency}`),
        after: [],
      }));
      assert.doesNotThrow(() => validateQualityGatePolicy(policy(tasks)));
    }),
    { numRuns: 200, seed: 42 },
  );
});

test("schedules needs and after with bounded concurrency and deterministic report order", async () => {
  let active = 0;
  let maximumActive = 0;
  const starts = [];
  const executor = {
    async run({ scriptId }) {
      starts.push(scriptId);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => { setTimeout(resolve, scriptId === "a" ? 15 : 1); });
      active -= 1;
      return {
        exitCode: scriptId === "a" ? 7 : 0,
        signal: null,
        stdout: scriptId === "a" ? `old\n${"x".repeat(9000)}\u001b]52;c;unsafe\u0007` : "",
        stderr: scriptId === "a" ? "begin\rfailure-end" : "",
      };
    },
  };
  const report = await runQualityGateProfile({
    consumerRoot: "/fixture",
    profile: policy([
      { id: "a", needs: [], after: [] },
      { id: "parallel", needs: [], after: [] },
      { id: "blocked", needs: ["a"], after: [] },
      { id: "cleanup", needs: [], after: ["a"] },
    ], 2).profiles[0],
  }, executor, { nowMs: () => performance.now() });

  assert.equal(maximumActive, 2);
  assert.deepEqual(starts, ["a", "parallel", "cleanup"]);
  assert.deepEqual(report.tasks.map(({ id, outcome }) => [id, outcome]), [
    ["a", "failed"],
    ["parallel", "passed"],
    ["blocked", "blocked"],
    ["cleanup", "passed"],
  ]);
  assert.equal(report.tasks[0].failureTail.length <= 8192, true);
  assert.match(report.tasks[0].failureTail, /failure-end$/u);
  assert.match(report.tasks[0].failureTail, /\\u\{001b\}/u);
  assert.match(report.tasks[0].failureTail, /\\u\{000d\}/u);
  assert.equal([...report.tasks[0].failureTail].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x08 ||
      (codePoint >= 0x0b && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f);
  }), false);
});

test("classifies timeout and cancellation without starting dependent tasks", async () => {
  const timeoutReport = await runQualityGateProfile({
    consumerRoot: "/fixture",
    profile: policy([
      { id: "slow", needs: [], after: [], timeoutMs: 5 },
      { id: "dependent", needs: ["slow"], after: [] },
    ]).profiles[0],
  }, {
    async run() { throw new PackageScriptTimeoutError(5); },
  }, { nowMs: () => 1 });
  assert.deepEqual(timeoutReport.tasks.map(({ outcome }) => outcome), ["timed-out", "blocked"]);

  const controller = new AbortController();
  const cancellation = runQualityGateProfile({
    consumerRoot: "/fixture",
    profile: policy([{ id: "slow", needs: [], after: [] }]).profiles[0],
    signal: controller.signal,
  }, {
    run: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }),
  }, { nowMs: () => 1 });
  controller.abort();
  assert.equal((await cancellation).outcome, "cancelled");

  const adapterFailure = await runQualityGateProfile({
    consumerRoot: "/fixture",
    profile: policy([{ id: "broken", needs: [], after: [] }]).profiles[0],
  }, {
    async run() { throw new Error("unsafe\u001b]52;c;payload\u0007"); },
  }, { nowMs: () => 1 });
  assert.equal(adapterFailure.tasks[0].outcome, "failed");
  assert.equal(adapterFailure.tasks[0].failureTail, "unsafe\\u{001b}]52;c;payload\\u{0007}");
});

test("package catalog cancellation keeps the stable cancelled outcome", async () => {
  const controller = new AbortController();
  controller.abort("test cancellation");
  await assert.rejects(
    new FilesystemPackageScriptCatalogReader().read("/not-read", controller.signal),
    (error) => error?.problem?.code === "EXECUTION_CANCELLED",
  );
});

async function writeConsumer(root, profileSource, scripts) {
  await mkdir(join(root, "architecture", "foundation"), { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "quality-gate-test-consumer",
    private: true,
    packageManager: "pnpm@11.20.0",
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

test("CLI preserves a failing script exit code and emits versioned JSON evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-cli-"));
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
    const { result } = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], { env: { ...process.env, npm_execpath: fixturePnpm } });
    const completed = await result;
    assert.equal(completed.status, 7, JSON.stringify(completed));
    const report = JSON.parse(completed.stdout);
    assert.equal(report.reportSchemaVersion, 1);
    assert.equal(report.outcome, "failed");
    assert.equal(report.tasks[0].exitCode, 7);
    assert.match(report.tasks[0].failureTail, /failure-tail$/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("static capability check validates an opted-in profile without running scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-static-"));
  const marker = join(root, "must-not-exist");
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
    const { result } = startCli([
      "check", "quality.gate-runner", "--consumer", root, "--format", "json",
    ]);
    const completed = await result;
    assert.equal(completed.status, 0, JSON.stringify(completed));
    assert.equal(JSON.parse(completed.stdout).outcome, "passed");
    assert.equal(await import("node:fs").then(({ existsSync }) => existsSync(marker)), false);
  } finally {
    await rm(root, { force: true, recursive: true });
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
    try {
      await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
${candidate.source}`, candidate.scripts);
      const { result } = startCli([
        "gate", "run", "verify", "--consumer", root,
      ]);
      const completed = await result;
      assert.equal(completed.status, 2);
      assert.match(completed.stderr, new RegExp(`^${candidate.expected}:`, "u"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("CLI enforces a real per-task timeout and returns 124", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-timeout-"));
  const effectPath = join(root, ".timeout-processes.json");
  let record;
  try {
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
    const execution = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], { env: { ...process.env, npm_execpath: fixturePnpm } });
    record = await waitForFixtureEffect(effectPath, execution, parseProcessRecord);
    const result = await execution.result;
    assert.equal(result.status, 124, JSON.stringify(result));
    assert.equal(JSON.parse(result.stdout).tasks[0].outcome, "timed-out");
    assertProcessTreeStopped(record);
  } finally {
    forceStopProcess(record?.parent);
    forceStopProcess(record?.descendant);
    await rm(root, { force: true, recursive: true });
  }
});

test("runtime marker rejects dynamically assembled recursive gate commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-recursion-"));
  const effectPath = join(root, ".recursion-started");
  try {
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
const { renameSync, writeFileSync } = require("node:fs");
const temporary = ${JSON.stringify(effectPath)} + "." + process.pid + ".tmp";
writeFileSync(temporary, String(process.pid));
renameSync(temporary, ${JSON.stringify(effectPath)});
const nested = spawn(process.execPath, [
  process.env.GATE_CLI, "gate", "run", "verify", "--consumer", process.cwd()
], { stdio: "inherit" });
nested.once("error", (error) => { throw error; });
nested.once("exit", (code) => { process.exit(code ?? 1); });
`, "utf8");
    const fixturePnpm = await writeFixturePnpm(root);
    const execution = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], {
      env: { ...process.env, GATE_CLI: cliPath, npm_execpath: fixturePnpm },
    });
    await waitForFixtureEffect(effectPath, execution, (source) => {
      assert.equal(Number.parseInt(source, 10) > 0, true);
    });
    const result = await execution.result;
    assert.equal(result.status, 2, JSON.stringify(result));
    const report = JSON.parse(result.stdout);
    assert.equal(report.tasks[0].outcome, "failed");
    assert.match(report.tasks[0].failureTail, /QUALITY_GATE_RECURSION/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("SIGTERM cancels an active gate with the documented exit code", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-sigterm-"));
  const effectPath = join(root, ".cancellation-processes.json");
  let execution;
  let record;
  try {
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
    ], { env: { ...process.env, npm_execpath: fixturePnpm } });
    record = await waitForFixtureEffect(effectPath, execution, parseProcessRecord);
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
    assertProcessTreeStopped(record);
  } finally {
    if (execution?.command.exitCode === null && execution.command.signalCode === null) {
      execution.command.kill("SIGKILL");
    }
    forceStopProcess(record?.parent);
    forceStopProcess(record?.descendant);
    await rm(root, { force: true, recursive: true });
  }
});
