import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export interface WindowsManagedProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Exact environment inherited by the requested command. */
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  /** Private environment used only to launch the trusted PowerShell wrapper. */
  readonly launcherEnvironment?: Readonly<NodeJS.ProcessEnv>;
}

const WINDOWS_BOOTSTRAP_PATH = fileURLToPath(
  new URL("../../assets/windows-managed-process/bootstrap.ps1", import.meta.url)
);
const PROCESS_HOST_PATH = fileURLToPath(
  new URL("./windows-process-host.js", import.meta.url)
);
const MAX_WINDOWS_COMMAND_LINE_CHARACTERS = 32_766;
const CONTROL_CONFIRMATION_TIMEOUT_MS = 30_000;
const WRAPPER_EXIT_TIMEOUT_MS = 5_000;
const WRAPPER_EXIT_CONFIRMATION_GRACE_MS = 1_000;
const CONTROL_POLL_INTERVAL_MS = 10;

// The packaged native helper owns the JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
// contract. Its TerminateRemainingProcessesAndWait(job) path confirms that
// while (ActiveProcessCount(job) > 0) is false before reporting containment.

interface WindowsProcessControl {
  readonly cancellationPath: string;
  readonly confirmationPath: string;
  readonly launchPath: string;
  readonly requestPath: string;
  readonly root: string;
}

const windowsProcessControls = new WeakMap<ChildProcess, WindowsProcessControl>();

function createControl(): WindowsProcessControl {
  const root = mkdtempSync(join(tmpdir(), "agent-teams-foundation-process-"));
  return {
    cancellationPath: join(root, "cancel"),
    confirmationPath: join(root, "contained"),
    launchPath: join(root, "launched"),
    requestPath: join(root, "request.json"),
    root
  };
}

function resolveWindowsPowerShellPath(
  environment: Readonly<NodeJS.ProcessEnv> | undefined
): string {
  const systemRoot = Object.entries(environment ?? {}).find(
    ([key]) => key.toLowerCase() === "systemroot"
  )?.[1];
  if (
    typeof systemRoot !== "string" ||
    systemRoot.length === 0 ||
    !win32.isAbsolute(systemRoot)
  ) {
    throw new Error("SystemRoot must be an absolute Windows path.");
  }
  return win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
}

function commandEnvironmentWithSystemRoot(
  environment: Readonly<NodeJS.ProcessEnv>,
  launcherEnvironment: Readonly<NodeJS.ProcessEnv>
): Readonly<NodeJS.ProcessEnv> {
  if (Object.keys(environment).some((key) => key.toLowerCase() === "systemroot")) {
    return environment;
  }
  const systemRoot = Object.entries(launcherEnvironment).find(
    ([key]) => key.toLowerCase() === "systemroot"
  )?.[1];
  return { ...environment, SystemRoot: systemRoot };
}

function removeControlRootBestEffort(root: string): boolean {
  try {
    rmSync(root, { force: true, recursive: true });
    return true;
  } catch {
    return false;
  }
}

function disposeControl(child: ChildProcess, control: WindowsProcessControl): void {
  if (removeControlRootBestEffort(control.root)) {
    windowsProcessControls.delete(child);
  }
}

function disposeControlAfterWrapperExit(child: ChildProcess, control: WindowsProcessControl): void {
  const disposeAfterExit = () => {
    disposeControl(child, control);
  };
  child.once("exit", disposeAfterExit);
  if (child.exitCode !== null || child.signalCode !== null) {
    child.removeListener("exit", disposeAfterExit);
    disposeAfterExit();
  }
}

function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[ \t"]/u.test(value)) {
    return value;
  }
  let output = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === "\\") {
      slashes += 1;
      continue;
    }
    if (character === '"') {
      output += "\\".repeat(slashes * 2 + 1) + character;
      slashes = 0;
      continue;
    }
    output += "\\".repeat(slashes) + character;
    slashes = 0;
  }
  return output + "\\".repeat(slashes * 2) + '"';
}

function assertWindowsCommandLineFits(executable: string, args: readonly string[]): void {
  const commandLine = [executable, ...args]
    .map((argument) => quoteWindowsArgument(argument))
    .join(" ");
  if (commandLine.length > MAX_WINDOWS_COMMAND_LINE_CHARACTERS) {
    throw new Error(
      `The managed Windows process bootstrap command line exceeds ${MAX_WINDOWS_COMMAND_LINE_CHARACTERS} characters.`
    );
  }
}

