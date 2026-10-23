import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function assertWindowsCancellationProtocol(): Promise<void> {
  const [nodeAdapterSource, windowsManagedProcessSource, managedLauncherSource, processHostSource] =
    await Promise.all([
      readFile(
        join(
          process.cwd(),
          "packages/engineering-foundation/src/process-execution/node-process-runner.ts",
        ),
        "utf8",
      ),
      readFile(
        join(
          process.cwd(),
          "packages/engineering-foundation/assets/windows-managed-process/WindowsManagedProcess.cs",
        ),
        "utf8",
      ),
      readFile(
        join(
          process.cwd(),
          "packages/engineering-foundation/src/process-execution/windows-managed-process.ts",
        ),
        "utf8",
      ),
      readFile(
        join(
          process.cwd(),
          "packages/engineering-foundation/src/process-execution/windows-process-host.ts",
        ),
        "utf8",
      ),
    ]);

  assert.match(managedLauncherSource, /writeFileSync\(control\.requestPath, serializedRequest/u);
  assert.match(
    managedLauncherSource,
    /assertWindowsCommandLineFits\(nodeExecutable, \[\s*PROCESS_HOST_PATH,\s*control\.requestPath\s*\]\)/u,
  );
  assert.match(managedLauncherSource, /nodeExecutable,\s*processHostPath/u);
  assert.match(
    managedLauncherSource,
    /cwd: control\.root,\s*env: launcherEnvironment[\s\S]*hostWorkingDirectory: control\.root/u,
  );
  assert.doesNotMatch(managedLauncherSource, /encodedRequest/u);
  assert.match(processHostSource, /JSON\.parse\(readFileSync\(requestPath, "utf8"\)\)/u);
  assert.match(
    windowsManagedProcessSource,
    /BuildCommandLine\(\s*executable, new\[\] \{ hostPath, requestPath \}\)/u,
  );

  const updateJobList = windowsManagedProcessSource.indexOf("if (!UpdateProcThreadAttribute(");
  const jobListAttribute = windowsManagedProcessSource.indexOf(
    "PROC_THREAD_ATTRIBUTE_JOB_LIST,",
    updateJobList,
  );
  const createProcess = windowsManagedProcessSource.indexOf("if (!CreateProcess(", updateJobList);
  const resumeThread = windowsManagedProcessSource.indexOf(
    "if (ResumeThread(process.hThread)",
    createProcess,
  );
  const waitForLaunchAttempt = windowsManagedProcessSource.indexOf(
    "var waitResult = WaitForSingleObject(process.hProcess, 10);",
    resumeThread,
  );
  const launchConfirmedCancellation = windowsManagedProcessSource.indexOf(
    "if (LaunchSucceeded(launchPath) &&",
    waitForLaunchAttempt,
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
    /private static bool LaunchSucceeded[\s\S]*catch \(IOException\)/u,
  );

  const assignedCancellationHelper = windowsManagedProcessSource.indexOf(
    "private static bool CancelAssignedIfRequested",
  );
  const terminateAssignedJob = windowsManagedProcessSource.indexOf(
    "TerminateRemainingProcessesAndWait(job);",
    assignedCancellationHelper,
  );
  const confirmAssignedContainment = windowsManagedProcessSource.indexOf(
    "ConfirmContainment(confirmationPath);",
    assignedCancellationHelper,
  );
  assert.ok(assignedCancellationHelper < terminateAssignedJob);
  assert.ok(terminateAssignedJob < confirmAssignedContainment);

  const assignedJobTermination = windowsManagedProcessSource.slice(
    windowsManagedProcessSource.indexOf("private static void TerminateRemainingProcessesAndWait"),
    windowsManagedProcessSource.indexOf("private static void ConfirmContainment"),
  );
  assert.match(assignedJobTermination, /TerminateJobObject\(job, 1\)/u);
  assert.match(assignedJobTermination, /while \(ActiveProcessCount\(job\) > 0\)/u);

  const requestTermination = nodeAdapterSource.indexOf(
    "await requestWindowsManagedProcessTermination(child);",
  );
  assert.ok(requestTermination >= 0);
  assert.doesNotMatch(nodeAdapterSource, /child\.kill\("SIGKILL"\)/u);
  assert.match(nodeAdapterSource, /await waitForWindowsManagedProcessContainment\(child\)/u);
  const nativeLaunch = nodeAdapterSource.indexOf("running = await nativeAdapter.launch(request);");
  const forwardAbort = nodeAdapterSource.indexOf("launchAbort.succeed();", nativeLaunch);
  const commandGate = nodeAdapterSource.indexOf(
    "await waitForWindowsManagedProcessLaunch(",
    forwardAbort,
  );
  assert.ok(nativeLaunch >= 0 && forwardAbort > nativeLaunch && commandGate > forwardAbort);

  assert.match(managedLauncherSource, /forceAndWaitForWrapperExit/u);
  assert.match(managedLauncherSource, /requireAdmittedNodeExecutable/u);
  assert.match(windowsManagedProcessSource, /File\.Move\(temporaryPath, confirmationPath\)/u);

  const controlOwnership = managedLauncherSource.indexOf(
    "windowsProcessControls.set(child, control);",
  );
  const retainChild = managedLauncherSource.indexOf("retain?.(child);", controlOwnership);
  const firstLaterSetup = managedLauncherSource.indexOf('child.once("error"', retainChild);
  assert.ok(controlOwnership >= 0);
  assert.ok(controlOwnership < retainChild);
  assert.ok(retainChild < firstLaterSetup);

  const waitForProcessExit = windowsManagedProcessSource.indexOf(
    "var waitResult = WaitForSingleObject(process.hProcess, 10);",
  );
  const readExitCode = windowsManagedProcessSource.indexOf(
    "if (!GetExitCodeProcess(process.hProcess, out exitCode))",
    waitForProcessExit,
  );
  assert.ok(waitForProcessExit >= 0);
  assert.ok(readExitCode > waitForProcessExit);
  assert.match(
    windowsManagedProcessSource.slice(waitForProcessExit, readExitCode),
    /LaunchSucceeded\(launchPath\)[\s\S]*CancelAssignedIfRequested/u,
  );
  assert.match(
    windowsManagedProcessSource.slice(waitForProcessExit, readExitCode),
    /if \(LaunchSucceeded\(launchPath\) &&\s*CancelAssignedIfRequested\(cancellationPath, confirmationPath, job\)\)\s*\{\s*return 0;/u,
    "the wrapper-consumed cancellation branch must be neutral",
  );
}
