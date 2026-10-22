import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test, { after } from "node:test";

import { ProcessRuntimeError } from "node-or-bun";
import { foundationCommandFailure } from "../packages/engineering-foundation/dist/features/command-host/application/command-failure.js";
import {
  ProcessCancellationError,
  ProcessTimeoutError
} from "../packages/engineering-foundation/dist/process-execution/api.js";
import {
  NodeProcessRunner,
  executeManagedProcess,
  terminatePosixProcessGroup
} from "../packages/engineering-foundation/dist/process-execution/node-process-runner.js";
import {
  appendWrapperStderr,
  createWrapperStderrDiagnostics,
  describeManagedProcessCleanupFailure,
  observeWrapperStderr
} from "../packages/engineering-foundation/dist/process-execution/windows-managed-process-diagnostics.js";
import { readProcessFailureFacts } from "../packages/engineering-foundation/dist/features/validation-reporting/process-failure-facts.js";
import { SUPPORTED_NODE_VERSIONS, requireAdmittedNodeExecutable, verifyRepositoryRuntimeExecutable } from "../packages/engineering-foundation/dist/process-execution/node-runtime-verifier.js";

import { createNodeQualityGateCommand } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/composition/node-quality-gate-command.js";
import { createNodeAgentWorkflowCommands } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/composition/node-commands.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
import type { ManagedProcessRequest } from "../packages/engineering-foundation/dist/process-execution/api.js";
import { resolvePnpmInvocation } from "../tools/pnpm-command.mts";
import { readRepositoryRuntimePolicy } from "../tools/runtime-policy.mts";
import { assertWindowsCancellationProtocol } from "./support/process-runtime-windows-protocol.ts";
import { assertCancellationPrecedence, waitForFixtureMarker } from "./support/process-runtime-cancellation-fixture.ts";

const childRuntime = process.env["PROCESS_RUNTIME_DELEGATION_NODE"] ?? process.execPath;
const fixtureParent = process.env["PROCESS_RUNTIME_DELEGATION_TEST_ROOT"] ??
  join(process.cwd(), ".cache", "delegation-output");
mkdirSync(fixtureParent, { recursive: true });
const fixtureRoot = mkdtempSync(join(fixtureParent, "test-fixtures-"));

after(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});


void test("bounds fixture marker readiness and preserves settlement failures", async () => {
  const missing = join(fixtureRoot, "never-ready");
  await assert.rejects(
    waitForFixtureMarker(missing, new Promise<never>(() => {
      // Intentionally remains pending for this bounded readiness proof.
    }), 25),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
  );
  const launchFailure = new Error("fixture launch failed");
  await assert.rejects(
    waitForFixtureMarker(missing, Promise.reject(launchFailure), 5_000),
    (error: unknown) => error === launchFailure
  );
});

void test("delegates normal, nonzero and signal results with original facts", {
  skip: process.platform === "win32" ? "signal behavior is platform-specific" : false,
  timeout: 15_000
}, async () => {
  const normal = await executeManagedProcess({
    command: childRuntime,
    args: ["-e", "process.stdout.write('ok');process.stderr.write('note')"],
    cwd: fixtureRoot
  });
  assert.deepEqual(
    { exitCode: normal.exitCode, signal: normal.signal, stdout: normal.stdout, stderr: normal.stderr },
    { exitCode: 0, signal: null, stdout: "ok", stderr: "note" }
  );

  const nonzero = await executeManagedProcess({
    command: childRuntime,
    args: ["-e", "process.exitCode=23"],
    cwd: fixtureRoot
  });
  assert.equal(nonzero.exitCode, 23);
  assert.deepEqual({ ...readProcessFailureFacts(nonzero) }, { reason: "exit", exitCode: 23 });
  await assert.rejects(new NodeProcessRunner().run({
    command: childRuntime,
    args: ["-e", "process.stderr.write('failed');process.exitCode=7"],
    cwd: fixtureRoot
  }), (error: unknown) => {
    assert.equal(readProcessFailureFacts(error)?.reason, "exit");
    assert.equal(readProcessFailureFacts(error)?.exitCode, 7);
    return true;
  });

  const signal = await executeManagedProcess({
    command: childRuntime,
    args: ["-e", "process.kill(process.pid,'SIGTERM')"],
    cwd: fixtureRoot
  });
  assert.equal(signal.exitCode, 1);
  assert.equal(signal.signal, "SIGTERM");
  assert.deepEqual({ ...readProcessFailureFacts(signal) }, { reason: "exit", signal: "SIGTERM" });
});

