import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  NodeProcessRunner
} from "../packages/engineering-foundation/dist/local-mode/index.js";
import { ProcessTimeoutError } from "../packages/engineering-foundation/dist/process-execution/node-process-runner.js";
import {
  cleanUpWindowsManagedProcessLaunchFailure,
  spawnWindowsManagedProcess,
  waitForWindowsManagedProcessContainment
} from "../packages/engineering-foundation/dist/process-execution/windows-managed-process.js";

const NEVER_EXITING_PROCESS_PATH = fileURLToPath(
  new URL("./fixtures/never-exiting-process.mjs", import.meta.url)
);
const PARENT_EXITS_BEFORE_CHILD_PATH = fileURLToPath(
  new URL("./fixtures/parent-exits-before-child.mjs", import.meta.url)
);
const POLL_INTERVAL_MS = 25;
const READY_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 2_000;
const EXIT_TIMEOUT_MS = 3_000;
const PROCESS_DEADLINE_MS = process.platform === "win32" ? 45_000 : 1_000;
const CANCELLATION_DEADLINE_MS = process.platform === "win32" ? 45_000 : 5_000;
const TEST_TIMEOUT_MS = process.platform === "win32" ? 65_000 : 10_000;
const WINDOWS_CONTROL_ROOT_PREFIX = "agent-teams-foundation-process-";

async function removeTestRoot(root) {
  await rm(root, {
    force: true,
    maxRetries: process.platform === "win32" ? 50 : 0,
    recursive: true,
    retryDelay: 100
  });
}

async function windowsControlRoots() {
  return new Set((await readdir(tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(WINDOWS_CONTROL_ROOT_PREFIX))
    .map((entry) => entry.name));
}

async function assertNoNewWindowsControlRoots(previousRoots) {
  const currentRoots = await windowsControlRoots();
  assert.deepEqual(
    [...currentRoots].filter((root) => !previousRoots.has(root)),
    []
  );
}

async function waitForPidFile(path) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      await delay(POLL_INTERVAL_MS);
    }
  }
  throw new Error("Never-exiting process did not report its process tree before its deadline.");
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function waitForProcessTreeExit(processes) {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (processes.every((pid) => !isRunning(pid))) {
      return;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Process tree still running: ${processes.join(", ")}`);
}

function forceStop(processes) {
  for (const pid of processes) {
    if (!isRunning(pid)) {
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process exited between the liveness check and the kill request.
    }
  }
}

test("terminates a never-exiting process tree when its deadline expires", { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-process-runner-"));
  const pidPath = join(root, "pids.json");
  let processes = [];
  try {
    const runner = new NodeProcessRunner();
    const execution = runner.run({
      command: process.execPath,
      args: [NEVER_EXITING_PROCESS_PATH, pidPath],
      cwd: root,
      timeoutMs: PROCESS_DEADLINE_MS
    });
    const rejected = assert.rejects(execution, (error) => {
      assert.equal(error instanceof ProcessTimeoutError, true);
      assert.equal(error.timeoutMs, PROCESS_DEADLINE_MS);
      assert.equal(error?.code, "PROCESS_FAILED");
      assert.match(error.message, new RegExp(`timed out after ${PROCESS_DEADLINE_MS}ms`, "u"));
      return true;
    });
    const reported = await waitForPidFile(pidPath);
    processes = [reported.parent, reported.child];
    await rejected;
    await waitForProcessTreeExit(processes);
  } finally {
    forceStop(processes);
    await removeTestRoot(root);
  }
});

test("rejects an unsupported deadline before spawning the command", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-process-runner-invalid-timeout-"));
  const markerPath = join(root, "spawned.txt");
  try {
    const runner = new NodeProcessRunner();
    await assert.rejects(
      runner.run({
        command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned')`],
        cwd: root,
        timeoutMs: Number.MAX_SAFE_INTEGER
      }),
      /no greater than 2147483647/u
    );
    await delay(50);
    await assert.rejects(readFile(markerPath, "utf8"), (error) => error?.code === "ENOENT");
  } finally {
    await removeTestRoot(root);
  }
});

test("preserves no-deadline behavior when timeoutMs is omitted", async () => {
  const runner = new NodeProcessRunner();
  const result = await runner.run({
    command: process.execPath,
    args: ["-e", "setTimeout(() => process.stdout.write('done'), 25)"],
    cwd: process.cwd()
  });
  assert.equal(result.stdout, "done");
  assert.equal(result.stderr, "");
});

