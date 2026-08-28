import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export interface WindowsManagedProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
}

const WINDOWS_BOOTSTRAP_PATH = fileURLToPath(
  new URL("../../assets/windows-managed-process/bootstrap.ps1", import.meta.url)
);
const PROCESS_HOST_PATH = fileURLToPath(
  new URL("./windows-process-host.js", import.meta.url)
);
const MAX_WINDOWS_COMMAND_LINE_CHARACTERS = 32_766;
const CONTROL_CONFIRMATION_TIMEOUT_MS = 30_000;
const CONTROL_POLL_INTERVAL_MS = 10;

// The packaged native helper owns the JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
// contract. Its TerminateRemainingProcessesAndWait(job) path confirms that
// while (ActiveProcessCount(job) > 0) is false before reporting containment.

interface WindowsProcessControl {
  readonly cancellationPath: string;
  readonly confirmationPath: string;
  readonly root: string;
}

const windowsProcessControls = new WeakMap<ChildProcess, WindowsProcessControl>();

function createControl(): WindowsProcessControl {
  const root = mkdtempSync(join(tmpdir(), "agent-teams-foundation-process-"));
  return {
    cancellationPath: join(root, "cancel"),
    confirmationPath: join(root, "contained"),
    root
  };
}

function disposeControl(child: ChildProcess, control: WindowsProcessControl): void {
  windowsProcessControls.delete(child);
  rmSync(control.root, { force: true, recursive: true });
}

function disposeControlAfterWrapperExit(child: ChildProcess, control: WindowsProcessControl): void {
  const disposeAfterExit = () => disposeControl(child, control);
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
 * The request crosses the PowerShell boundary only as JSON on stdin. The
 * native helper atomically creates the Node process host in its Job Object;
 * only that contained host can launch the requested command.
 */
export function spawnWindowsManagedProcess(
  request: WindowsManagedProcessRequest
): ChildProcess {
  const encodedRequest = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    command: request.command,
    args: [...request.args],
    cwd: request.cwd
  })).toString("base64url");
  assertWindowsCommandLineFits(process.execPath, [PROCESS_HOST_PATH, encodedRequest]);
  const control = createControl();
  let child: ChildProcess;
  try {
    child = spawn(
      "powershell.exe",
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
        cwd: request.cwd,
        ...(request.environment === undefined ? {} : { env: request.environment }),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );
  } catch (error) {
    rmSync(control.root, { force: true, recursive: true });
    throw error;
  }
  windowsProcessControls.set(child, control);
  child.once("error", () => cleanUpWindowsManagedProcessLaunchFailure(child));
  const bootstrapInput = child.stdin;
  if (bootstrapInput === null) {
    disposeControl(child, control);
    throw new Error("Windows Job Object wrapper did not expose its bootstrap input.");
  }
  bootstrapInput.once("error", () => {
    // The wrapper's process error is reported through its own error event.
  });
  bootstrapInput.end(JSON.stringify({
    schemaVersion: 1,
    nodeExecutable: process.execPath,
    processHostPath: PROCESS_HOST_PATH,
    encodedRequest,
    cwd: request.cwd,
    cancellationPath: control.cancellationPath,
    confirmationPath: control.confirmationPath
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

function controlFor(child: ChildProcess): WindowsProcessControl {
  const control = windowsProcessControls.get(child);
  if (control === undefined) {
    throw new Error("The Windows process is not owned by the managed-process adapter.");
  }
  return control;
}

async function forceAndWaitForWrapperExit(
  child: ChildProcess,
  control: WindowsProcessControl
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, "exit");
    let terminationRequested: boolean;
    try {
      terminationRequested = child.kill("SIGKILL");
    } catch (error) {
      disposeControlAfterWrapperExit(child, control);
      throw error;
    }
    if (!terminationRequested && child.exitCode === null && child.signalCode === null) {
      disposeControlAfterWrapperExit(child, control);
      throw new Error("Windows Job Object wrapper could not be terminated.");
    }
    try {
      await exit;
    } catch (error) {
      disposeControlAfterWrapperExit(child, control);
      throw error;
    }
  }
  disposeControl(child, control);
}

export async function requestWindowsManagedProcessTermination(
  child: ChildProcess
): Promise<void> {
  const control = controlFor(child);
  await writeFile(control.cancellationPath, "CANCEL", { encoding: "utf8" });
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
  const deadline = Date.now() + confirmationTimeoutMs;
  for (;;) {
    try {
      const confirmation = await readFile(control.confirmationPath, "utf8");
      if (confirmation !== "CONTAINED") {
        throw new Error("Windows Job Object wrapper sent an invalid containment confirmation.");
      }
      disposeControl(child, control);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        disposeControlAfterWrapperExit(child, control);
        throw error;
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      disposeControl(child, control);
      throw new Error(
        "Windows Job Object wrapper exited before it confirmed process containment."
      );
    }
    if (Date.now() >= deadline) {
      const timeoutError = new Error(
        `Windows Job Object wrapper did not confirm containment within ${String(confirmationTimeoutMs)} ms.`
      );
      try {
        await forceAndWaitForWrapperExit(child, control);
      } catch (terminationError) {
        throw new AggregateError(
          [timeoutError, terminationError],
          "Windows Job Object wrapper timed out and could not be terminated."
        );
      }
      throw timeoutError;
    }
    await delay(CONTROL_POLL_INTERVAL_MS);
  }
}
