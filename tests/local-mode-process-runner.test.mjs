import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  NodeProcessRunner
} from "../packages/engineering-foundation/dist/local-mode/index.js";

const NEVER_EXITING_PROCESS_PATH = fileURLToPath(
  new URL("./fixtures/never-exiting-process.mjs", import.meta.url)
);
const PARENT_EXITS_BEFORE_CHILD_PATH = fileURLToPath(
  new URL("./fixtures/parent-exits-before-child.mjs", import.meta.url)
);
const POLL_INTERVAL_MS = 25;
const READY_TIMEOUT_MS = 2_000;
const EXIT_TIMEOUT_MS = 3_000;

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

test("terminates a never-exiting process tree when its deadline expires", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-process-runner-"));
  const pidPath = join(root, "pids.json");
  let processes = [];
  try {
    const runner = new NodeProcessRunner();
    const execution = runner.run({
      command: process.execPath,
      args: [NEVER_EXITING_PROCESS_PATH, pidPath],
      cwd: root,
      timeoutMs: 1_000
    });
    const rejected = assert.rejects(execution, (error) => {
      assert.equal(error?.code, "PROCESS_FAILED");
      assert.match(error.message, /timed out after 1000ms/u);
      return true;
    });
    const reported = await waitForPidFile(pidPath);
    processes = [reported.parent, reported.child];
    await rejected;
    await waitForProcessTreeExit(processes);
  } finally {
    forceStop(processes);
    await rm(root, { force: true, recursive: true });
  }
});

test("terminates a never-exiting process tree when cancelled", { timeout: 10_000 }, async () => {
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
      timeoutMs: 5_000,
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
    await rm(root, { force: true, recursive: true });
  }
});

test("terminates descendants after their direct parent exits", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-process-runner-"));
  const pidPath = join(root, "pids.json");
  let processes = [];
  try {
    const runner = new NodeProcessRunner();
    const execution = runner.run({
      command: process.execPath,
      args: [PARENT_EXITS_BEFORE_CHILD_PATH, pidPath],
      cwd: root,
      timeoutMs: 1_000
    });
    const rejected = assert.rejects(execution, (error) => {
      assert.equal(error?.code, "PROCESS_FAILED");
      assert.match(error.message, /timed out after 1000ms/u);
      return true;
    });
    const reported = await waitForPidFile(pidPath);
    processes = [reported.parent, reported.child];
    await rejected;
    await waitForProcessTreeExit(processes);
  } finally {
    forceStop(processes);
    await rm(root, { force: true, recursive: true });
  }
});