/**
 * Starts the packaged PowerShell bootstrap with a fixed, short command line.
 * The request is stored in the private control root for the contained host to
 * read; only fixed bootstrap metadata crosses PowerShell as JSON on stdin. The
 * native helper atomically creates the Node process host in its Job Object, and
 * only that contained host can launch the requested command.
 */
export function spawnWindowsManagedProcess(
  request: WindowsManagedProcessRequest
): ChildProcess {
  const control = createControl();
  const launcherEnvironment = request.launcherEnvironment ?? process.env;
  const commandEnvironment = commandEnvironmentWithSystemRoot(
    request.environment ?? launcherEnvironment,
    launcherEnvironment
  );
  const serializedRequest = JSON.stringify({
    schemaVersion: 1,
    command: request.command,
    args: [...request.args],
    cwd: request.cwd,
    launchPath: control.launchPath
  });
  try {
    writeFileSync(control.requestPath, serializedRequest, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    assertWindowsCommandLineFits(process.execPath, [
      PROCESS_HOST_PATH,
      control.requestPath
    ]);
  } catch (error) {
    removeControlRootBestEffort(control.root);
    throw error;
  }
  let child: ChildProcess;
  try {
    child = spawn(
      resolveWindowsPowerShellPath(launcherEnvironment),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        WINDOWS_BOOTSTRAP_PATH
      ],
      {
        cwd: win32.dirname(WINDOWS_BOOTSTRAP_PATH),
        env: launcherEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );
  } catch (error) {
    removeControlRootBestEffort(control.root);
    throw error;
  }
  windowsProcessControls.set(child, control);
  child.once("error", () => {
    cleanUpWindowsManagedProcessLaunchFailure(child);
  });
  const bootstrapInput = child.stdin;
  if (bootstrapInput === null) {
    try {
      child.kill("SIGKILL");
    } finally {
      disposeControlAfterWrapperExit(child, control);
    }
    throw new Error("Windows Job Object wrapper did not expose its bootstrap input.");
  }
  bootstrapInput.once("error", () => {
    // The wrapper's process error is reported through its own error event.
  });
  bootstrapInput.end(JSON.stringify({
    schemaVersion: 1,
    nodeExecutable: process.execPath,
    processHostPath: PROCESS_HOST_PATH,
    requestPath: control.requestPath,
    hostWorkingDirectory: win32.dirname(PROCESS_HOST_PATH),
    environmentEntries: Object.entries(commandEnvironment)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${value}`),
    cancellationPath: control.cancellationPath,
    confirmationPath: control.confirmationPath,
    launchPath: control.launchPath
  }));
  return child;
}

/** Releases control artifacts when PowerShell was never launched. */
export function cleanUpWindowsManagedProcessLaunchFailure(child: ChildProcess): void {
  const control = windowsProcessControls.get(child);
  if (child.pid === undefined && control !== undefined) {
    disposeControl(child, control);
  }
}

async function readContainmentConfirmation(
  control: WindowsProcessControl
): Promise<string | undefined> {
  try {
    return await readFile(control.confirmationPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readContainmentConfirmationAfterWrapperExit(
  control: WindowsProcessControl,
  confirmationDeadline: number
): Promise<string | undefined> {
  const deadline = Math.min(
    confirmationDeadline,
    performance.now() + WRAPPER_EXIT_CONFIRMATION_GRACE_MS
  );
  for (;;) {
    const confirmation = await readContainmentConfirmation(control);
    if (confirmation !== undefined) {
      return confirmation;
    }
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      return undefined;
    }
    await delay(Math.min(CONTROL_POLL_INTERVAL_MS, remainingMs));
  }
}

function controlFor(child: ChildProcess): WindowsProcessControl {
  const control = windowsProcessControls.get(child);
  if (control === undefined) {
    throw new Error("The Windows process is not owned by the managed-process adapter.");
  }
  return control;
}

async function wrapperExitedWithin(
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  const exitDeadline = performance.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null) {
    const remainingMs = exitDeadline - performance.now();
    if (remainingMs <= 0) {
      return false;
    }
    await delay(Math.min(CONTROL_POLL_INTERVAL_MS, remainingMs));
  }
  return true;
}

async function forceAndWaitForWrapperExit(
  child: ChildProcess,
  control: WindowsProcessControl
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  if (child.exitCode === null && child.signalCode === null) {
    let terminationRequested = false;
    try {
      terminationRequested = child.kill("SIGKILL");
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!await wrapperExitedWithin(child, WRAPPER_EXIT_TIMEOUT_MS)) {
      if (!terminationRequested && cleanupErrors.length === 0) {
        cleanupErrors.push(new Error("Windows Job Object wrapper could not be terminated."));
      }
      cleanupErrors.push(new Error(
        `Windows Job Object wrapper did not exit within ${String(WRAPPER_EXIT_TIMEOUT_MS)} ms after forced termination.`
      ));
      try {
        disposeControlAfterWrapperExit(child, control);
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else {
      try {
        disposeControl(child, control);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  } else {
    try {
      disposeControl(child, control);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    const aggregateError = new AggregateError(
      cleanupErrors,
      "Windows Job Object wrapper termination produced multiple cleanup errors."
    );
    aggregateError.cause = cleanupErrors.at(-1);
    throw aggregateError;
  }
}

async function failAfterForcingWrapperExit(
  child: ChildProcess,
  control: WindowsProcessControl,
  originalError: unknown,
  aggregateMessage: string
): Promise<never> {
  try {
    await forceAndWaitForWrapperExit(child, control);
  } catch (cleanupError) {
    const cleanupErrors: readonly unknown[] = cleanupError instanceof AggregateError ?
      cleanupError.errors as readonly unknown[] :
      [cleanupError];
    const aggregateError = new AggregateError(
      [originalError, ...cleanupErrors],
      aggregateMessage
    );
    aggregateError.cause = cleanupErrors.at(-1);
    throw aggregateError;
  }
  throw originalError;
}

export async function requestWindowsManagedProcessTermination(
  child: ChildProcess
): Promise<void> {
  const control = controlFor(child);
  try {
    await writeFile(control.cancellationPath, "CANCEL", { encoding: "utf8" });
  } catch (error) {
    await failAfterForcingWrapperExit(
      child,
      control,
      error,
      "Windows cancellation marker creation and wrapper cleanup both failed."
    );
  }
  await waitForWindowsManagedProcessContainment(child);
}

export async function waitForWindowsManagedProcessContainment(
  child: ChildProcess,
  confirmationTimeoutMs = CONTROL_CONFIRMATION_TIMEOUT_MS
): Promise<void> {
  if (!Number.isSafeInteger(confirmationTimeoutMs) || confirmationTimeoutMs <= 0) {
    throw new TypeError("The Windows containment timeout must be a positive safe integer.");
  }
  const control = controlFor(child);
  const deadline = performance.now() + confirmationTimeoutMs;
  for (;;) {
    let confirmation: string | undefined;
    try {
      confirmation = await readContainmentConfirmation(control);
    } catch (error) {
      await failAfterForcingWrapperExit(
        child,
        control,
        error,
        "Windows containment confirmation and wrapper cleanup both failed."
      );
    }
    if (confirmation !== undefined) {
      if (confirmation !== "CONTAINED") {
        await failAfterForcingWrapperExit(
          child,
          control,
          new Error("Windows Job Object wrapper sent an invalid containment confirmation."),
          "Windows containment confirmation and wrapper cleanup both failed."
        );
      }
      if (await wrapperExitedWithin(child, WRAPPER_EXIT_TIMEOUT_MS)) {
        disposeControl(child, control);
        return;
      }
      await forceAndWaitForWrapperExit(child, control);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      // The wrapper publishes the marker immediately before it exits. If exit
      // wins the poll race, allow bounded filesystem visibility lag before
      // retiring the control directory so a durable confirmation is not
      // discarded unseen.
      try {
        confirmation = await readContainmentConfirmationAfterWrapperExit(control, deadline);
      } catch (error) {
        await failAfterForcingWrapperExit(
          child,
          control,
          error,
          "Windows containment confirmation and wrapper cleanup both failed."
        );
      }
      if (confirmation === "CONTAINED") {
        disposeControl(child, control);
        return;
      }
      if (confirmation !== undefined) {
        await failAfterForcingWrapperExit(
          child,
          control,
          new Error("Windows Job Object wrapper sent an invalid containment confirmation."),
          "Windows containment confirmation and wrapper cleanup both failed."
        );
      }
      disposeControl(child, control);
      throw new Error(
        "Windows Job Object wrapper exited before it confirmed process containment."
      );
    }
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      const timeoutError = new Error(
        `Windows Job Object wrapper did not confirm containment within ${String(confirmationTimeoutMs)} ms.`
      );
      await failAfterForcingWrapperExit(
        child,
        control,
        timeoutError,
        "Windows Job Object wrapper timed out and could not be terminated."
      );
    }
    await delay(Math.min(CONTROL_POLL_INTERVAL_MS, remainingMs));
  }
}
