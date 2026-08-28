import { spawn, type ChildProcess } from "node:child_process";
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

const PROCESS_HOST_PATH = fileURLToPath(
  new URL("./windows-process-host.js", import.meta.url)
);
const MAX_ENCODED_REQUEST_CHARACTERS = 24_000;
const CONTROL_CONFIRMATION_TIMEOUT_MS = 30_000;
const CONTROL_POLL_INTERVAL_MS = 10;

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

const WINDOWS_JOB_RUNNER = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Add-Type -TypeDefinition @'
using System; using System.ComponentModel; using System.Diagnostics;
using System.IO; using System.Runtime.InteropServices; using System.Text; using System.Threading;

public static class AgentTeamsFoundationJobRunner
{
    private const uint CREATE_SUSPENDED = 0x00000004, STARTF_USESTDHANDLES = 0x00000100,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 0x00000102, WAIT_FAILED = 0xffffffff;
    private const int JobObjectBasicAccountingInformation = 1, JobObjectExtendedLimitInformation = 9;
    private const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength, IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
        uint creationFlags, IntPtr environment, string currentDirectory,
        ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
        {
            return value;
        }
        var output = new StringBuilder("\"");
        var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                slashes += 1;
                continue;
            }
            if (character == '"')
            {
                output.Append('\\', slashes * 2 + 1);
                output.Append(character);
                slashes = 0;
                continue;
            }
            output.Append('\\', slashes);
            slashes = 0;
            output.Append(character);
        }
        output.Append('\\', slashes * 2);
        output.Append('"');
        return output.ToString();
    }

    private static void TerminateProcessAndWait(IntPtr process)
    {
        var initialWait = WaitForSingleObject(process, 0);
        if (initialWait == WAIT_FAILED) {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "WaitForSingleObject failed before suspended process termination");
        }
        if (initialWait == WAIT_TIMEOUT && !TerminateProcess(process, 1)) {
            var errorCode = Marshal.GetLastWin32Error();
            if (WaitForSingleObject(process, 0) != WAIT_OBJECT_0) {
                throw new Win32Exception(errorCode, "TerminateProcess failed");
            }
        }
        var terminated = WaitForSingleObject(process, 5000);
        if (terminated == WAIT_TIMEOUT) {
            throw new TimeoutException(
                "Suspended Windows process did not terminate within 5000 ms");
        }
        if (terminated == WAIT_FAILED) {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "WaitForSingleObject failed after suspended process termination");
        }
    }

    private static uint ActiveProcessCount(IntPtr job)
    {
        var accounting = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
        var length = Marshal.SizeOf(accounting);
        var pointer = Marshal.AllocHGlobal(length);
        try
        {
            if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                pointer, (uint)length, IntPtr.Zero))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "QueryInformationJobObject failed");
            }
            accounting = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
                Marshal.PtrToStructure(pointer, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            return accounting.ActiveProcesses;
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    private static void TerminateRemainingProcessesAndWait(IntPtr job)
    {
        if (ActiveProcessCount(job) > 0 && !TerminateJobObject(job, 1)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "TerminateJobObject failed");
        }
        var stopwatch = Stopwatch.StartNew();
        while (ActiveProcessCount(job) > 0) {
            if (stopwatch.ElapsedMilliseconds >= 5000) {
                throw new TimeoutException(
                    "Windows Job Object descendants did not terminate within 5000 ms");
            }
            Thread.Sleep(10);
        }
    }

    private static void TerminateAssignedJobAndWait(IntPtr job)
    {
        if (!TerminateJobObject(job, 1)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "TerminateJobObject failed");
        }
        var stopwatch = Stopwatch.StartNew();
        while (ActiveProcessCount(job) > 0) {
            if (stopwatch.ElapsedMilliseconds >= 5000) {
                throw new TimeoutException(
                    "Windows Job Object descendants did not terminate within 5000 ms");
            }
            Thread.Sleep(10);
        }
    }

    private static void ConfirmContainment(string confirmationPath)
    {
        var temporaryPath = confirmationPath + ".tmp";
        File.WriteAllText(temporaryPath, "CONTAINED", new UTF8Encoding(false));
        File.Move(temporaryPath, confirmationPath);
    }

    private static bool CancelAssignedIfRequested(
        string cancellationPath, string confirmationPath, IntPtr job)
    {
        if (!File.Exists(cancellationPath)) return false;
        TerminateAssignedJobAndWait(job);
        ConfirmContainment(confirmationPath);
        return true;
    }

    public static int Run(
        string executable, string hostPath, string currentDirectory,
        string encodedRequest, string cancellationPath, string confirmationPath)
    {
        var job = IntPtr.Zero;
        var assigned = false;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(
                Marshal.GetLastWin32Error(), "CreateJobObject failed");

            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            var length = Marshal.SizeOf(limits);
            var limitsPointer = Marshal.AllocHGlobal(length);
            try {
                Marshal.StructureToPtr(limits, limitsPointer, false);
                if (!SetInformationJobObject(
                    job, JobObjectExtendedLimitInformation, limitsPointer, (uint)length)) {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
                }
            } finally { Marshal.FreeHGlobal(limitsPointer); }

            if (File.Exists(cancellationPath)) {
                ConfirmContainment(confirmationPath); return 1;
            }

            var startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(startup);
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
            var commandLine = new StringBuilder(
                Quote(executable) + " " + Quote(hostPath) + " " + Quote(encodedRequest));
            if (!CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED, IntPtr.Zero, currentDirectory, ref startup, out process)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed");
            }

            if (File.Exists(cancellationPath)) {
                TerminateProcessAndWait(process.hProcess);
                ConfirmContainment(confirmationPath); return 1;
            }

            if (!AssignProcessToJobObject(job, process.hProcess)) {
                var errorCode = Marshal.GetLastWin32Error();
                TerminateProcessAndWait(process.hProcess);
                throw new Win32Exception(errorCode, "AssignProcessToJobObject failed");
            }
            assigned = true;

            if (CancelAssignedIfRequested(cancellationPath, confirmationPath, job)) return 1;

            if (ResumeThread(process.hThread) == WAIT_FAILED) throw new Win32Exception(
                Marshal.GetLastWin32Error(), "ResumeThread failed");

            while (true) {
                if (CancelAssignedIfRequested(
                    cancellationPath, confirmationPath, job)) return 1;
                var waitResult = WaitForSingleObject(process.hProcess, 10);
                if (waitResult == WAIT_OBJECT_0) break;
                if (waitResult == WAIT_FAILED) {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(), "WaitForSingleObject failed");
                }
            }

            if (CancelAssignedIfRequested(cancellationPath, confirmationPath, job)) return 1;

            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw new Win32Exception(
                Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
            TerminateRemainingProcessesAndWait(job);
            if (CancelAssignedIfRequested(cancellationPath, confirmationPath, job)) return 1;
            ConfirmContainment(confirmationPath);
            return unchecked((int)exitCode);
        } catch (Exception executionError) {
            try {
                if (assigned) TerminateAssignedJobAndWait(job);
                else if (process.hProcess != IntPtr.Zero) TerminateProcessAndWait(process.hProcess);
                ConfirmContainment(confirmationPath);
            } catch (Exception containmentError) {
                throw new AggregateException(
                    "Windows process execution and containment both failed",
                    executionError, containmentError);
            }
            throw;
        } finally {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
'@

try {
  $bootstrapRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $exitCode = [AgentTeamsFoundationJobRunner]::Run(
    [string]$bootstrapRequest.nodeExecutable,
    [string]$bootstrapRequest.processHostPath,
    (Get-Location).Path,
    [string]$bootstrapRequest.encodedRequest,
    [string]$bootstrapRequest.cancellationPath,
    [string]$bootstrapRequest.confirmationPath)
  exit $exitCode
} catch {
  [Console]::Error.WriteLine("Windows Job Object runner failed: " + $_.Exception.Message)
  exit 1
}
`;

const ENCODED_WINDOWS_JOB_RUNNER = Buffer.from(
  WINDOWS_JOB_RUNNER,
  "utf16le"
).toString("base64");

/**
 * Starts a suspended Node host, assigns it to a kill-on-close Windows Job
 * Object, and only then allows it to launch the requested command. The Job
 * Object is the containment boundary for every descendant.
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
  if (encodedRequest.length > MAX_ENCODED_REQUEST_CHARACTERS) {
    throw new Error(
      `The managed Windows process request exceeds ${MAX_ENCODED_REQUEST_CHARACTERS} encoded characters.`
    );
  }
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
        "-EncodedCommand",
        ENCODED_WINDOWS_JOB_RUNNER
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
    nodeExecutable: process.execPath,
    processHostPath: PROCESS_HOST_PATH,
    encodedRequest,
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
      disposeControlAfterWrapperExit(child, control);
      throw new Error(
        `Windows Job Object wrapper did not confirm containment within ${String(confirmationTimeoutMs)} ms.`
      );
    }
    await delay(CONTROL_POLL_INTERVAL_MS);
  }
}
