import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  requestWindowsManagedProcessTermination,
  spawnWindowsManagedProcess,
  waitForWindowsManagedProcessContainment
} from "../packages/engineering-foundation/dist/process-execution/windows-managed-process.js";

const windowsTest = process.platform === "win32" ? test : test.skip;

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
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (!processExists(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`process ${String(pid)} did not exit within 5000 ms`);
}

windowsTest(
  "packaged helper compiles and preserves a long Windows path and argument vector",
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

windowsTest("rejects a native Windows command line that cannot fit", () => {
  assert.throws(
    () => spawnWindowsManagedProcess({
      command: process.execPath,
      args: ["x".repeat(32_767)],
      cwd: process.cwd()
    }),
    /exceeds 32766 characters/u
  );
});

windowsTest("terminates and awaits every descendant in the assigned Job Object", async () => {
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
    let descendant;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        descendant = JSON.parse(await readFile(descendantPath, "utf8"));
        break;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.notEqual(descendant, undefined, "managed parent did not report its descendant");

    await requestWindowsManagedProcessTermination(child);
    if (child.exitCode === null && child.signalCode === null) {
      await once(child, "exit");
    }
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

windowsTest("forces and awaits the wrapper after containment confirmation times out", async () => {
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
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        ({ pid: managedPid } = JSON.parse(await readFile(startedPath, "utf8")));
        break;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.notEqual(managedPid, undefined, "managed command did not report its pid");

    await assert.rejects(
      waitForWindowsManagedProcessContainment(child, 20),
      /did not confirm containment within 20 ms/u
    );
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    await waitForProcessExit(managedPid);
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
