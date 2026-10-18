import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { ProcessRuntimeError } from "node-or-bun";
import {
  ProcessCancellationError,
  ProcessTimeoutError
} from "../packages/engineering-foundation/dist/process-execution/api.js";
import {
  NodeProcessRunner,
  executeManagedProcess
} from "../packages/engineering-foundation/dist/process-execution/node-process-runner.js";
import {
  appendWrapperStderr,
  createWrapperStderrDiagnostics,
  describeManagedProcessCleanupFailure,
  observeWrapperStderr
} from "../packages/engineering-foundation/dist/process-execution/windows-managed-process-diagnostics.js";
import { readProcessFailureFacts } from "../packages/engineering-foundation/dist/features/validation-reporting/process-failure-facts.js";
import { requireAdmittedNodeExecutable } from "../packages/engineering-foundation/dist/process-execution/node-runtime-verifier.js";

const childRuntime = process.env["PROCESS_RUNTIME_DELEGATION_NODE"] ?? process.execPath;
const fixtureParent = process.env["PROCESS_RUNTIME_DELEGATION_TEST_ROOT"] ??
  join(process.cwd(), ".cache", "delegation-output");
mkdirSync(fixtureParent, { recursive: true });
const fixtureRoot = mkdtempSync(join(fixtureParent, "test-fixtures-"));

