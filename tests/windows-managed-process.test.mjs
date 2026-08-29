import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  requestWindowsManagedProcessTermination,
  spawnWindowsManagedProcess as spawnWindowsManagedProcessWithoutEnvironment,
  waitForWindowsManagedProcessContainment
} from "../packages/engineering-foundation/dist/process-execution/windows-managed-process.js";

function spawnWindowsManagedProcess(request) {
  return spawnWindowsManagedProcessWithoutEnvironment({
    environment: process.env,
    ...request
  });
}

const windowsTest = process.platform === "win32" ? test : test.skip;
const TEST_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 10;
const WINDOWS_CONTROL_ROOT_PREFIX = "agent-teams-foundation-process-";

async function windowsControlRoots() {
  return new Set((await readdir(tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(WINDOWS_CONTROL_ROOT_PREFIX))
    .map((entry) => entry.name));
}

async function waitForNewWindowsControlRoot(previousRoots) {
  const deadline = performance.now() + READY_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const currentRoots = await windowsControlRoots();
    const added = [...currentRoots].filter((root) => !previousRoots.has(root));
    if (added.length === 1) {
      return join(tmpdir(), added[0]);
    }
    assert.ok(added.length < 2, `multiple Windows control roots appeared: ${added.join(", ")}`);
    await delay(POLL_INTERVAL_MS);
  }
  assert.fail("Windows managed process did not create its control root before the deadline");
}

async function assertNoNewWindowsControlRoots(previousRoots) {
  const currentRoots = await windowsControlRoots();
  assert.deepEqual(
    [...currentRoots].filter((root) => !previousRoots.has(root)),
    []
  );
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForProcessExit(pid) {
  const deadline = performance.now() + READY_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (!processExists(pid)) {
      return;
    }
    await delay(POLL_INTERVAL_MS);
  }
  assert.fail(`process ${String(pid)} did not exit within ${String(READY_TIMEOUT_MS)} ms`);
}

async function waitForJsonFile(path) {
  const deadline = performance.now() + READY_TIMEOUT_MS;
  while (performance.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      await delay(POLL_INTERVAL_MS);
    }
  }
  assert.fail(`managed process did not write ${path} before the deadline`);
}

async function writeNewFileExclusive(path, contents) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
}

