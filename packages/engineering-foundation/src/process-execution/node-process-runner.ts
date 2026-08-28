import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import { FoundationError } from "../errors.js";
import {
  cleanUpWindowsManagedProcessLaunchFailure,
  requestWindowsManagedProcessTermination,
  spawnWindowsManagedProcess,
  waitForWindowsManagedProcessContainment
} from "./windows-managed-process.js";
import type {
  ManagedProcessResult,
  ProcessRequest,
  ProcessResult,
  ProcessRunner
} from "./types.js";

const MAX_PROCESS_TIMEOUT_MS = 2_147_483_647;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;

interface ManagedProcessRequest extends ProcessRequest {
  /** Reject process output that is not well-formed UTF-8 instead of replacing bytes. */
  readonly strictUtf8?: boolean;
}

export interface NodeManagedProcessRequest extends ProcessRequest {
  /** Exact inherited environment for a private Node process-adapter boundary. */
  readonly environment?: NodeJS.ProcessEnv;
}

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

export class ProcessCancellationError extends FoundationError {
  constructor(message: string, options?: ErrorOptions) {
    super("PROCESS_FAILED", message, options);
    this.name = "ProcessCancellationError";
  }
}

function processCancelled(
  request: ProcessRequest,
  message: string,
  cause?: unknown
): FoundationError {
  return new ProcessCancellationError(
    `${describeRequest(request)} ${message}`,
    cause === undefined ? undefined : { cause }
  );
}

function resolveTimeout(request: ProcessRequest): number | undefined {
  const timeoutMs = request.timeoutMs;
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_PROCESS_TIMEOUT_MS
  ) {
    throw processFailure(
      request,
      `requires timeoutMs to be a positive integer no greater than ${MAX_PROCESS_TIMEOUT_MS}.`
    );
  }
  return timeoutMs;
}

function assertProcessCanStart(request: ProcessRequest): void {
  if (request.signal?.aborted === true) {
    throw processCancelled(
      request,
      "was cancelled before it started.",
      request.signal.reason
    );
  }
}

function prepareProcessRequest(request: ProcessRequest): number | undefined {
  const timeoutMs = resolveTimeout(request);
  assertProcessCanStart(request);
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

function isMissingProcessGroupError(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    error.code === "ESRCH";
}

function signalPosixProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!isMissingProcessGroupError(error)) {
      throw error;
    }
  }
}

function isPosixProcessGroupRunning(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcessGroupError(error);
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
  // The wrapper owns both the suspended pre-assignment handle and the assigned
  // Job Object. It confirms the applicable containment boundary is empty before
  // the outer process may treat wrapper exit as safe.
  await requestWindowsManagedProcessTermination(child);
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (await waitForExit(child, TERMINATION_GRACE_MS)) {
    return;
  }
  // Containment is already confirmed, so forcing a stuck wrapper cannot orphan
  // the suspended host or any assigned Job Object descendant.
  child.kill("SIGKILL");
  if (!await waitForExit(child, TERMINATION_GRACE_MS)) {
    throw new Error("Windows Job Object wrapper did not exit after forced shutdown.");
  }
}

export async function terminatePosixProcessGroup(
  processGroupId: number
): Promise<void> {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    throw new TypeError("A POSIX process group ID must be a positive safe integer.");
  }
  signalPosixProcessGroup(processGroupId, "SIGTERM");
  if (await waitForPosixProcessGroupExit(processGroupId)) {
    return;
  }
  signalPosixProcessGroup(processGroupId, "SIGKILL");
  if (!await waitForPosixProcessGroupExit(processGroupId)) {
    throw new Error(
      `POSIX process group ${String(processGroupId)} did not exit after forced shutdown.`
    );
  }
}

export async function terminateNodeManagedProcess(
  child: ReturnType<typeof spawn>
): Promise<void> {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(child);
    return;
  }
  await terminatePosixProcessGroup(child.pid);
}

async function waitForCloseWithinCleanupDeadline(
  closed: Promise<unknown>
): Promise<void> {
  const cancellation = new AbortController();
  const cleanupDeadline = delay(
    TERMINATION_GRACE_MS,
    undefined,
    { signal: cancellation.signal }
  ).then(() => {
    throw new Error("Process streams did not close after tree termination.");
  });
  try {
    await Promise.race([closed, cleanupDeadline]);
  } finally {
    cancellation.abort();
  }
}