void test("preserves launch mapping and timeout-before-preabort validation ordering", {
  timeout: 15_000
}, async () => {
  await assert.rejects(executeManagedProcess({
    command: join(fixtureRoot, "missing-process-runtime-delegation-command"),
    args: [],
    cwd: fixtureRoot
  }), (error: unknown) => {
    assert.equal(readProcessFailureFacts(error)?.reason, "launch");
    return true;
  });

  const controller = new AbortController();
  controller.abort(new Error("pre-aborted"));
  await assert.rejects(executeManagedProcess({
    command: childRuntime,
    args: ["-e", ""],
    cwd: fixtureRoot,
    timeoutMs: 0,
    signal: controller.signal
  }), (error: unknown) => {
    assert.match((error as Error).message, /requires timeoutMs to be a positive integer/u);
    assert.ok(!(error instanceof ProcessCancellationError));
    return true;
  });

  const preabortMarker = join(fixtureRoot, `preabort-${String(Date.now())}-${String(process.pid)}`);
  const preabortController = new AbortController();
  preabortController.abort(new Error("pre-aborted"));
  await assert.rejects(executeManagedProcess({
    command: childRuntime,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(preabortMarker)},'x')`],
    cwd: fixtureRoot,
    timeoutMs: 50,
    signal: preabortController.signal
  }), (error: unknown) => {
    assert.ok(error instanceof ProcessCancellationError);
    assert.equal(readProcessFailureFacts(error)?.reason, "cancelled");
    return true;
  });
  await assert.rejects(readFile(preabortMarker), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });
});

void test("verifies the explicit supported Node used by the managed bootstrap", async () => {
  assert.equal(requireAdmittedNodeExecutable({}, childRuntime), realpathSync(childRuntime));
  assert.equal(
    requireAdmittedNodeExecutable(
      { AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: childRuntime },
      process.execPath
    ),
    realpathSync(childRuntime)
  );
  await assert.rejects((async () => requireAdmittedNodeExecutable(
    { AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: join(fixtureRoot, "not-node") },
    process.execPath
  ))(), /explicit admitted Node executable/u);
});

void test("preserves strict UTF-8 and the one generic capture limit", {
  timeout: 15_000
}, async () => {
  await assert.rejects(executeManagedProcess({
    command: childRuntime,
    args: ["-e", "process.stdout.write(Buffer.from([255]))"],
    cwd: fixtureRoot,
    strictUtf8: true
  }), (error: unknown) => {
    assert.equal(readProcessFailureFacts(error)?.reason, "invalid-output");
    return true;
  });
  await assert.rejects(executeManagedProcess({
    command: childRuntime,
    args: ["-e", "process.stdout.write(Buffer.alloc(4*1024*1024+1))"],
    cwd: fixtureRoot,
    timeoutMs: 5_000
  }), (error: unknown) => {
    assert.equal(readProcessFailureFacts(error)?.reason, "output-limit");
    return true;
  });
});

void test("keeps observed nonzero results after cancellation but timeout precedence after deadline", {
  skip: process.platform === "win32" ? "POSIX group signal behavior is platform-specific" : false,
  timeout: 15_000
}, async () => {
  await assertCancellationPrecedence(childRuntime, fixtureRoot);
});

void test("Windows cancellation protocol proves containment across Job assignment", assertWindowsCancellationProtocol);

void test("maps cleanup failure once with initiating cause and incomplete custody", {
  skip: process.platform === "win32" ? "POSIX group cleanup is the focused seam" : false,
  timeout: 15_000
}, async t => {
  const originalKillDescriptor = Object.getOwnPropertyDescriptor(process, "kill");
  assert.ok(originalKillDescriptor !== undefined);
  const invokeOriginalKill = process.kill.bind(process);
  const processGroups = new Set<number>();
  let successfulTerminations = 0;
  let deniedProbes = 0;
  const restoreKill = () => {
    Object.defineProperty(process, "kill", originalKillDescriptor);
  };
  t.after(async () => {
    restoreKill();
    for (const group of processGroups) {
      await terminatePosixProcessGroup(group);
    }
  });
  Object.defineProperty(process, "kill", {
    configurable: true,
    value: (pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0) {
        processGroups.add(-pid);
        if (signal === 0) {
          deniedProbes += 1;
        } else {
          try {
            invokeOriginalKill(pid, signal);
            successfulTerminations += 1;
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
              throw error;
            }
          }
        }
        throw Object.assign(new Error("synthetic group cleanup failure"), { code: "EPERM" });
      }
      return invokeOriginalKill(pid, signal);
    }
  });
  try {
    await assert.rejects(executeManagedProcess({
      command: childRuntime,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: fixtureRoot,
      timeoutMs: 25
    }), (error: unknown) => {
      assert.equal(readProcessFailureFacts(error)?.reason, "cleanup");
      const runtimeCause = (error as Error).cause;
      assert.ok(runtimeCause instanceof ProcessRuntimeError);
      assert.equal(runtimeCause.code, "cleanup");
      assert.equal(runtimeCause.incompleteCustody, true);
      assert.ok(runtimeCause.initiatingError instanceof ProcessRuntimeError);
      assert.equal(runtimeCause.initiatingError.code, "timeout");
      return true;
    });
    assert.ok(successfulTerminations > 0, "the cleanup fault must follow actual process-group termination");
    if (process.platform === "darwin") {
      assert.ok(deniedProbes > 0, "Darwin absence observations must remain denied");
    }
  } finally {
    restoreKill();
    t.diagnostic(`cleanup fault witness: ${JSON.stringify({ successfulTerminations, deniedProbes })}`);
  }
});

void test("wrapper diagnostics forward once and retain a sliding copied last 64KiB", async () => {
  const diagnostics = createWrapperStderrDiagnostics();
  const prefix = Buffer.alloc(64 * 1024 - 1);
  for (let index = 0; index < prefix.length; index += 1) {
    prefix[index] = index % 251;
  }
  const middle = Buffer.from("middle\n");
  const late = Buffer.from(
    "Windows Job Object runner failed [phase=managed-run]: late diagnostic\n"
  );
  const chunks = [prefix, middle, late];
  const observed: Uint8Array[] = [];
  for await (const chunk of observeWrapperStderr(
    (async function* source() { yield* chunks; })(),
    diagnostics
  )) {
    observed.push(chunk);
  }
  assert.ok(observed.every((chunk, index) => chunk === chunks[index]));
  assert.deepEqual(observed, chunks);
  assert.equal(diagnostics.bytes, 64 * 1024);
  const suffix = Buffer.concat(diagnostics.chunks);
  assert.equal(suffix.length, 64 * 1024);
  assert.ok(suffix.subarray(0, prefix.length - 76).equals(prefix.subarray(76)));
  assert.ok(suffix.includes(late));

  const backing = new Uint8Array(128 * 1024);
  backing.fill(0x62, 0, 64 * 1024 + 32);
  backing.set(Buffer.from("last-marker\n"), 64 * 1024 + 32);
  const oversized = backing.subarray(0, 64 * 1024 + 44);
  appendWrapperStderr(diagnostics, oversized);
  const latest = Buffer.concat(diagnostics.chunks);
  assert.equal(latest.length, 64 * 1024);
  assert.ok(latest.includes(Buffer.from("last-marker\n")));
  assert.notEqual(diagnostics.chunks[0]?.buffer, backing.buffer);
  assert.equal(
    describeManagedProcessCleanupFailure(new Error("failed"), diagnostics.chunks, true)
      .includes("wrapper-phase=unreported"),
    true
  );
});

async function runtimeGateFixture(packageManager: "bun" | "pnpm" = "bun"): Promise<string> {
  const root = mkdtempSync(join(fixtureRoot, "runtime-gate-"));
  const policy = await readRepositoryRuntimePolicy();
  const managerVersion = packageManager === "bun" ? policy.toolchain.bun.version : policy.toolchain.pnpm.version;
  await writeFile(join(root, "package.json"), JSON.stringify({
    private: true, packageManager: `${packageManager}@${managerVersion}`,
    scripts: { check: "node -e \"process.exit(0)\"" }
  }));
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  await writeFile(join(root, "gate.yaml"), JSON.stringify({
    schemaVersion: 2,
    profiles: [{ id: "check", packageManager, concurrency: 1, tasks: [{ id: "check" }] }]
  }));
  return root;
}

// A regular executable of the wrong kind must fail before any package script runs.
// These invoke the real composition roots, rather than a verifier test double.
void test("quality gate composition rejects Node as Bun before script effects", async () => {
  const requests: ManagedProcessRequest[] = [];
  const command = createNodeQualityGateCommand({
    AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: childRuntime,
    AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: childRuntime
  }, { async run(request) {
    requests.push(request);
    return { exitCode: 0, signal: null, stdout: "", stderr: "" };
  } }, assertSchema);
  await assert.rejects(command({
    consumerRoot: await runtimeGateFixture(), configPath: "gate.yaml", profileId: "check"
  }), (error: unknown) => {
    assert.match(String(error), /explicit Bun executable is unavailable/u);
    assert.equal(foundationCommandFailure(error).envelope.error.code, "QUALITY_GATE_RUNNER_RUNTIME_INVALID");
    return true;
  });
  assert.equal(requests.length, 0);
});

void test("agent workflow composition rejects Node as Bun before script effects", async () => {
  const root = mkdtempSync(join(fixtureRoot, "runtime-workflow-"));
  await executeManagedProcess({ command: "git", args: ["init", "--quiet"], cwd: root });
  await writeFile(join(root, "check.ts"), "// disposable runtime identity fixture\n");
  await writeFile(join(root, "workflow.yaml"), JSON.stringify({
    schemaVersion: 1,
    instructions: { canonical: "AGENTS.md", claude: "CLAUDE.md", gemini: "GEMINI.md", copilot: ".github/copilot-instructions.md" },
    scripts: { changed: "check:changed", fast: "check:fast", full: "check" },
    changedChecks: [{ id: "check", script: "check", extensions: [".ts"], passPaths: false }],
    fullScanPaths: ["package.json"]
  }));
  const scriptRequests: ManagedProcessRequest[] = [];
  const commands = createNodeAgentWorkflowCommands({
    nodeExecutablePath: childRuntime, bunExecutablePath: childRuntime,
    processEnvironment: process.env
  }, { async run(request) {
    if (request.command === "git") {
      return executeManagedProcess(request);
    }
    scriptRequests.push(request);
    return { exitCode: 0, signal: null, stdout: "", stderr: "" };
  } }, assertSchema);
  await assert.rejects(commands.changed({
    consumerRoot: root, configPath: "workflow.yaml", format: "json"
  }), (error: unknown) => {
    assert.match(String(error), /explicit Bun executable is unavailable/u);
    assert.equal(foundationCommandFailure(error).envelope.error.code, "REPOSITORY_AGENT_WORKFLOW_RUNTIME_INVALID");
    return true;
  });
  assert.equal(scriptRequests.length, 0);
});

function installedBunExecutable(): string | undefined {
  const explicit = process.env["PROCESS_RUNTIME_DELEGATION_BUN"];
  if (explicit !== undefined) {
    return realpathSync(explicit);
  }
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    try {
      return realpathSync(join(directory, process.platform === "win32" ? "bun.exe" : "bun"));
    } catch {
      // This PATH entry has no Bun installation.
    }
  }
  return undefined;
}

const installedBun = installedBunExecutable();
void test("quality gate composition rejects installed Bun as Node before script effects", {
  skip: installedBun === undefined ? "Bun is not installed" : false
}, async () => {
  assert.ok(installedBun !== undefined && installedBun.length > 0);
  const command = createNodeQualityGateCommand({
    AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: installedBun
  }, { async run() { throw new Error("Wrong-runtime script must not run"); } }, assertSchema);
  await assert.rejects(command({
    consumerRoot: await runtimeGateFixture(), configPath: "gate.yaml", profileId: "check"
  }), /explicit Node executable is unavailable/u);
});

void test("runtime verifier accepts real Node and rejects symlinks and non-executables", async () => {
  assert.equal(await verifyRepositoryRuntimeExecutable(childRuntime, "node"), true);
  assert.equal(await verifyRepositoryRuntimeExecutable(childRuntime, "bun"), false);
  const plainFile = join(fixtureRoot, "not-an-executable");
  await writeFile(plainFile, "a regular file is not runtime identity");
  assert.equal(await verifyRepositoryRuntimeExecutable(plainFile, "node"), false);
  assert.equal(await verifyRepositoryRuntimeExecutable("node", "node"), false);
  if (process.platform !== "win32") {
    const alias = join(fixtureRoot, "node-alias");
    await symlink(childRuntime, alias);
    assert.equal(await verifyRepositoryRuntimeExecutable(alias, "node"), false);
    // The Windows bootstrap's separate admission path launches the canonical
    // target it probed, never a mutable alias supplied by the caller.
    assert.equal(requireAdmittedNodeExecutable({
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: alias
    }, childRuntime), realpathSync(childRuntime));
  }
});

void test("quality gate composition runs a real Node/pnpm package script", async () => {
  const policy = await readRepositoryRuntimePolicy();
  const manager = await resolvePnpmInvocation(childRuntime, policy.toolchain.pnpm.version);
  const pnpm = manager.kind === "javascript" ? manager.args[0] : manager.command;
  assert.ok(pnpm);
  const command = createNodeQualityGateCommand({
    AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: childRuntime,
    PATH: process.env["PATH"],
    npm_execpath: pnpm,
    AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT: pnpm,
    PNPM_HOME: process.env["PNPM_HOME"],
    SystemRoot: process.env["SystemRoot"],
    ComSpec: process.env["ComSpec"]
  }, { run: executeManagedProcess }, assertSchema);
  const report = await command({
    consumerRoot: await runtimeGateFixture("pnpm"), configPath: "gate.yaml", profileId: "check"
  });
  assert.equal(report.outcome, "passed", JSON.stringify(report));
  assert.equal(report.tasks[0]?.exitCode, 0);
});

void test("runtime verifier and quality gate composition accept installed Bun in its own role", {
  skip: installedBun === undefined ? "Bun is not installed" : false
}, async () => {
  assert.ok(installedBun !== undefined && installedBun.length > 0);
  assert.equal(await verifyRepositoryRuntimeExecutable(installedBun, "bun"), true);
  assert.equal(await verifyRepositoryRuntimeExecutable(installedBun, "node"), false);
  assert.throws(() => requireAdmittedNodeExecutable({
    AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: installedBun
  }, childRuntime), /supported public Node executable/u);
  const command = createNodeQualityGateCommand({
    AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: childRuntime,
    AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: installedBun,
    PATH: process.env["PATH"],
    SystemRoot: process.env["SystemRoot"],
    ComSpec: process.env["ComSpec"]
  }, { run: executeManagedProcess }, assertSchema);
  const report = await command({
    consumerRoot: await runtimeGateFixture(), configPath: "gate.yaml", profileId: "check"
  });
  assert.equal(report.outcome, "passed", JSON.stringify(report));
  assert.equal(report.tasks[0]?.exitCode, 0);
});

// Public engines and the Host admission policy must evolve in the same change.
void test("Node admission versions match both published and repository engines", async () => {
  const expected = SUPPORTED_NODE_VERSIONS.map(({ major, minimumMinor }) => `^${major}.${minimumMinor}.0`).join(" || ");
  for (const path of ["../package.json", "../packages/engineering-foundation/package.json"]) {
    const manifest = JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as { engines: { node: string } };
    assert.equal(manifest.engines.node, expected);
  }
});

// Trusted control markers, rather than the wrapper exit or captured stderr,
// distinguish a command launch failure from an ordinary command failure.
void test("Windows launch handshake preserves exit-one commands and startup deadlines", {
  skip: process.platform !== "win32" ? "native Windows handshake" : false,
  timeout: 30_000
}, async () => {
  const result = await executeManagedProcess({
    command: childRuntime,
    args: ["-e", "process.stderr.write('Managed command could not be started: FAILED');process.exitCode=1"],
    cwd: fixtureRoot
  });
  assert.equal(result.exitCode, 1);
  assert.equal(readProcessFailureFacts(result)?.reason, "exit");
  await assert.rejects(executeManagedProcess({
    command: childRuntime,
    args: ["-e", "setTimeout(()=>{},60000)"],
    cwd: fixtureRoot,
    timeoutMs: 10
  }), ProcessTimeoutError);
  const cancellation = new AbortController();
  const cancelTimer = setTimeout(() => {
    cancellation.abort(new Error("earlier Windows cancellation"));
  }, 1);
  try {
    await assert.rejects(executeManagedProcess({
      command: childRuntime,
      args: ["-e", "setTimeout(()=>{},60000)"],
      cwd: fixtureRoot,
      timeoutMs: 5,
      signal: cancellation.signal
    }), ProcessCancellationError);
  } finally {
    clearTimeout(cancelTimer);
  }
});

void test("Windows command launch protocol validates markers and yields interrupted waits", async () => {
  const { waitForWindowsCommandLaunch } = await import("../packages/engineering-foundation/dist/process-execution/windows-command-launch.js");
  const root = mkdtempSync(join(fixtureRoot, "launch-protocol-"));
  const marker = join(root, "launched");
  const child = { exitCode: null, signalCode: null };
  await writeFile(marker, "STARTED");
  await waitForWindowsCommandLaunch(child, marker, () => false);
  await writeFile(marker, "FAILED");
  await assert.rejects(waitForWindowsCommandLaunch(child, marker, () => false), /could not be started/u);
  await writeFile(marker, "unrecognized");
  await assert.rejects(waitForWindowsCommandLaunch(child, marker, () => false), /invalid launch confirmation/u);
  await rm(marker);
  let polls = 0;
  await waitForWindowsCommandLaunch(child, marker, () => ++polls >= 2);
  assert.equal(polls, 2);
  await assert.rejects(waitForWindowsCommandLaunch({ exitCode: 1, signalCode: null }, marker, () => false), /without a command launch confirmation/u);
});
