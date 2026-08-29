using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace AgentTeams.Foundation
{
    public static class WindowsManagedProcess
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const uint WAIT_OBJECT_0 = 0;
        private const uint WAIT_FAILED = 0xffffffff;
        private const int JobObjectBasicAccountingInformation = 1;
        private const int JobObjectExtendedLimitInformation = 9;
        private const int STD_INPUT_HANDLE = -10;
        private const int STD_OUTPUT_HANDLE = -11;
        private const int STD_ERROR_HANDLE = -12;
        private const int MAX_COMMAND_LINE_CHARACTERS = 32766;
        private static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST =
            new IntPtr(0x0002000D);

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
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
        private struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
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
        private static extern bool SetInformationJobObject(
            IntPtr job, int informationClass, IntPtr information, uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(
            IntPtr job, int informationClass, IntPtr information,
            uint informationLength, IntPtr returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcess(
            string applicationName, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
            uint creationFlags, IntPtr environment, string currentDirectory,
            ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList, int attributeCount, uint flags, ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value,
            UIntPtr size, IntPtr previousValue, IntPtr returnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

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

        private static StringBuilder BuildCommandLine(string executable, string[] arguments)
        {
            var commandLine = new StringBuilder(Quote(executable));
            foreach (var argument in arguments)
            {
                commandLine.Append(' ').Append(Quote(argument));
            }
            if (commandLine.Length > MAX_COMMAND_LINE_CHARACTERS)
            {
                throw new ArgumentException(
                    "The managed Windows process bootstrap command line exceeds " +
                    MAX_COMMAND_LINE_CHARACTERS + " characters.");
            }
            return commandLine;
        }

        private static IntPtr BuildEnvironmentBlock(string[] entries)
        {
            var copy = entries == null ? new string[0] : (string[])entries.Clone();
            Array.Sort(copy, StringComparer.OrdinalIgnoreCase);
            string previousName = null;
            foreach (var entry in copy)
            {
                var separator = entry == null ? -1 : entry.IndexOf('=');
                if (separator <= 0 || entry.IndexOf('\0') >= 0)
                {
                    throw new ArgumentException(
                        "The managed Windows process environment contains an invalid entry.");
                }
                var name = entry.Substring(0, separator);
                if (previousName != null &&
                    StringComparer.OrdinalIgnoreCase.Equals(previousName, name))
                {
                    throw new ArgumentException(
                        "The managed Windows process environment contains a duplicate name.");
                }
                previousName = name;
            }
            return Marshal.StringToHGlobalUni(string.Join("\0", copy) + "\0\0");
        }

        private static uint ActiveProcessCount(IntPtr job)
        {
            var accounting = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
            var length = Marshal.SizeOf(accounting);
            var pointer = Marshal.AllocHGlobal(length);
            try
            {
                if (!QueryInformationJobObject(
                    job, JobObjectBasicAccountingInformation,
                    pointer, (uint)length, IntPtr.Zero))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(), "QueryInformationJobObject failed");
                }
                accounting = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
                    Marshal.PtrToStructure(
                        pointer, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
                return accounting.ActiveProcesses;
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
        }

        private static void TerminateRemainingProcessesAndWait(IntPtr job)
        {
            if (ActiveProcessCount(job) > 0 && !TerminateJobObject(job, 1))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(), "TerminateJobObject failed");
            }
            var stopwatch = Stopwatch.StartNew();
            while (ActiveProcessCount(job) > 0)
            {
                if (stopwatch.ElapsedMilliseconds >= 5000)
                {
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
            if (!File.Exists(cancellationPath))
            {
                return false;
            }
            TerminateRemainingProcessesAndWait(job);
            ConfirmContainment(confirmationPath);
            return true;
        }

        private static bool LaunchSucceeded(string launchPath)
        {
            try
            {
                return File.Exists(launchPath) &&
                    File.ReadAllText(launchPath) == "STARTED";
            }
            catch (IOException)
            {
                // The host publishes the marker atomically enough for durability,
                // but Windows may briefly deny a concurrent read while it closes.
                return false;
            }
        }

        private static void ConfigureKillOnClose(IntPtr job)
        {
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            var length = Marshal.SizeOf(limits);
            var pointer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(limits, pointer, false);
                if (!SetInformationJobObject(
                    job, JobObjectExtendedLimitInformation, pointer, (uint)length))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
                }
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
        }

        public static int Run(
            string executable, string hostPath, string encodedRequest,
            string currentDirectory,
            string[] environmentEntries,
            string cancellationPath, string confirmationPath, string launchPath)
        {
            var commandLine = BuildCommandLine(
                executable, new[] { hostPath, encodedRequest });
            var job = IntPtr.Zero;
            var environmentBlock = IntPtr.Zero;
            var attributeList = IntPtr.Zero;
            var jobHandleValue = IntPtr.Zero;
            var attributeListInitialized = false;
            var assigned = false;
            var process = new PROCESS_INFORMATION();
            try
            {
                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(), "CreateJobObject failed");
                }
                ConfigureKillOnClose(job);

                var attributeListSize = IntPtr.Zero;
                InitializeProcThreadAttributeList(
                    IntPtr.Zero, 1, 0, ref attributeListSize);
                attributeList = Marshal.AllocHGlobal(attributeListSize);
                if (!InitializeProcThreadAttributeList(
                    attributeList, 1, 0, ref attributeListSize))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "InitializeProcThreadAttributeList failed");
                }
                attributeListInitialized = true;
                jobHandleValue = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobHandleValue, job);
                if (!UpdateProcThreadAttribute(
                    attributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                    jobHandleValue, new UIntPtr((uint)IntPtr.Size),
                    IntPtr.Zero, IntPtr.Zero))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "UpdateProcThreadAttribute JOB_LIST failed");
                }

                var startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = (uint)Marshal.SizeOf(startup);
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
                startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
                startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
                startup.lpAttributeList = attributeList;
                environmentBlock = BuildEnvironmentBlock(environmentEntries);
                if (!CreateProcess(
                    executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                    environmentBlock, currentDirectory, ref startup, out process))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(), "CreateProcess failed");
                }

                // PROC_THREAD_ATTRIBUTE_JOB_LIST makes Job Object membership an
                // atomic property of successful process creation. From here on,
                // closing or terminating the job contains every possible child.
                assigned = true;

                if (ResumeThread(process.hThread) == WAIT_FAILED)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(), "ResumeThread failed");
                }

                while (true)
                {
                    var waitResult = WaitForSingleObject(process.hProcess, 10);
                    if (waitResult == WAIT_OBJECT_0)
                    {
                        break;
                    }
                    if (waitResult == WAIT_FAILED)
                    {
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(), "WaitForSingleObject failed");
                    }
                    // Once the trusted host has attempted the requested launch,
                    // an already observed host failure outranks cancellation.
                    if (LaunchSucceeded(launchPath) &&
                        CancelAssignedIfRequested(cancellationPath, confirmationPath, job))
                    {
                        return 0;
                    }
                }

                uint exitCode;
                if (!GetExitCodeProcess(process.hProcess, out exitCode))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
                }
                TerminateRemainingProcessesAndWait(job);
                ConfirmContainment(confirmationPath);
                return unchecked((int)exitCode);
            }
            catch (Exception executionError)
            {
                try
                {
                    if (assigned)
                    {
                        TerminateRemainingProcessesAndWait(job);
                    }
                    ConfirmContainment(confirmationPath);
                }
                catch (Exception containmentError)
                {
                    throw new AggregateException(
                        "Windows process execution and containment both failed",
                        executionError, containmentError);
                }
                throw;
            }
            finally
            {
                if (process.hThread != IntPtr.Zero)
                {
                    CloseHandle(process.hThread);
                }
                if (process.hProcess != IntPtr.Zero)
                {
                    CloseHandle(process.hProcess);
                }
                if (jobHandleValue != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(jobHandleValue);
                }
                if (environmentBlock != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(environmentBlock);
                }
                if (attributeListInitialized)
                {
                    DeleteProcThreadAttributeList(attributeList);
                }
                if (attributeList != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(attributeList);
                }
                if (job != IntPtr.Zero)
                {
                    CloseHandle(job);
                }
            }
        }
    }
}
