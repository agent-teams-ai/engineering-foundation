import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Ajv2020 } from "ajv/dist/2020.js";

import { createQualityGateCommand } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/gate-command.js";
import { PackageScriptCancellationError } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/ports/package-script-executor.js";
import { runQualityGateProfile } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/use-cases/run-quality-gate-profile.js";
import {
  cleanupSyntheticFixture,
  createControlledQgrCancellationSource,
  createSyntheticFixtureBoundaries,
  createSyntheticFixtureBoundary,
  startBoundedCli,
  startCapturedQgrCommand,
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

test("cancellation emits canonical setup errors and preserves execution failure precedence", async () => {
  const commandErrorSchema = JSON.parse(await readFile(new URL(
    "../packages/engineering-foundation/schemas/foundation-command-error/v1.schema.json",
    import.meta.url,
  ), "utf8"));
  const validateCommandError = new Ajv2020({ strict: true }).compile(commandErrorSchema);
  const phases = ["configuration", "catalog", "execution"];
  const cancellations = [
    { cancellation: "interrupt", exitCode: 130 },
    { cancellation: "terminate", exitCode: 143 },
  ];
  for (const phase of phases) {
    for (const { cancellation, exitCode } of cancellations) {
      const cancellationSource = createControlledQgrCancellationSource();
      let reportStarted;
      const started = new Promise((resolve) => { reportStarted = resolve; });
      const waitForCancellation = (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error(`${phase} cancelled`));
        }, { once: true });
      });
      const command = createQualityGateCommand({
        cancellationSource,
        catalogReader: {
          async read(_consumerRoot, signal) {
            if (phase === "catalog") {
              reportStarted();
              await waitForCancellation(signal);
            }
            return { scripts: { slow: "node slow.cjs" } };
          },
        },
        clock: { nowMs: () => 0 },
        executor: {
          async run({ signal }) {
            if (phase === "execution") {
              reportStarted();
              try {
                await waitForCancellation(signal);
              } catch (error) {
                throw new PackageScriptCancellationError({ cause: error });
              }
            }
            return { exitCode: 0, signal: null, stderr: "", stdout: "" };
          },
        },
        async policyLoader(_consumerRoot, _configPath, signal) {
          if (phase === "configuration") {
            reportStarted();
            await waitForCancellation(signal);
          }
          return policy();
        },
      });
      const captured = startCapturedQgrCommand(() => command({
        configPath: "architecture/foundation/quality-gates.yaml",
        consumerRoot: "/fixture",
        environment: {},
        format: "json",
        profileId: "verify",
      }));
      await started;
      cancellationSource.cancel(cancellation);
      const completed = await captured.result;
      assert.equal(completed.exitCode, exitCode, `${phase} ${cancellation}`);
      if (phase === "execution") {
        assert.equal(JSON.parse(completed.stdout).outcome, "cancelled");
      } else {
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
      }
    }
  }
  {
    const cancellationSource = createControlledQgrCancellationSource();
    let reportStarted;
    const started = new Promise((resolve) => { reportStarted = resolve; });
    const command = createQualityGateCommand({
      cancellationSource,
      catalogReader: {
        async read() {
          return { scripts: { slow: "node slow.cjs" } };
        },
      },
      clock: { nowMs: () => 0 },
      executor: {
        run({ signal }) {
          reportStarted();
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new Error("Managed process containment failed; wrapper remained alive."));
            }, { once: true });
          });
        },
      },
      async policyLoader() {
        return policy();
      },
    });
    const captured = startCapturedQgrCommand(() => command({
      configPath: "architecture/foundation/quality-gates.yaml",
      consumerRoot: "/fixture",
      environment: {},
      format: "json",
      profileId: "verify",
    }));
    await started;
    cancellationSource.cancel("terminate");
    const completed = await captured.result;
    const report = JSON.parse(completed.stdout);
    assert.equal(completed.exitCode, 1);
    assert.equal(report.outcome, "failed");
    assert.equal(report.tasks[0].outcome, "failed");
    assert.equal(report.tasks[0].exitCode, null);
    assert.match(report.tasks[0].failureTail, /wrapper remained alive\.$/u);
  }
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
