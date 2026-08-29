import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Ajv2020 } from "ajv/dist/2020.js";

import {
  createQualityGateCommand,
} from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/gate-command.js";
import { NodeSignalQualityGateCancellationSource } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/inbound/cli/node-signal-cancellation-source.js";
import { runQualityGateProfile } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/use-cases/run-quality-gate-profile.js";
import { PnpmQualityGateScriptExecutor } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/outbound/pnpm/pnpm-package-script-executor.js";
import { CapabilityInputError } from "../packages/engineering-foundation/dist/capability-runtime.js";
import { parseArguments } from "../packages/engineering-foundation/dist/cli-arguments.js";
import { FoundationError } from "../packages/engineering-foundation/dist/errors.js";
import { createQualityGateCliCommand } from "../packages/engineering-foundation/dist/quality-gate-cli-command.js";
import {
  cleanupSyntheticFixture,
  createControlledQgrCancellationSource,
  createSyntheticFixtureBoundaries,
  createSyntheticFixtureBoundary,
  startBoundedCli,
  waitForFixtureEffect,
} from "./support/quality-gate-runner-lifecycle.mjs";

function policy() {
  return {
    packageManager: "pnpm",
    profiles: [{
      concurrency: 1,
      id: "verify",
      tasks: [{ after: [], id: "slow", needs: [] }],
    }],
  };
}

function startCapturedEntrypoint(start) {
  const previousExitCode = process.exitCode;
  const previousStderrWrite = process.stderr.write;
  const previousStdoutWrite = process.stdout.write;
  let stderr = "";
  let stdout = "";
  process.exitCode = undefined;
  process.stderr.write = function captureStderr(chunk, ...arguments_) {
    if (typeof chunk !== "string") {
      return previousStderrWrite.call(this, chunk, ...arguments_);
    }
    stderr += chunk;
    return true;
  };
  process.stdout.write = function captureStdout(chunk, ...arguments_) {
    if (typeof chunk !== "string") {
      return previousStdoutWrite.call(this, chunk, ...arguments_);
    }
    stdout += chunk;
    return true;
  };
  const result = Promise.resolve()
    .then(start)
    .then((value) => ({ exitCode: process.exitCode, stderr, stdout, value }))
    .finally(() => {
      process.stderr.write = previousStderrWrite;
      process.stdout.write = previousStdoutWrite;
      process.exitCode = previousExitCode;
    });
  return { result };
}