test("terminates a never-exiting process tree when cancelled", { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-process-runner-"));
  const pidPath = join(root, "pids.json");
  let processes = [];
  try {
    const controller = new AbortController();
    const runner = new NodeProcessRunner();
    const execution = runner.run({
      command: process.execPath,
      args: [NEVER_EXITING_PROCESS_PATH, pidPath],
      cwd: root,
      timeoutMs: CANCELLATION_DEADLINE_MS,
      signal: controller.signal
    });
    const rejected = assert.rejects(execution, (error) => {
      assert.equal(error?.code, "PROCESS_FAILED");
      assert.match(error.message, /was cancelled/u);
      return true;
    });
    const reported = await waitForPidFile(pidPath);
    processes = [reported.parent, reported.child];
    controller.abort(new Error("test cancellation"));

    await rejected;
    await waitForProcessTreeExit(processes);
  } finally {
    forceStop(processes);
    await removeTestRoot(root);
  }
});

test("a launch failure observed during immediate cancellation outranks cancellation", async () => {
  const controller = new AbortController();
  const runner = new NodeProcessRunner();
  const execution = runner.run({
    command: `foundation-nonexistent-command-${process.pid}`,
    args: [],
    cwd: process.cwd(),
    signal: controller.signal
  });

  controller.abort("immediate test cancellation");

  await assert.rejects(execution, (error) => {
    assert.equal(error?.code, "PROCESS_FAILED");
    assert.match(error.message, /could not be started/u);
    assert.doesNotMatch(error.message, /was cancelled/u);
    return true;
  });
});

test("terminates descendants after their direct parent exits", { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-process-runner-"));
  const pidPath = join(root, "pids.json");
  let processes = [];
  try {
    const runner = new NodeProcessRunner();
    const execution = runner.run({
      command: process.execPath,
      args: [PARENT_EXITS_BEFORE_CHILD_PATH, pidPath],
      cwd: root,
      timeoutMs: process.platform === "win32" ? 5_000 : 1_000
    });
    const reported = await waitForPidFile(pidPath);
    processes = [reported.parent, reported.child];
    await execution;
    await waitForProcessTreeExit(processes);
  } finally {
    forceStop(processes);
    await removeTestRoot(root);
  }
});

test(
  "contains descendants of a non-Node Windows command",
  { skip: process.platform !== "win32", timeout: TEST_TIMEOUT_MS },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation-windows-job-"));
    const pidPath = join(root, "pids.json");
    const escapedPidPath = pidPath.replaceAll("'", "''");
    const script = [
      "$child = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/s','/c','ping -n 60 127.0.0.1 > nul') -PassThru",
      "$json = @{ parent = $PID; child = $child.Id } | ConvertTo-Json -Compress",
      `$encoding = New-Object System.Text.UTF8Encoding($false); [IO.File]::WriteAllText('${escapedPidPath}', $json, $encoding)`
    ].join("; ");
    let processes = [];
    try {
      const runner = new NodeProcessRunner();
      const execution = runner.run({
        command: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        cwd: root,
        timeoutMs: 5_000
      });
      const reported = await waitForPidFile(pidPath);
      processes = [reported.parent, reported.child];
      await execution;
      await waitForProcessTreeExit(processes);
    } finally {
      forceStop(processes);
      await removeTestRoot(root);
    }
  }
);

test("cleans Windows control artifacts after synchronous PowerShell launch failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-windows-sync-launch-failure-"));
  const previousControls = await windowsControlRoots();
  try {
    assert.throws(
      () => spawnWindowsManagedProcess({
        command: process.execPath,
        args: ["-e", "process.exit()"],
        cwd: root,
        environment: { ...process.env, FOUNDATION_INVALID_ENVIRONMENT: "invalid\0value" }
      }),
      (error) => error?.code === "ERR_INVALID_ARG_VALUE"
    );
    await assertNoNewWindowsControlRoots(previousControls);
  } finally {
    await removeTestRoot(root);
  }
});

test("cleans Windows control artifacts idempotently after an asynchronous launch error", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-windows-async-launch-failure-"));
  const previousControls = await windowsControlRoots();
  try {
    const child = spawnWindowsManagedProcess({
      command: process.execPath,
      args: ["-e", "process.exit()"],
      cwd: join(root, "missing-working-directory")
    });
    const closed = new Promise((resolve) => {
      child.once("close", resolve);
    });
    const [launchError] = await once(child, "error");
    assert.equal(launchError.code, "ENOENT");
    assert.equal(child.pid, undefined);

    cleanUpWindowsManagedProcessLaunchFailure(child);
    cleanUpWindowsManagedProcessLaunchFailure(child);
    await closed;
    await assertNoNewWindowsControlRoots(previousControls);
  } finally {
    await removeTestRoot(root);
  }
});