after(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

async function waitForFixtureMarker(
  marker: string,
  fixtureProcess: Promise<unknown>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown = new Error("Fixture marker readiness failed before its first observation.");
  let settled = false;
  let rejection: { readonly error: unknown } | undefined;
  const observedProcess = fixtureProcess.then(
    () => {
      settled = true;
      return true;
    },
    (error: unknown) => {
      settled = true;
      rejection = { error };
      return false;
    }
  );
  while (Date.now() < deadline) {
    if (settled) {
      await observedProcess;
      if (rejection !== undefined) {
        throw rejection.error;
      }
      throw new Error("Fixture process settled before its readiness marker.");
    }
    try {
      await readFile(marker);
      return;
    } catch (error) {
      failure = error;
    }
    await delay(2);
  }
  throw failure;
}

test("bounds fixture marker readiness and preserves settlement failures", async () => {
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

test("delegates normal, nonzero and signal results with original facts", {
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

test("preserves launch mapping and timeout-before-preabort validation ordering", {
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

test("verifies the explicit supported Node used by the managed bootstrap", async () => {
  assert.equal(
    requireAdmittedNodeExecutable(
      { AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: childRuntime },
      process.execPath
    ),
    childRuntime
  );
  await assert.rejects((async () => requireAdmittedNodeExecutable(
    { AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: join(fixtureRoot, "not-node") },
    process.execPath
  ))(), /explicit admitted Node executable/u);
});

test("preserves strict UTF-8 and the one generic capture limit", {
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

test("keeps observed nonzero results after cancellation but timeout precedence after deadline", {
  skip: process.platform === "win32" ? "POSIX group signal behavior is platform-specific" : false,
  timeout: 15_000
}, async () => {
  const marker = join(fixtureRoot, `observed-${String(Date.now())}-${String(process.pid)}`);
  const controller = new AbortController();
  const script = [
    "process.on('SIGTERM',()=>process.exit(23));",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'x');`,
    "setTimeout(()=>process.exit(23),1000)"
  ].join("");
  const cancelled = executeManagedProcess({
    command: childRuntime,
    args: ["-e", script],
    cwd: fixtureRoot,
    signal: controller.signal
  });
  try {
    await waitForFixtureMarker(marker, cancelled);
    controller.abort(new Error("cancel-after-observation"));
    const observed = await cancelled;
    assert.equal(observed.exitCode, 23);
    assert.deepEqual({ ...readProcessFailureFacts(observed) }, { reason: "exit", exitCode: 23 });
  } finally {
    if (!controller.signal.aborted) {
      controller.abort(new Error("cancel-during-fixture-cleanup"));
    }
    await cancelled.catch(() => {
      return;
    });
    await rm(marker, { force: true });
  }

  await assert.rejects(executeManagedProcess({
    command: childRuntime,
    args: ["-e", "process.on('SIGTERM',()=>process.exit(23));setTimeout(()=>process.exit(23),1000)"],
    cwd: fixtureRoot,
    timeoutMs: 25
  }), (error: unknown) => {
    assert.ok(error instanceof ProcessTimeoutError);
    assert.deepEqual({ ...readProcessFailureFacts(error) }, { reason: "timeout", timeoutMs: 25 });
    return true;
  });
});

test("Windows cancellation protocol proves containment across Job assignment", async () => {
  const [
    nodeAdapterSource,
    windowsManagedProcessSource,
    managedLauncherSource,
    processHostSource
  ] = await Promise.all([
    readFile(join(
      process.cwd(),
      "packages/engineering-foundation/src/process-execution/node-process-runner.ts"
    ), "utf8"),
    readFile(join(
      process.cwd(),
      "packages/engineering-foundation/assets/windows-managed-process/WindowsManagedProcess.cs"
    ), "utf8"),
    readFile(join(
      process.cwd(),
      "packages/engineering-foundation/src/process-execution/windows-managed-process.ts"
    ), "utf8"),
    readFile(join(
      process.cwd(),
      "packages/engineering-foundation/src/process-execution/windows-process-host.ts"
    ), "utf8")
  ]);

  assert.match(
    managedLauncherSource,
    /writeFileSync\(control\.requestPath, serializedRequest/u
  );
  assert.match(
    managedLauncherSource,
    /assertWindowsCommandLineFits\(nodeExecutable, \[\s*PROCESS_HOST_PATH,\s*control\.requestPath\s*\]\)/u
  );
  assert.match(managedLauncherSource, /nodeExecutable,\s*processHostPath/u);
  assert.match(
    managedLauncherSource,
    /cwd: control\.root,\s*env: launcherEnvironment[\s\S]*hostWorkingDirectory: control\.root/u
  );
  assert.doesNotMatch(managedLauncherSource, /encodedRequest/u);
  assert.match(processHostSource, /JSON\.parse\(readFileSync\(requestPath, "utf8"\)\)/u);
  assert.match(
    windowsManagedProcessSource,
    /BuildCommandLine\(\s*executable, new\[\] \{ hostPath, requestPath \}\)/u
  );

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
  const resumeThread = windowsManagedProcessSource.indexOf(
    "if (ResumeThread(process.hThread)",
    createProcess
  );
  const waitForLaunchAttempt = windowsManagedProcessSource.indexOf(
    "var waitResult = WaitForSingleObject(process.hProcess, 10);",
    resumeThread
  );
  const launchConfirmedCancellation = windowsManagedProcessSource.indexOf(
    "if (LaunchSucceeded(launchPath) &&",
    waitForLaunchAttempt
  );
  assert.ok(updateJobList >= 0);
  assert.ok(jobListAttribute >= 0);
  assert.ok(createProcess >= 0);
  assert.ok(resumeThread >= 0);
  assert.ok(waitForLaunchAttempt >= 0);
  assert.ok(launchConfirmedCancellation >= 0);
  assert.ok(updateJobList < jobListAttribute);
  assert.ok(jobListAttribute < createProcess);
  assert.ok(updateJobList < createProcess);
  assert.ok(createProcess < resumeThread);
  assert.ok(resumeThread < waitForLaunchAttempt);
  assert.ok(waitForLaunchAttempt < launchConfirmedCancellation);
  assert.match(
    windowsManagedProcessSource,
    /private static bool LaunchSucceeded[\s\S]*catch \(IOException\)/u
  );

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
  assert.ok(requestTermination >= 0);
  assert.doesNotMatch(nodeAdapterSource, /child\.kill\("SIGKILL"\)/u);
  assert.match(nodeAdapterSource, /await waitForWindowsManagedProcessContainment\(child\)/u);
  assert.match(managedLauncherSource, /forceAndWaitForWrapperExit/u);
  assert.match(managedLauncherSource, /requireAdmittedNodeExecutable/u);
  assert.match(windowsManagedProcessSource, /File\.Move\(temporaryPath, confirmationPath\)/u);

  const controlOwnership = managedLauncherSource.indexOf(
    "windowsProcessControls.set(child, control);"
  );
  const retainChild = managedLauncherSource.indexOf("retain?.(child);", controlOwnership);
  const firstLaterSetup = managedLauncherSource.indexOf("child.once(\"error\"", retainChild);
  assert.ok(controlOwnership >= 0);
  assert.ok(controlOwnership < retainChild);
  assert.ok(retainChild < firstLaterSetup);

  const waitForProcessExit = windowsManagedProcessSource.indexOf(
    "var waitResult = WaitForSingleObject(process.hProcess, 10);"
  );
  const readExitCode = windowsManagedProcessSource.indexOf(
    "if (!GetExitCodeProcess(process.hProcess, out exitCode))",
    waitForProcessExit
  );
  assert.ok(waitForProcessExit >= 0);
  assert.ok(readExitCode > waitForProcessExit);
  assert.match(
    windowsManagedProcessSource.slice(waitForProcessExit, readExitCode),
    /LaunchSucceeded\(launchPath\)[\s\S]*CancelAssignedIfRequested/u
  );
  assert.equal(
    windowsManagedProcessSource.match(/return 0;/gu)?.length,
    1,
    "the wrapper-consumed cancellation path must be neutral"
  );
});

test("maps cleanup failure once with initiating cause and incomplete custody", {
  skip: process.platform === "win32" ? "POSIX group cleanup is the focused seam" : false,
  timeout: 15_000
}, async () => {
  const originalKill = process.kill;
  Object.defineProperty(process, "kill", {
    configurable: true,
    value: (pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0) {
        const result = originalKill(pid, signal);
        throw Object.assign(new Error("synthetic group cleanup failure"), { code: "EPERM", result });
      }
      return originalKill(pid, signal);
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
  } finally {
    Object.defineProperty(process, "kill", {
      configurable: true,
      value: originalKill
    });
  }
});

test("wrapper diagnostics forward once and retain a sliding copied last 64KiB", async () => {
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
      .includes("wrapper-phase=managed-run"),
    false
  );
});
