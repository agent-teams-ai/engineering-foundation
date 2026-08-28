import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Ajv2020 } from "ajv/dist/2020.js";

import {
  createNodeQualityGateCancellationSource,
  createQualityGateCommand,
} from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/gate-command.js";
import { runQualityGateProfile } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/use-cases/run-quality-gate-profile.js";
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
      cancellationSource: createNodeQualityGateCancellationSource(),
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
  const [cleanupSource, nodeAdapterSource, windowsAdapterSource] = await Promise.all([
    readFile(join(process.cwd(), "tests", "support", "quality-gate-runner-cleanup.mjs"), "utf8"),
    readFile(join(process.cwd(), "packages", "engineering-foundation", "src", "process-execution", "node-process-runner.ts"), "utf8"),
    readFile(join(process.cwd(), "packages", "engineering-foundation", "src", "process-execution", "windows-managed-process.ts"), "utf8"),
  ]);
  assert.match(cleanupSource, /spawnNodeManagedProcess/u);
  assert.match(cleanupSource, /terminateNodeManagedProcess/u);
  assert.match(cleanupSource, /terminatePosixProcessGroup/u);
  assert.match(nodeAdapterSource, /return spawnWindowsManagedProcess\(request\)/u);
  assert.match(nodeAdapterSource, /Windows Job Object wrapper did not exit after forced shutdown/u);
  assert.match(windowsAdapterSource, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
  assert.match(windowsAdapterSource, /TerminateRemainingProcessesAndWait\(job\)/u);
  assert.match(windowsAdapterSource, /while \(ActiveProcessCount\(job\) > 0\)/u);
});
