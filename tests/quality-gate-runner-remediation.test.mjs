import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createQualityGateCommand } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/gate-command.js";
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

test("SIGINT and SIGTERM provenance survives configuration, catalog, and execution phases", async () => {
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
              await waitForCancellation(signal);
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
        assert.equal(completed.stdout, "");
      }
    }
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
    await writeFile(fixture, `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000)"], {
  stdio: "inherit"
});
writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ pid: child.pid }) + "\\n", { flag: "wx" });
process.on("SIGTERM", () => {});
setInterval(() => {}, 60000);
`, "utf8");
    execution = startBoundedCli(fixture, [], {
      cleanupDeadlineMs: 5_000,
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
    const { error: watchdogError, result } = await completion;
    assert.equal(result, undefined, "stubborn fixture should reach the watchdog");
    assert.match(watchdogError.message, /watchdog expired/u);
    assert.deepEqual(await watchdogError.cleanup, []);
    assert.throws(
      () => process.kill(descendantPid, 0),
      (error) => error?.code === "ESRCH",
    );
    await cleanupSyntheticFixture({ executions: [execution], roots: [root] });
    execution = undefined;
    await assert.rejects(readFile(root, "utf8"), (error) => error?.code === "ENOENT");
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
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
  assert.match(nodeAdapterSource, /return spawnWindowsManagedProcess\(request\)/u);
  assert.match(nodeAdapterSource, /Windows Job Object wrapper did not exit after forced shutdown/u);
  assert.match(windowsAdapterSource, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
  assert.match(windowsAdapterSource, /TerminateRemainingProcessesAndWait\(job\)/u);
  assert.match(windowsAdapterSource, /while \(ActiveProcessCount\(job\) > 0\)/u);
});