windowsTest(
  "packaged helper compiles and preserves a long Windows path and argument vector",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation managed Windows "));
    const cwd = join(root, "working directory");
    const commandPath = join(root, "node executable.exe");
    const outputPath = join(root, "captured arguments.json");
    await mkdir(cwd);
    await copyFile(process.execPath, commandPath);
    const expectedArguments = [
      "",
      "plain",
      "space separated",
      String.raw`trailing\\`,
      String.raw`embedded\"quote`,
      "unicode-雪",
      "x".repeat(20_000)
    ];
    const source = [
      'const { writeFileSync } = require("node:fs");',
      "writeFileSync(process.argv[1], JSON.stringify({",
      "  cwd: process.cwd(), args: process.argv.slice(2)",
      '}), "utf8");'
    ].join("\n");

    try {
      const child = spawnWindowsManagedProcess({
        command: commandPath,
        args: ["-e", source, outputPath, ...expectedArguments],
        cwd
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      const [exitCode] = await once(child, "exit");
      assert.equal(exitCode, 0, stderr);
      await waitForWindowsManagedProcessContainment(child);

      const captured = JSON.parse(await readFile(outputPath, "utf8"));
      assert.equal(captured.cwd, cwd);
      assert.deepEqual(captured.args, expectedArguments);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
);

windowsTest("rejects a native Windows command line that cannot fit", { timeout: TEST_TIMEOUT_MS }, () => {
  assert.throws(
    () => spawnWindowsManagedProcess({
      command: process.execPath,
      args: ["x".repeat(32_767)],
      cwd: process.cwd()
    }),
    /exceeds 32766 characters/u
  );
});

windowsTest("rejects a non-absolute SystemRoot without leaking controls", { timeout: TEST_TIMEOUT_MS }, async () => {
  const previousRoots = await windowsControlRoots();
  const originalSystemRoot = process.env.SystemRoot;
  try {
    process.env.SystemRoot = "relative-system-root";
    assert.throws(
      () => spawnWindowsManagedProcess({
        command: process.execPath,
        args: [],
        cwd: process.cwd()
      }),
      /SystemRoot must be an absolute Windows path/u
    );
    await assertNoNewWindowsControlRoots(previousRoots);
  } finally {
    if (originalSystemRoot === undefined) {
      delete process.env.SystemRoot;
    } else {
      process.env.SystemRoot = originalSystemRoot;
    }
  }
});

windowsTest("uses absolute SystemRoot PowerShell despite cwd and early PATH decoys", { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation Windows PowerShell resolution "));
  const cwd = join(root, "cwd");
  const earlyPath = join(root, "early-path");
  const outputPath = join(root, "managed-command-ran.txt");
  await mkdir(cwd);
  await mkdir(earlyPath);
  await copyFile(process.execPath, join(cwd, "powershell.exe"));
  await copyFile(process.execPath, join(earlyPath, "powershell.exe"));
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "path") {
      delete environment[key];
    }
  }
  environment.Path = `${earlyPath};${process.env.Path ?? process.env.PATH ?? ""}`;

  try {
    const child = spawnWindowsManagedProcess({
      command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, 'managed')`],
      cwd,
      environment
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0, stderr);
    await waitForWindowsManagedProcessContainment(child);
    assert.equal(await readFile(outputPath, "utf8"), "managed");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

windowsTest("preserves a real nonzero managed-process result", { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation Windows nonzero exit "));
  try {
    const child = spawnWindowsManagedProcess({
      command: process.execPath,
      args: ["-e", "process.exit(23)"],
      cwd: root
    });
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 23);
    await waitForWindowsManagedProcessContainment(child);
    assert.equal(child.exitCode, 23);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

windowsTest("terminates and awaits every descendant in the assigned Job Object", { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation Windows job "));
  const descendantPath = join(root, "descendant.json");
  let child;
  const source = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
    '  { stdio: "ignore", windowsHide: true });',
    'writeFileSync(process.argv[1], JSON.stringify({ pid: descendant.pid }), "utf8");',
    "setInterval(() => {}, 1000);"
  ].join("\n");

  try {
    child = spawnWindowsManagedProcess({
      command: process.execPath,
      args: ["-e", source, descendantPath],
      cwd: root
    });
    const descendant = await waitForJsonFile(descendantPath);

    await requestWindowsManagedProcessTermination(child);
    if (child.exitCode === null && child.signalCode === null) {
      await once(child, "exit");
    }
    assert.equal(child.exitCode, 0);
    assert.throws(
      () => process.kill(descendant.pid, 0),
      (error) => error instanceof Error && "code" in error && error.code === "ESRCH"
    );
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      try {
        await requestWindowsManagedProcessTermination(child);
      } catch {
        child.kill("SIGKILL");
      }
    }
    await rm(root, { force: true, recursive: true });
  }
});

windowsTest("marker write failure forces wrapper termination without leaking controls", { timeout: TEST_TIMEOUT_MS }, async () => {
  const previousRoots = await windowsControlRoots();
  const root = await mkdtemp(join(tmpdir(), "foundation Windows marker failure "));
  const startedPath = join(root, "started.json");
  let child;
  let managedPid;
  try {
    child = spawnWindowsManagedProcess({
      command: process.execPath,
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(startedPath)}, JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000)`
      ],
      cwd: root
    });
    const controlRoot = await waitForNewWindowsControlRoot(previousRoots);
    ({ pid: managedPid } = await waitForJsonFile(startedPath));
    await mkdir(join(controlRoot, "cancel"));
    await assert.rejects(
      requestWindowsManagedProcessTermination(child),
      (error) => error instanceof Error &&
        "code" in error &&
        (error.code === "EISDIR" || error.code === "EPERM")
    );
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    await waitForProcessExit(managedPid);
    await assertNoNewWindowsControlRoots(previousRoots);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
    if (managedPid !== undefined && processExists(managedPid)) {
      process.kill(managedPid, "SIGKILL");
    }
    await rm(root, { force: true, recursive: true });
  }
});

