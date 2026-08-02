import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import { FoundationError } from "../errors.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner
} from "./types.js";

const DEFAULT_PROCESS_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;

function describeRequest(request: ProcessRequest): string {
  return `${request.command} ${request.args.join(" ")}`;
}

function processFailure(
  request: ProcessRequest,
  message: string,
  cause?: unknown
): FoundationError {
  return new FoundationError(
    "PROCESS_FAILED",
    `${describeRequest(request)} ${message}`,
    cause === undefined ? undefined : { cause }
  );
}

function resolveTimeout(request: ProcessRequest): number {
  const timeoutMs = request.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw processFailure(
      request,
      "requires timeoutMs to be a positive safe integer."
    );
  }
  return timeoutMs;
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  const cancellation = new AbortController();
  const exit = once(child, "exit", { signal: cancellation.signal }).then(
    () => true,
    () => false
  );
  const timeout = delay(timeoutMs, false, { signal: cancellation.signal }).catch(
    () => false
  );
  const exited = await Promise.race([exit, timeout]);
  cancellation.abort();
  return exited;
}

function signalPosixProcessTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals
): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function isPosixProcessGroupRunning(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function waitForPosixProcessGroupExit(pid: number): Promise<boolean> {
  const attempts = 20;
  const intervalMs = TERMINATION_GRACE_MS / attempts;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!isPosixProcessGroupRunning(pid)) {
      return true;
    }
    await delay(intervalMs);
  }
  return !isPosixProcessGroupRunning(pid);
}

async function terminateWindowsProcessTree(
  child: ReturnType<typeof spawn>
): Promise<void> {
  if (child.pid === undefined) {
    return;
  }
  const taskkill = spawn(
    "taskkill",
    ["/pid", String(child.pid), "/T", "/F"],
    { stdio: "ignore", windowsHide: true }
  );
  taskkill.once("error", () => {});
  if (!(await waitForExit(taskkill, TERMINATION_GRACE_MS))) {
    taskkill.kill("SIGKILL");
    await waitForExit(taskkill, TERMINATION_GRACE_MS);
  }
  if (!(await waitForExit(child, TERMINATION_GRACE_MS))) {
    child.kill("SIGKILL");
    await waitForExit(child, TERMINATION_GRACE_MS);
  }
}

async function terminateProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(child);
    return;
  }
  const processGroupId = child.pid;
  signalPosixProcessTree(child, "SIGTERM");
  if (await waitForPosixProcessGroupExit(processGroupId)) {
    return;
  }
  signalPosixProcessTree(child, "SIGKILL");
  await waitForPosixProcessGroupExit(processGroupId);
}

export class NodeProcessRunner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    const timeoutMs = resolveTimeout(request);
    if (request.signal?.aborted === true) {
      throw processFailure(request, "was cancelled before it started.", request.signal.reason);
    }
    return await new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          request.command,
          [...request.args],
          {
            cwd: request.cwd,
            detached: process.platform !== "win32",
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
          }
        );
      } catch (error) {
        reject(processFailure(request, "could not be started.", error));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let terminating = false;
      const deadlineSignal = AbortSignal.timeout(timeoutMs);

      const finish = (result: ProcessResult | FoundationError) => {
        if (settled) {
          return;
        }
        settled = true;
        deadlineSignal.removeEventListener("abort", onTimeout);
        request.signal?.removeEventListener("abort", onAbort);
        if (result instanceof FoundationError) {
          reject(result);
          return;
        }
        resolve(result);
      };

      const failAfterTermination = (failure: FoundationError) => {
        if (settled || terminating) {
          return;
        }
        terminating = true;
        void (async () => {
          try {
            await terminateProcessTree(child);
            finish(failure);
          } catch (error) {
            finish(
              processFailure(
                request,
                "could not be terminated after failure.",
                new AggregateError([failure, error], "Process execution and termination failed.")
              )
            );
          }
        })();
      };

      const onAbort = () => {
        failAfterTermination(
          processFailure(request, "was cancelled.", request.signal?.reason)
        );
      };

      const onTimeout = () => {
        failAfterTermination(
          processFailure(request, `timed out after ${timeoutMs}ms.`)
        );
      };

      const appendOutput = (
        destination: Buffer[],
        chunk: Buffer,
        stream: "stdout" | "stderr"
      ) => {
        const nextSize = (stream === "stdout" ? stdoutBytes : stderrBytes) + chunk.length;
        if (nextSize > MAX_OUTPUT_BYTES) {
          failAfterTermination(
            processFailure(
              request,
              `exceeded the ${stream} output limit of ${MAX_OUTPUT_BYTES} bytes.`
            )
          );
          return;
        }
        if (stream === "stdout") {
          stdoutBytes = nextSize;
        } else {
          stderrBytes = nextSize;
        }
        destination.push(chunk);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        appendOutput(stdout, chunk, "stdout");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        appendOutput(stderr, chunk, "stderr");
      });
      child.once("error", (error) => {
        failAfterTermination(processFailure(request, "could not be started.", error));
      });
      child.once("close", (exitCode, signal) => {
        if (terminating) {
          return;
        }
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");
        if (exitCode !== 0) {
          finish(
            processFailure(
              request,
              `failed: ${stderrText.trim() || `exit code ${String(exitCode)}${signal === null ? "" : ` (${signal})`}`}`
            )
          );
          return;
        }
        finish({ stdout: stdoutText, stderr: stderrText });
      });

      deadlineSignal.addEventListener("abort", onTimeout, { once: true });
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.signal?.aborted === true) {
        onAbort();
      }
    });
  }
}