function cancelledDuringSetup(signal) {
  return new Promise((_resolve, reject) => {
    const cancel = () => {
      reject(new CapabilityInputError({
        code: "EXECUTION_CANCELLED",
        message: "Quality gate execution was cancelled.",
        phase: "foundation-config",
        retryable: false,
      }));
    };
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

test("entrypoint retains config-load SIGTERM through canonical JSON and concise text projection", async () => {
  const commandErrorSchema = JSON.parse(await readFile(new URL(
    "../packages/engineering-foundation/schemas/foundation-command-error/v1.schema.json",
    import.meta.url,
  ), "utf8"));
  const validateCommandError = new Ajv2020({ strict: true }).compile(commandErrorSchema);
  const baseline = {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
  };
  for (const format of ["json", "text"]) {
    let configLoadStarted;
    let observedSignal;
    const started = new Promise((resolve) => { configLoadStarted = resolve; });
    const entrypoint = createQualityGateCliCommand({
      cancellationSource: new NodeSignalQualityGateCancellationSource(),
      commandFactory() {
        throw new Error("QGR command must not start after configuration cancellation.");
      },
      async foundationConfigLoader(_consumerRoot, signal) {
        observedSignal = signal;
        configLoadStarted();
        assert.equal(process.listenerCount("SIGINT"), baseline.SIGINT + 1);
        assert.equal(process.listenerCount("SIGTERM"), baseline.SIGTERM + 1);
        await cancelledDuringSetup(signal);
      },
    });
    const parsed = parseArguments([
      "gate", "run", "verify", "--consumer", "/fixture", "--format", format,
    ]);
    const captured = startCapturedEntrypoint(() => entrypoint(parsed, {}));
    await started;
    process.emit("SIGTERM");
    process.emit("SIGINT");
    const completed = await captured.result;

    assert.equal(completed.value, true);
    assert.equal(completed.exitCode, 143);
    assert.equal(observedSignal.aborted, true);
    assert.equal(observedSignal.reason, "terminate");
    if (format === "json") {
      const envelope = JSON.parse(completed.stdout);
      assert.equal(
        validateCommandError(envelope),
        true,
        JSON.stringify(validateCommandError.errors),
      );
      assert.deepEqual(envelope, {
        schemaVersion: 1,
        outcome: "cancelled",
        error: {
          code: "EXECUTION_CANCELLED",
          message: "Quality gate execution was cancelled.",
          retryable: false,
        },
      });
      assert.equal(completed.stdout, `${JSON.stringify(envelope)}\n`);
      assert.equal(completed.stderr, "");
    } else {
      assert.equal(completed.stdout, "");
      assert.equal(completed.stderr, "Quality gate execution was cancelled.\n");
    }
    assert.equal(process.listenerCount("SIGINT"), baseline.SIGINT);
    assert.equal(process.listenerCount("SIGTERM"), baseline.SIGTERM);
  }
});

test("entrypoint keeps an observed output-limit failure above concurrent cancellation", async () => {
  const cancellationSource = createControlledQgrCancellationSource();
  let configSignal;
  let executionStarted;
  const started = new Promise((resolve) => { executionStarted = resolve; });
  const command = createQualityGateCommand({
    catalogReader: {
      async read(_consumerRoot, signal) {
        assert.equal(signal, configSignal);
        return { scripts: { slow: "node slow.cjs" } };
      },
    },
    clock: { nowMs: () => 0 },
    executor: {
      async run({ signal }) {
        assert.equal(signal, configSignal);
        executionStarted();
        await new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
        throw new FoundationError(
          "PROCESS_FAILED",
          "Managed process exceeded the stdout output limit of 1048576 bytes.",
        );
      },
    },
    async policyLoader(_consumerRoot, _configPath, signal) {
      assert.equal(signal, configSignal);
      return policy();
    },
  });
  const entrypoint = createQualityGateCliCommand({
    cancellationSource,
    commandFactory: () => command,
    async foundationConfigLoader(_consumerRoot, signal) {
      configSignal = signal;
      return {
        declaredCapabilities: [{
          configPath: "architecture/foundation/quality-gates.yaml",
          id: "quality.gate-runner",
        }],
        projectId: "fixture",
      };
    },
  });
  const parsed = parseArguments([
    "gate", "run", "verify", "--consumer", "/fixture", "--format", "json",
  ]);
  const captured = startCapturedEntrypoint(() => entrypoint(parsed, {}));
  await started;
  cancellationSource.cancel("terminate");
  const completed = await captured.result;
  const report = JSON.parse(completed.stdout);

  assert.equal(completed.value, true);
  assert.equal(completed.exitCode, 1);
  assert.equal(completed.stderr, "");
  assert.equal(report.outcome, "failed");
  assert.equal(report.tasks[0].outcome, "failed");
  assert.equal(report.tasks[0].exitCode, null);
  assert.match(report.tasks[0].failureTail, /stdout output limit/u);
  assert.throws(
    () => cancellationSource.cancel("interrupt"),
    /without an active subscriber/u,
  );
});

test("late cancellation retains an already observed passing task", async () => {
  const controller = new AbortController();
  const report = await runQualityGateProfile({
    consumerRoot: "/fixture",
    profile: policy().profiles[0],
    signal: controller.signal,
  }, {
    async run() {
      controller.abort("late cancellation");
      return { exitCode: 0, signal: null, stderr: "", stdout: "" };
    },
  }, { nowMs: () => 1 });

  assert.equal(report.outcome, "cancelled");
  assert.deepEqual(report.tasks[0], {
    id: "slow",
    outcome: "passed",
    durationMs: 0,
    exitCode: 0,
    signal: null,
    failureTail: "",
  });
});

test("QGR binds one immutable exact child environment in the pnpm adapter", async () => {
  const publicProcessDeclarations = await readFile(new URL(
    "../packages/engineering-foundation/dist/process-execution/types.d.ts",
    import.meta.url,
  ), "utf8");
  const processRequestDeclaration = publicProcessDeclarations.match(
    /export interface ProcessRequest \{(?<body>[\s\S]*?)\n\}/u,
  );
  assert.ok(processRequestDeclaration?.groups?.body);
  assert.doesNotMatch(processRequestDeclaration.groups.body, /\benvironment\??\s*:/u);

  const original = { FOUNDATION_ENV_TEST: "before" };
  const childEnvironment = Object.freeze({
    ...original,
    AGENT_TEAMS_FOUNDATION_QUALITY_GATE_ACTIVE: "verify",
  });
  let releasePolicy;
  let policyStarted;
  const policyReady = new Promise((resolve) => { policyStarted = resolve; });
  const command = createQualityGateCommand({
    catalogReader: { async read() { return { scripts: { slow: "node slow.cjs" } }; } },
    clock: { nowMs: () => 0 },
    executor: new PnpmQualityGateScriptExecutor({
      childEnvironment,
      npmExecPath: new URL(import.meta.url).pathname,
    }, {
      async run(request) {
        assert.equal(Object.isFrozen(request.environment), true);
        assert.deepEqual(request.environment, {
          AGENT_TEAMS_FOUNDATION_QUALITY_GATE_ACTIVE: "verify",
          FOUNDATION_ENV_TEST: "before",
        });
        assert.throws(() => {
          request.environment.FOUNDATION_ENV_TEST = "changed";
        }, TypeError);
        return { exitCode: 0, signal: null, stderr: "", stdout: "" };
      },
    }),
    async policyLoader() {
      policyStarted();
      await new Promise((resolve) => { releasePolicy = resolve; });
      return policy();
    },
  });
  const execution = command({
    configPath: "/fixture/quality-gates.yaml",
    consumerRoot: "/fixture",
    profileId: "verify",
  });
  await policyReady;
  original.FOUNDATION_ENV_TEST = "after";
  original.LATE_ENV_TEST = "must-not-leak";
  releasePolicy();

  const report = await execution;
  assert.equal(report.outcome, "passed");
  assert.deepEqual(original, {
    FOUNDATION_ENV_TEST: "after",
    LATE_ENV_TEST: "must-not-leak",
  });
});

test("QGR application contracts contain no Node process environment transport", async () => {
  const applicationRoot = new URL(
    "../packages/engineering-foundation/src/capabilities/quality-gate-runner/application/",
    import.meta.url,
  );
  const sources = await Promise.all([
    "ports/package-script-executor.ts",
    "use-cases/run-quality-gate-profile.ts",
  ].map((path) => readFile(new URL(path, applicationRoot), "utf8")));
  for (const source of sources) {
    assert.doesNotMatch(source, /NodeJS\.ProcessEnv|environment\??:/u);
  }
});

test("QGR setup cancellation delegates its JSON envelope to the canonical Foundation failure mapper", async () => {
  const projectionSource = await readFile(new URL(
    "../packages/engineering-foundation/src/capabilities/quality-gate-runner/adapters/inbound/cli/quality-gate-cli.ts",
    import.meta.url,
  ), "utf8");
  const commandSource = await readFile(new URL(
    "../packages/engineering-foundation/src/quality-gate-cli-command.ts",
    import.meta.url,
  ), "utf8");
  assert.doesNotMatch(projectionSource, /schemaVersion|EXECUTION_CANCELLED/u);
  assert.match(commandSource, /foundationCommandFailure\(error\)\.envelope/u);
});

test("real SIGINT cancellation projects canonical JSON and exits 130", {
  skip: process.platform === "win32",
  timeout: 15_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-real-sigint-"));
  const readyPath = join(root, "ready.txt");
  let execution;
  try {
    await mkdir(join(root, "architecture", "foundation"), { recursive: true });
    const fixturePnpm = join(root, "fixture-pnpm.cjs");
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "qgr-real-sigint",
      private: true,
      scripts: { slow: "fixture" },
    })}\n`, "utf8");
    await writeFile(join(root, "foundation.config.yaml"), `schemaVersion: 1
project:
  id: qgr-real-sigint
capabilities:
  quality.gate-runner:
    configPath: architecture/foundation/quality-gates.yaml
`, "utf8");
    await writeFile(join(root, "architecture", "foundation", "quality-gates.yaml"), `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: slow
`, "utf8");
    await writeFile(fixturePnpm, `const { writeFileSync } = require("node:fs");
if (process.argv.slice(2).join(" ") !== "run slow") throw new Error("Unexpected pnpm invocation");
if (process.env.AGENT_TEAMS_FOUNDATION_QUALITY_GATE_ACTIVE !== "verify") throw new Error("Missing recursion marker");
writeFileSync(${JSON.stringify(readyPath)}, "ready", { flag: "wx" });
setInterval(() => {}, 60_000);
`, "utf8");
    const cliPath = join(process.cwd(), "packages", "engineering-foundation", "dist", "cli.js");
    execution = startBoundedCli(cliPath, [
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], {
      deferWatchdogUntilReady: true,
      env: { ...process.env, npm_execpath: fixturePnpm },
    });
    await waitForFixtureEffect(readyPath, execution);
    assert.equal(execution.command.kill("SIGINT"), true);
    const result = await execution.result;
    assert.deepEqual({ code: result.status, signal: result.signal }, { code: 130, signal: null });
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "cancelled");
    assert.equal(report.tasks[0].outcome, "cancelled");
  } finally {
    await cleanupSyntheticFixture({ executions: [execution], roots: [root] });
  }
});

test("partial concurrent-boundary setup closes every created server before rethrowing", async () => {
  const setupFailure = new Error("injected boundary setup failure");
  const created = [];
  let setupCalls = 0;
  await assert.rejects(
    createSyntheticFixtureBoundaries([
      { expectedRoles: ["first"] },
      { expectedRoles: ["second"] },
    ], {
      async createBoundary(options) {
        setupCalls += 1;
        if (setupCalls > 1) {
          throw setupFailure;
        }
        const boundary = await createSyntheticFixtureBoundary(options);
        created.push(boundary);
        return boundary;
      },
    }),
    (error) => {
      assert.equal(error, setupFailure);
      assert.deepEqual(error.setupCleanupFailures, []);
      return true;
    },
  );
  assert.equal(created.length, 1);
  assert.equal(created[0].isServerListening(), false);
});

test("POSIX watchdog kills a stubborn descendant tree before fixture root cleanup", {
  skip: process.platform === "win32",
  timeout: 15_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-stubborn-watchdog-"));
  const fixture = join(root, "stubborn-parent.cjs");
  const pidPath = join(root, "descendant-pid.json");
  let descendantPid;
  let execution;
  try {
    const descendantFixture = join(root, "stubborn-descendant.cjs");
    await writeFile(descendantFixture, `process.on("SIGTERM", () => {});
if (process.send === undefined) throw new Error("Detached descendant IPC is unavailable.");
process.send("ready");
setInterval(() => {}, 60000);
`, "utf8");
    await writeFile(fixture, `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, [${JSON.stringify(descendantFixture)}], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit", "ipc"]
});
child.once("message", (message) => {
  if (message !== "ready") throw new Error("Unexpected detached descendant readiness message.");
  writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ pid: child.pid }) + "\\n", { flag: "wx" });
  child.disconnect();
});
setInterval(() => {}, 60000);
`, "utf8");
    execution = startBoundedCli(fixture, [], {
      cleanupDeadlineMs: 5_000,
      deferWatchdogUntilReady: true,
      shutdownGraceMs: 2_000,
      watchdogMs: 1_000,
    });
    const completion = execution.result.then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    const readinessDeadline = Date.now() + 5_000;
    while (descendantPid === undefined && Date.now() < readinessDeadline) {
      try {
        descendantPid = JSON.parse(await readFile(pidPath, "utf8")).pid;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        await delay(10);
      }
    }
    assert.equal(Number.isSafeInteger(descendantPid), true);
    execution.manageProcessGroup(descendantPid);
    execution.armWatchdog();
    const { error: watchdogError, result } = await completion;
    assert.equal(result, undefined, "stubborn fixture should reach the watchdog");
    assert.match(watchdogError.message, /watchdog expired/u);
    assert.deepEqual(await watchdogError.cleanup, []);
    execution = undefined;
    assert.throws(
      () => process.kill(-descendantPid, 0),
      (error) => error?.code === "ESRCH",
    );
    await cleanupSyntheticFixture({ roots: [root] });
    await assert.rejects(readFile(root, "utf8"), (error) => error?.code === "ENOENT");
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(-descendantPid, "SIGKILL");
      } catch {
        // The contained descendant already exited.
      }
    }
    await cleanupSyntheticFixture({ executions: [execution], roots: [root] });
  }
});

test("Windows watchdog contract retains Job Object ownership and awaits descendants", async () => {
  const [cleanupSource, nodeAdapterSource, windowsManagedProcessSource] = await Promise.all([
    readFile(join(process.cwd(), "tests", "support", "quality-gate-runner-cleanup.mjs"), "utf8"),
    readFile(join(process.cwd(), "packages", "engineering-foundation", "src", "process-execution", "node-process-runner.ts"), "utf8"),
    readFile(join(process.cwd(), "packages", "engineering-foundation", "assets", "windows-managed-process", "WindowsManagedProcess.cs"), "utf8"),
  ]);
  assert.match(cleanupSource, /spawnNodeManagedProcess/u);
  assert.match(cleanupSource, /terminateNodeManagedProcess/u);
  assert.match(cleanupSource, /terminatePosixProcessGroup/u);
  assert.match(nodeAdapterSource, /return spawnWindowsManagedProcess\(request\)/u);
  assert.match(nodeAdapterSource, /Windows Job Object wrapper did not exit after forced shutdown/u);
  assert.match(windowsManagedProcessSource, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
  assert.match(windowsManagedProcessSource, /TerminateRemainingProcessesAndWait\(job\)/u);
  assert.match(windowsManagedProcessSource, /while \(ActiveProcessCount\(job\) > 0\)/u);
});