test(
  "NodeProcessRunner cleans Windows controls when PowerShell launch has no pid",
  { skip: process.platform !== "win32", timeout: TEST_TIMEOUT_MS },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation-windows-runner-launch-failure-"));
    const previousControls = await windowsControlRoots();
    try {
      const runner = new NodeProcessRunner();
      await assert.rejects(
        runner.run({
          command: process.execPath,
          args: ["-e", "process.exit()"],
          cwd: join(root, "missing-working-directory")
        }),
        /could not be started/u
      );
      await assertNoNewWindowsControlRoots(previousControls);
    } finally {
      await removeTestRoot(root);
    }
  }
);

test(
  "removes Windows control artifacts after awaited forced containment cleanup",
  { skip: process.platform !== "win32", timeout: TEST_TIMEOUT_MS },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation-windows-containment-timeout-"));
    const previousControls = await windowsControlRoots();
    try {
      const child = spawnWindowsManagedProcess({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 1000)"],
        cwd: root
      });
      const closed = new Promise((resolve) => {
        child.once("close", resolve);
      });

      await assert.rejects(
        waitForWindowsManagedProcessContainment(child, 1),
        /did not confirm containment within 1 ms/u
      );
      await assertNoNewWindowsControlRoots(previousControls);
      await closed;
      await assertNoNewWindowsControlRoots(previousControls);
    } finally {
      await removeTestRoot(root);
    }
  }
);

test(
  "round-trips real Windows argument and working-directory serialization",
  { skip: process.platform !== "win32", timeout: TEST_TIMEOUT_MS },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation Windows path & ' [雪]-"));
    const expectedArgs = [
      "",
      "plain",
      "two words",
      'embedded"quote',
      "\\",
      "trailing\\",
      'slashes\\\\before"quote',
      "PowerShell $&;|<>(){}[]`^",
      "雪-😀"
    ];
    try {
      const runner = new NodeProcessRunner();
      const result = await runner.run({
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd() }))",
          ...expectedArgs
        ],
        cwd: root,
        timeoutMs: 45_000
      });
      assert.deepEqual(JSON.parse(result.stdout), {
        args: expectedArgs,
        cwd: root
      });
    } finally {
      await removeTestRoot(root);
    }
  }
);

test("Windows cancellation protocol proves containment across Job assignment", async () => {
  const [nodeAdapterSource, windowsManagedProcessSource] = await Promise.all([
    readFile(join(
      process.cwd(),
      "packages/engineering-foundation/src/process-execution/node-process-runner.ts"
    ), "utf8"),
    readFile(join(
      process.cwd(),
      "packages/engineering-foundation/assets/windows-managed-process/WindowsManagedProcess.cs"
    ), "utf8")
  ]);

  const updateJobList = windowsManagedProcessSource.indexOf(
    "if (!UpdateProcThreadAttribute("
  );
  const jobListAttribute = windowsManagedProcessSource.indexOf(
    "PROC_THREAD_ATTRIBUTE_JOB_LIST,",
    updateJobList
  );
  const createProcess = windowsManagedProcessSource.indexOf(
    "if (!CreateProcess(",
    updateJobList
  );
  const preResumeCancellation = windowsManagedProcessSource.indexOf(
    "if (CancelAssignedIfRequested(",
    createProcess
  );
  const resumeThread = windowsManagedProcessSource.indexOf(
    "if (ResumeThread(process.hThread)",
    preResumeCancellation
  );
  assert.ok(updateJobList >= 0);
  assert.ok(jobListAttribute >= 0);
  assert.ok(createProcess >= 0);
  assert.ok(preResumeCancellation >= 0);
  assert.ok(resumeThread >= 0);
  assert.ok(updateJobList < jobListAttribute);
  assert.ok(jobListAttribute < createProcess);
  assert.ok(updateJobList < createProcess);
  assert.ok(createProcess < preResumeCancellation);
  assert.ok(preResumeCancellation < resumeThread);

  const assignedCancellationHelper = windowsManagedProcessSource.indexOf(
    "private static bool CancelAssignedIfRequested"
  );
  const terminateAssignedJob = windowsManagedProcessSource.indexOf(
    "TerminateRemainingProcessesAndWait(job);",
    assignedCancellationHelper
  );
  const confirmAssignedContainment = windowsManagedProcessSource.indexOf(
    "ConfirmContainment(confirmationPath);",
    assignedCancellationHelper
  );
  assert.ok(assignedCancellationHelper < terminateAssignedJob);
  assert.ok(terminateAssignedJob < confirmAssignedContainment);

  const assignedJobTermination = windowsManagedProcessSource.slice(
    windowsManagedProcessSource.indexOf("private static void TerminateRemainingProcessesAndWait"),
    windowsManagedProcessSource.indexOf("private static void ConfirmContainment")
  );
  assert.match(assignedJobTermination, /TerminateJobObject\(job, 1\)/u);
  assert.match(assignedJobTermination, /while \(ActiveProcessCount\(job\) > 0\)/u);

  const requestTermination = nodeAdapterSource.indexOf(
    "await requestWindowsManagedProcessTermination(child);"
  );
  const forceWrapperExit = nodeAdapterSource.indexOf(
    'child.kill("SIGKILL");',
    requestTermination
  );
  assert.ok(requestTermination >= 0);
  assert.ok(requestTermination < forceWrapperExit);
  assert.match(nodeAdapterSource, /await waitForWindowsManagedProcessContainment\(child\)/u);
  assert.match(windowsManagedProcessSource, /File\.Move\(temporaryPath, confirmationPath\)/u);
});