for (const confirmationFailure of ["invalid", "read"]) {
  windowsTest(`confirmation ${confirmationFailure} failure forces wrapper termination without leaking controls`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const previousRoots = await windowsControlRoots();
    const root = await mkdtemp(join(tmpdir(), `foundation Windows ${confirmationFailure} failure `));
    const startedPath = join(root, "started.json");
    let child;
    let managedPid;
    try {
      child = spawnWindowsManagedProcess({
        command: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(startedPath)}, JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000)`
        ],
        cwd: root
      });
      const controlRoot = await waitForNewWindowsControlRoot(previousRoots);
      ({ pid: managedPid } = await waitForJsonFile(startedPath));
      if (confirmationFailure === "invalid") {
        await writeNewFileExclusive(join(controlRoot, "contained"), "INVALID");
      } else {
        await mkdir(join(controlRoot, "contained"));
      }
      await assert.rejects(
        waitForWindowsManagedProcessContainment(child),
        confirmationFailure === "invalid" ? /invalid containment confirmation/u : /EISDIR|illegal operation/u
      );
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      await waitForProcessExit(managedPid);
      await assertNoNewWindowsControlRoots(previousRoots);
    } finally {
      if (child?.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
      if (managedPid !== undefined && processExists(managedPid)) {
        process.kill(managedPid, "SIGKILL");
      }
      await rm(root, { force: true, recursive: true });
    }
  });
}

windowsTest("retains controls and both errors when forced wrapper cleanup fails", { timeout: TEST_TIMEOUT_MS }, async () => {
  const previousRoots = await windowsControlRoots();
  const root = await mkdtemp(join(tmpdir(), "foundation Windows cleanup failure "));
  const startedPath = join(root, "started.json");
  const cleanupError = new Error("synthetic wrapper termination failure");
  let child;
  let controlRoot;
  let managedPid;
  let realKill;
  try {
    child = spawnWindowsManagedProcess({
      command: process.execPath,
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(startedPath)}, JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000)`
      ],
      cwd: root
    });
    controlRoot = await waitForNewWindowsControlRoot(previousRoots);
    ({ pid: managedPid } = await waitForJsonFile(startedPath));
    await writeNewFileExclusive(join(controlRoot, "contained"), "INVALID");
    realKill = child.kill.bind(child);
    child.kill = () => {
      throw cleanupError;
    };
    await assert.rejects(
      waitForWindowsManagedProcessContainment(child),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(String(error.errors[0]), /invalid containment confirmation/u);
        assert.equal(error.errors[1], cleanupError);
        assert.match(String(error.errors[2]), /did not exit within 5000 ms/u);
        assert.equal(error.cause, error.errors[2]);
        return true;
      }
    );
    assert.notEqual(child.pid, undefined);
    assert.ok(processExists(child.pid));
    assert.ok((await windowsControlRoots()).has(controlRoot.slice(tmpdir().length + 1)));
  } finally {
    if (child !== undefined && realKill !== undefined) {
      child.kill = realKill;
    }
    if (child?.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
    if (managedPid !== undefined) {
      await waitForProcessExit(managedPid);
    }
    await assertNoNewWindowsControlRoots(previousRoots);
    await rm(root, { force: true, recursive: true });
  }
});

windowsTest("does not fabricate cleanup failure when kill returns false as the wrapper exits", { timeout: TEST_TIMEOUT_MS }, async () => {
  const previousRoots = await windowsControlRoots();
  const root = await mkdtemp(join(tmpdir(), "foundation Windows false kill race "));
  const startedPath = join(root, "started.json");
  let child;
  let managedPid;
  let realKill;
  try {
    child = spawnWindowsManagedProcess({
      command: process.execPath,
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(startedPath)}, JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000)`
      ],
      cwd: root
    });
    const controlRoot = await waitForNewWindowsControlRoot(previousRoots);
    ({ pid: managedPid } = await waitForJsonFile(startedPath));
    await writeNewFileExclusive(join(controlRoot, "contained"), "INVALID");
    realKill = child.kill.bind(child);
    child.kill = (signal) => {
      assert.equal(realKill(signal), true);
      return false;
    };
    await assert.rejects(
      waitForWindowsManagedProcessContainment(child),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof AggregateError, false);
        assert.match(error.message, /invalid containment confirmation/u);
        assert.doesNotMatch(error.message, /could not be terminated/u);
        return true;
      }
    );
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    await waitForProcessExit(managedPid);
    await assertNoNewWindowsControlRoots(previousRoots);
  } finally {
    if (child !== undefined && realKill !== undefined) {
      child.kill = realKill;
    }
    if (child?.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
    if (managedPid !== undefined && processExists(managedPid)) {
      process.kill(managedPid, "SIGKILL");
    }
    await rm(root, { force: true, recursive: true });
  }
});

windowsTest("forces and awaits the wrapper after containment confirmation times out", { timeout: TEST_TIMEOUT_MS }, async () => {
  const previousRoots = await windowsControlRoots();
  const root = await mkdtemp(join(tmpdir(), "foundation Windows timeout "));
  const startedPath = join(root, "started.json");
  let child;
  let managedPid;
  const source = [
    'const { writeFileSync } = require("node:fs");',
    'writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid }), "utf8");',
    "setInterval(() => {}, 1000);"
  ].join("\n");

  try {
    child = spawnWindowsManagedProcess({
      command: process.execPath,
      args: ["-e", source, startedPath],
      cwd: root
    });
    ({ pid: managedPid } = await waitForJsonFile(startedPath));

    await assert.rejects(
      waitForWindowsManagedProcessContainment(child, 20),
      /did not confirm containment within 20 ms/u
    );
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    await waitForProcessExit(managedPid);
    await assertNoNewWindowsControlRoots(previousRoots);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
    if (managedPid !== undefined && processExists(managedPid)) {
      process.kill(managedPid, "SIGKILL");
    }
    await rm(root, { force: true, recursive: true });
  }
});