export function spawnNodeManagedProcess(
  request: NodeManagedProcessRequest
): ReturnType<typeof spawn> {
  if (process.platform === "win32") {
    return spawnWindowsManagedProcess(request);
  }
  return spawn(request.command, [...request.args], {
    cwd: request.cwd,
    detached: true,
    ...(request.environment === undefined ? {} : { env: request.environment }),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

async function cleanUpAfterNormalExit(
  child: ReturnType<typeof spawn>
): Promise<void> {
  if (process.platform === "win32") {
    await waitForWindowsManagedProcessContainment(child);
    return;
  }
  await terminateNodeManagedProcess(child);
}

function decodeProcessOutput(
  request: ManagedProcessRequest,
  stdout: readonly Buffer[],
  stderr: readonly Buffer[]
): { readonly stdout: string; readonly stderr: string } | FoundationError {
  const decode = (chunks: readonly Buffer[]) => {
    const bytes = Buffer.concat(chunks);
    const text = bytes.toString("utf8");
    if (request.strictUtf8 === true && !Buffer.from(text, "utf8").equals(bytes)) {
      throw new TypeError("Process output is not valid UTF-8.");
    }
    return text;
  };
  try {
    return { stdout: decode(stdout), stderr: decode(stderr) };
  } catch (error) {
    return processFailure(
      request,
      "returned output that is not valid UTF-8.",
      error
    );
  }
}

export async function executeManagedProcess(
  request: ManagedProcessRequest
): Promise<ManagedProcessResult> {
    const timeoutMs = prepareProcessRequest(request);
    return await new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawnNodeManagedProcess(request);
      } catch (error) {
        reject(processFailure(request, "could not be started.", error));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const closed = once(child, "close").catch(() => []);
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let terminating = false;
      let completionFailure: FoundationError | undefined;
      const deadlineSignal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);

      const finish = (result: ManagedProcessResult | FoundationError) => {
        if (settled) {
          return;
        }
        settled = true;
        deadlineSignal?.removeEventListener("abort", onTimeout);
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
            await terminateNodeManagedProcess(child);
            await waitForCloseWithinCleanupDeadline(closed);
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
          processCancelled(request, "was cancelled.", request.signal?.reason)
        );
      };

      const onTimeout = () => {
        failAfterTermination(
          processFailure(request, `timed out after ${String(timeoutMs)}ms.`)
        );
      };

      const completeAfterExit = (
        exitCode: number | null,
        signal: NodeJS.Signals | null
      ) => {
        if (settled || terminating) {
          return;
        }
        terminating = true;
        deadlineSignal?.removeEventListener("abort", onTimeout);
        request.signal?.removeEventListener("abort", onAbort);
        void (async () => {
          try {
            await cleanUpAfterNormalExit(child);
            await waitForCloseWithinCleanupDeadline(closed);
          } catch (error) {
            finish(
              processFailure(
                request,
                "could not clean up its process tree after exit.",
                error
              )
            );
            return;
          }
          const decoded = decodeProcessOutput(request, stdout, stderr);
          if (decoded instanceof FoundationError) {
            finish(decoded);
            return;
          }
          if (completionFailure !== undefined) {
            finish(completionFailure);
            return;
          }
          finish({
            exitCode: exitCode ?? 1,
            signal,
            stdout: decoded.stdout,
            stderr: decoded.stderr
          });
        })();
      };

      const appendOutput = (
        destination: Buffer[],
        chunk: Buffer,
        stream: "stdout" | "stderr"
      ) => {
        const nextSize = (stream === "stdout" ? stdoutBytes : stderrBytes) + chunk.length;
        if (nextSize > MAX_OUTPUT_BYTES) {
          const failure = processFailure(
            request,
            `exceeded the ${stream} output limit of ${MAX_OUTPUT_BYTES} bytes.`
          );
          if (terminating) {
            completionFailure ??= failure;
            return;
          }
          failAfterTermination(failure);
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
        cleanUpWindowsManagedProcessLaunchFailure(child);
        failAfterTermination(processFailure(request, "could not be started.", error));
      });
      child.once("exit", completeAfterExit);

      deadlineSignal?.addEventListener("abort", onTimeout, { once: true });
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.signal?.aborted === true) {
        onAbort();
      }
    });
}

export class NodeProcessRunner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    const result = await executeManagedProcess(request);
    if (result.exitCode !== 0) {
      throw processFailure(
        request,
        `failed: ${result.stderr.trim() || `exit code ${String(result.exitCode)}${result.signal === null ? "" : ` (${result.signal})`}`}`
      );
    }
    return { stderr: result.stderr, stdout: result.stdout };
  }
}
