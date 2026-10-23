import { registerWindowsCleanupDiagnosticCases } from "./windows-cleanup-diagnostic-cases.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  requestWindowsManagedProcessTermination,
  spawnWindowsManagedProcess as spawnWindowsManagedProcessWithoutEnvironment,
  waitForWindowsManagedProcessContainment,
} from "../packages/engineering-foundation/dist/process-execution/windows-managed-process.js";

function spawnWindowsManagedProcess(request) {
  return spawnWindowsManagedProcessWithoutEnvironment({
    environment: process.env,
    ...request,
  });
}

const windowsTest = process.platform === "win32" ? test : test.skip;
const TEST_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 10;
const WINDOWS_CONTROL_ROOT_PREFIX = "agent-teams-foundation-process-";

registerWindowsCleanupDiagnosticCases();

async function windowsControlRoots() {
  return new Set(
    (await readdir(tmpdir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(WINDOWS_CONTROL_ROOT_PREFIX))
      .map((entry) => entry.name),
  );
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
    [],
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

// Cooperative TEST readiness only; corrupt production-control fixtures stay raw.
function publishReadyJson(path, value, io = { writeFileSync, renameSync }) {
  const temporary = `${path}.pending`;
  io.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", encoding: "utf8", mode: 0o600 });
  io.renameSync(temporary, path);
}
const readyJsonPublisher = `const { writeFileSync, renameSync } = require("node:fs");\n${publishReadyJson.toString()}`;
const readyPidSource = `${readyJsonPublisher}\npublishReadyJson(process.argv[1], { pid: process.pid }); setInterval(() => {}, 1000)`;

test("publishes complete cooperative readiness JSON before exposing its final path", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation ready publication ")),
    path = join(root, "ready.json"),
    expected = { pid: process.pid };
  try {
    let renames = 0;
    publishReadyJson(path, expected, {
      writeFileSync,
      renameSync: (source, target) => {
        renames++;
        assert.equal(source, `${path}.pending`);
        assert.equal(target, path);
        assert.deepEqual(JSON.parse(readFileSync(source, "utf8")), expected);
        assert.throws(() => readFileSync(target), { code: "ENOENT" });
        renameSync(source, target);
      },
    });
    assert.equal(renames, 1);
    assert.deepEqual(await waitForJsonFile(path), expected);
    await rm(path);
    const writer = spawnSync(
      process.execPath,
      [
        "--eval",
        `${readyJsonPublisher}\npublishReadyJson(process.argv[1], ${JSON.stringify(expected)});`,
        path,
      ],
      { timeout: 10_000, encoding: "utf8" },
    );
    assert.equal(writer.status, 0, writer.stderr);
    assert.deepEqual(await waitForJsonFile(path), expected);
    await writeFile(path, "");
    await assert.rejects(waitForJsonFile(path), SyntaxError);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

async function writeNewFileExclusive(path, contents) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
}

windowsTest(
  "PowerShell bootstrap compiles its helper outside the deep installed asset path without unqualified cmdlet lookup",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation deep installed helper "));
    const bootstrapName = "bootstrap.ps1";
    const helperName = "WindowsManagedProcess.cs";
    let segmentLength = 1;
    while (join(root, "x".repeat(segmentLength), bootstrapName).length < 250) {
      segmentLength += 1;
    }
    assert.ok(segmentLength <= 240);
    const helperRoot = join(root, "x".repeat(segmentLength));
    const bootstrapPath = join(helperRoot, "bootstrap.ps1");
    const helperPath = join(helperRoot, helperName);
    assert.ok(bootstrapPath.length >= 250 && bootstrapPath.length < 260);
    assert.ok(helperPath.length > 260);
    try {
      await mkdir(helperRoot, { recursive: true });
      await Promise.all([
        copyFile(
          new URL(
            "../packages/engineering-foundation/assets/windows-managed-process/bootstrap.ps1",
            import.meta.url,
          ),
          bootstrapPath,
        ),
        copyFile(
          new URL(
            "../packages/engineering-foundation/assets/windows-managed-process/WindowsManagedProcess.cs",
            import.meta.url,
          ),
          helperPath,
        ),
      ]);
      const actualBootstrap = (await readFile(bootstrapPath, "utf8")).replaceAll("\r\n", "\n");
      assert.equal(
        createHash("sha256").update(actualBootstrap).digest("hex"),
        "ab3abf73c5d389625db11666c063b4cd295f42b0236d20f33bd14ba9bf3a3be9",
      );
      const legacyBootstrap = actualBootstrap.replace(
        '[System.IO.Path]::Combine($PSScriptRoot, "WindowsManagedProcess.cs"))))',
        'Join-Path $PSScriptRoot "WindowsManagedProcess.cs")))',
      );
      assert.equal(
        createHash("sha256").update(legacyBootstrap).digest("hex"),
        "f2e7d1abb795d45635a7bb1a4715eb440256c20a4409e0963b48dca64e6a0fe9",
      );
      const unqualifiedBootstrap = actualBootstrap.replace(
        "Microsoft.PowerShell.Utility\\Add-Type",
        "Add-Type",
      );
      assert.equal(
        createHash("sha256").update(unqualifiedBootstrap).digest("hex"),
        "7373da6764e631c222eefb42d56967e5adc5e4cc905ea229b18d30da56e4d3b7",
      );
      const systemRoot = Object.entries(process.env).find(
        ([name]) => name.toLowerCase() === "systemroot",
      )?.[1];
      assert.equal(typeof systemRoot, "string");
      async function rejectSchemaWithBlockedCmdlets(source) {
        // Same fixed installed asset and real C# helper, with only a TEST cmdlet trap.
        await writeFile(
          bootstrapPath,
          'function Join-Path { throw "TEST helper lookup must not invoke Join-Path." }\n' +
            'function Add-Type { throw "TEST helper compilation must use module-qualified Add-Type." }\n' +
            source,
        );
        const child = spawn(
          join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            bootstrapPath,
          ],
          { cwd: helperRoot, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        const closed = once(child, "close");
        child.stdin.end(JSON.stringify({ schemaVersion: 0 }));
        const [exitCode] = await once(child, "exit");
        await closed;
        assert.equal(exitCode, 1);
        return stderr;
      }
      const rejectedLegacy = await rejectSchemaWithBlockedCmdlets(legacyBootstrap);
      assert.match(rejectedLegacy, /\[phase=helper-source-read\]/u);
      assert.match(rejectedLegacy, /TEST helper lookup must not invoke Join-Path/u);
      const rejectedUnqualified = await rejectSchemaWithBlockedCmdlets(unqualifiedBootstrap);
      assert.match(rejectedUnqualified, /\[phase=helper-compile\]/u);
      assert.match(
        rejectedUnqualified,
        /TEST helper compilation must use module-qualified Add-Type/u,
      );
      const acceptedCurrent = await rejectSchemaWithBlockedCmdlets(actualBootstrap);
      assert.match(acceptedCurrent, /\[phase=bootstrap-request\]/u);
      assert.doesNotMatch(acceptedCurrent, /\[phase=helper-(?:source-read|compile)\]/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);

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
      'embedded"quote',
      String.raw`embedded\"quote`,
      "PowerShell $&;|<>(){}[]`^",
      "unicode-雪",
      "emoji-😀",
      "x".repeat(20_000),
    ];
    const source = [
      'const { writeFileSync } = require("node:fs");',
      "writeFileSync(process.argv[1], JSON.stringify({",
      "  cwd: process.cwd(), args: process.argv.slice(2)",
      '}), "utf8");',
    ].join("\n");

    try {
      const child = spawnWindowsManagedProcess({
        command: commandPath,
        args: ["-e", source, outputPath, ...expectedArguments],
        cwd,
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
  },
);

windowsTest(
  "launches from an installed adapter path beyond MAX_PATH",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation Windows deep install "));
    let installedRoot = join(root, "installed");
    while (join(installedRoot, "assets", "windows-managed-process").length <= 280) {
      installedRoot = join(installedRoot, "deep-installed-package");
    }
    const sourcePackage = join(process.cwd(), "packages", "engineering-foundation");
    const installedAdapter = join(
      installedRoot,
      "dist",
      "process-execution",
      "windows-managed-process.js",
    );
    let child;
    try {
      await mkdir(installedRoot, { recursive: true });
      await writeFile(join(installedRoot, "package.json"), '{"type":"module"}\n');
      await cp(join(sourcePackage, "dist"), join(installedRoot, "dist"), { recursive: true });
      await cp(
        join(sourcePackage, "assets", "windows-managed-process"),
        join(installedRoot, "assets", "windows-managed-process"),
        { recursive: true },
      );
      assert.ok(installedAdapter.length > 260);
      const installed = await import(
        `${pathToFileURL(installedAdapter).href}?deep-install=${String(Date.now())}`
      );
      child = installed.spawnWindowsManagedProcess({
        command: process.execPath,
        args: ["-e", "process.stdout.write('deep-ok')"],
        cwd: root,
        environment: process.env,
      });
      let stderr = "";
      let stdout = "";
      child.stderr?.setEncoding("utf8");
      child.stdout?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      const closed = once(child, "close");
      const [exitCode] = await once(child, "exit");
      await installed.waitForWindowsManagedProcessContainment(child);
      await closed;
      assert.equal(exitCode, 0, stderr);
      assert.equal(stdout, "deep-ok");
    } finally {
      if (child?.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await rm(root, { force: true, recursive: true });
    }
  },
);

windowsTest(
  "fails closed when the requested Windows command line cannot fit",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const previousRoots = await windowsControlRoots();
    const child = spawnWindowsManagedProcess({
      command: process.execPath,
      args: ["x".repeat(32_767)],
      cwd: process.cwd(),
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const [exitCode] = await once(child, "exit");
    assert.notEqual(exitCode, 0, stderr);
    assert.match(stderr, /Managed command could not be started:/u);
    await waitForWindowsManagedProcessContainment(child);
    await assertNoNewWindowsControlRoots(previousRoots);
  },
);

windowsTest(
  "rejects a non-absolute SystemRoot without leaking controls",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const previousRoots = await windowsControlRoots();
    assert.throws(
      () =>
        spawnWindowsManagedProcess({
          command: process.execPath,
          args: [],
          cwd: process.cwd(),
          launcherEnvironment: { ...process.env, SystemRoot: "relative-system-root" },
        }),
      /SystemRoot must be an absolute Windows path/u,
    );
    await assertNoNewWindowsControlRoots(previousRoots);
  },
);

windowsTest(
  "uses absolute SystemRoot PowerShell despite cwd and early PATH decoys",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
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
        launcherEnvironment: environment,
        command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, 'managed')`],
        cwd,
        environment: { FOUNDATION_EXACT_CHILD_ENVIRONMENT: "1" },
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
  },
);

windowsTest(
  "preserves a real nonzero managed-process result",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation Windows nonzero exit "));
    try {
      const child = spawnWindowsManagedProcess({
        command: process.execPath,
        args: ["-e", "process.exit(23)"],
        cwd: root,
      });
      const [exitCode] = await once(child, "exit");
      assert.equal(exitCode, 23);
      await waitForWindowsManagedProcessContainment(child);
      assert.equal(child.exitCode, 23);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);

windowsTest(
  "terminates and awaits every descendant in the assigned Job Object",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation Windows job "));
    const descendantPath = join(root, "descendant.json");
    let child;
    const source = [
      'const { spawn } = require("node:child_process");',
      readyJsonPublisher,
      'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
      '  { stdio: "ignore", windowsHide: true });',
      "publishReadyJson(process.argv[1], { pid: descendant.pid });",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    try {
      child = spawnWindowsManagedProcess({
        command: process.execPath,
        args: ["-e", source, descendantPath],
        cwd: root,
      });
      const descendant = await waitForJsonFile(descendantPath);

      await requestWindowsManagedProcessTermination(child);
      if (child.exitCode === null && child.signalCode === null) {
        await once(child, "exit");
      }
      assert.equal(child.exitCode, 0);
      assert.throws(
        () => process.kill(descendant.pid, 0),
        (error) => error instanceof Error && "code" in error && error.code === "ESRCH",
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
  },
);

windowsTest(
  "marker write failure forces wrapper termination without leaking controls",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const previousRoots = await windowsControlRoots();
    const root = await mkdtemp(join(tmpdir(), "foundation Windows marker failure "));
    const startedPath = join(root, "started.json");
    let child;
    let managedPid;
    try {
      child = spawnWindowsManagedProcess({
        command: process.execPath,
        args: ["-e", readyPidSource, startedPath],
        cwd: root,
      });
      const controlRoot = await waitForNewWindowsControlRoot(previousRoots);
      ({ pid: managedPid } = await waitForJsonFile(startedPath));
      await mkdir(join(controlRoot, "cancel"));
      await assert.rejects(
        requestWindowsManagedProcessTermination(child),
        (error) =>
          error instanceof Error &&
          "code" in error &&
          (error.code === "EISDIR" || error.code === "EPERM"),
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
  },
);

for (const confirmationFailure of ["invalid", "read"]) {
  windowsTest(
    `confirmation ${confirmationFailure} failure forces wrapper termination without leaking controls`,
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const previousRoots = await windowsControlRoots();
      const root = await mkdtemp(
        join(tmpdir(), `foundation Windows ${confirmationFailure} failure `),
      );
      const startedPath = join(root, "started.json");
      let child;
      let managedPid;
      try {
        child = spawnWindowsManagedProcess({
          command: process.execPath,
          args: ["-e", readyPidSource, startedPath],
          cwd: root,
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
          confirmationFailure === "invalid"
            ? /invalid containment confirmation/u
            : /EISDIR|illegal operation/u,
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
    },
  );
}

windowsTest(
  "retains controls and both errors when forced wrapper cleanup fails",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
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
        args: ["-e", readyPidSource, startedPath],
        cwd: root,
      });
      controlRoot = await waitForNewWindowsControlRoot(previousRoots);
      ({ pid: managedPid } = await waitForJsonFile(startedPath));
      await writeNewFileExclusive(join(controlRoot, "contained"), "INVALID");
      realKill = child.kill.bind(child);
      child.kill = () => {
        throw cleanupError;
      };
      await assert.rejects(waitForWindowsManagedProcessContainment(child), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(String(error.errors[0]), /invalid containment confirmation/u);
        assert.equal(error.errors[1], cleanupError);
        assert.match(String(error.errors[2]), /did not exit within 5000 ms/u);
        assert.equal(error.cause, error.errors[2]);
        return true;
      });
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
  },
);

windowsTest(
  "does not fabricate cleanup failure when kill returns false as the wrapper exits",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const previousRoots = await windowsControlRoots();
    const root = await mkdtemp(join(tmpdir(), "foundation Windows false kill race "));
    const startedPath = join(root, "started.json");
    let child;
    let managedPid;
    let realKill;
    try {
      child = spawnWindowsManagedProcess({
        command: process.execPath,
        args: ["-e", readyPidSource, startedPath],
        cwd: root,
      });
      const controlRoot = await waitForNewWindowsControlRoot(previousRoots);
      ({ pid: managedPid } = await waitForJsonFile(startedPath));
      await writeNewFileExclusive(join(controlRoot, "contained"), "INVALID");
      realKill = child.kill.bind(child);
      child.kill = (signal) => {
        assert.equal(realKill(signal), true);
        return false;
      };
      await assert.rejects(waitForWindowsManagedProcessContainment(child), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof AggregateError, false);
        assert.match(error.message, /invalid containment confirmation/u);
        assert.doesNotMatch(error.message, /could not be terminated/u);
        return true;
      });
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
  },
);

windowsTest(
  "forces and awaits the wrapper after containment confirmation times out",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const previousRoots = await windowsControlRoots();
    const root = await mkdtemp(join(tmpdir(), "foundation Windows timeout "));
    const startedPath = join(root, "started.json");
    let child;
    let managedPid;

    try {
      child = spawnWindowsManagedProcess({
        command: process.execPath,
        args: ["-e", readyPidSource, startedPath],
        cwd: root,
      });
      ({ pid: managedPid } = await waitForJsonFile(startedPath));

      await assert.rejects(
        waitForWindowsManagedProcessContainment(child, 20),
        /did not confirm containment within 20 ms/u,
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
  },
);