test("rejects output beyond the bounded capture limit", { timeout: TEST_TIMEOUT_MS }, async () => {
  const runner = new NodeProcessRunner();
  await assert.rejects(
    runner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1))"],
      cwd: process.cwd(),
      timeoutMs: 5_000
    }),
    (error) => {
      assert.equal(error?.code, "PROCESS_FAILED");
      assert.match(error.message, /exceeded the stdout output limit/u);
      return true;
    }
  );
});

test("an output-limit failure observed during real cancellation outranks cancellation", {
  skip: process.platform === "win32",
  timeout: TEST_TIMEOUT_MS
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-process-runner-cancel-output-"));
  const readyPath = join(root, "ready.txt");
  try {
    const controller = new AbortController();
    const runner = new NodeProcessRunner();
    const execution = runner.run({
      command: process.execPath,
      args: ["-e", `
        const { writeFileSync } = require("node:fs");
        process.once("SIGTERM", () => {
          process.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1));
          process.exitCode = 23;
        });
        writeFileSync(${JSON.stringify(readyPath)}, "ready");
        setInterval(() => {}, 60_000);
      `],
      cwd: root,
      signal: controller.signal,
      timeoutMs: 5_000
    });
    const readinessDeadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < readinessDeadline) {
      try {
        if (await readFile(readyPath, "utf8") === "ready") {
          break;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
      await delay(POLL_INTERVAL_MS);
    }
    assert.equal(await readFile(readyPath, "utf8"), "ready");
    controller.abort("test cancellation");
    await assert.rejects(execution, (error) => {
      assert.equal(error?.code, "PROCESS_FAILED");
      assert.match(error.message, /exceeded the stdout output limit/u);
      assert.doesNotMatch(error.message, /was cancelled/u);
      return true;
    });
  } finally {
    await removeTestRoot(root);
  }
});

test("a nonzero completion observed during real cancellation outranks cancellation", {
  skip: process.platform === "win32",
  timeout: TEST_TIMEOUT_MS
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-process-runner-cancel-nonzero-"));
  const readyPath = join(root, "ready.txt");
  try {
    const controller = new AbortController();
    const runner = new NodeProcessRunner();
    const execution = runner.run({
      command: process.execPath,
      args: ["-e", `
        const { writeFileSync } = require("node:fs");
        process.once("SIGTERM", () => process.exit(23));
        writeFileSync(${JSON.stringify(readyPath)}, "ready");
        setInterval(() => {}, 60_000);
      `],
      cwd: root,
      signal: controller.signal,
      timeoutMs: 5_000
    });
    const readinessDeadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < readinessDeadline) {
      try {
        if (await readFile(readyPath, "utf8") === "ready") {
          break;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
      await delay(POLL_INTERVAL_MS);
    }
    assert.equal(await readFile(readyPath, "utf8"), "ready");
    controller.abort("test cancellation");
    await assert.rejects(execution, (error) => {
      assert.equal(error?.code, "PROCESS_FAILED");
      assert.match(error.message, /exit code 23/u);
      assert.doesNotMatch(error.message, /was cancelled/u);
      return true;
    });
  } finally {
    await removeTestRoot(root);
  }
});
