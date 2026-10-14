import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import {
  createNodeProcessAdapter,
  type NodeAcquireHook,
  type NodeCleanupHook,
  type NodeRetain
} from "@agent-teams/process-runtime/node";
import {
  createProcessExecutor,
  isProcessRuntimeError,
  type CompletionCause,
  type ProcessAdapter,
  type ProcessRuntimeError,
  type Request as ProcessRuntimeRequest
} from "@agent-teams/process-runtime";

import {
  processFailure,
  processExitResult,
  processExitFailure,
  processCancelled,
  processTimedOut,
  prepareProcessRequest,
  isProcessFailure
} from "./application/process-failure-policy.js";
import {
  managedProcessCleanupFailure,
  requestWindowsManagedProcessTermination,
  spawnWindowsManagedProcess,
  waitForWindowsManagedProcessContainment
} from "./windows-managed-process.js";
import {
  createWrapperStderrDiagnostics,
  observeWrapperStderr,
  type WrapperStderrDiagnostics
} from "./windows-managed-process-diagnostics.js";
import {
  NODE_EXECUTABLE_ENVIRONMENT_VARIABLE
} from "./node-runtime-verifier.js";
import type {
  ManagedProcessRequest,
  ManagedProcessResult,
  ProcessRequest,
  ProcessResult,
  ProcessRunner
} from "./api.js";

const TERMINATION_GRACE_MS = 1_000;

export interface NodeManagedProcessRequest extends ProcessRequest {
  /** Exact inherited environment for a private Node process-adapter boundary. */
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  /** Explicitly verified Node for the Windows bootstrap host. */
  readonly nodeExecutable?: string;
  /** Private environment used only to launch the trusted Windows wrapper. */
  readonly launcherEnvironment?: Readonly<NodeJS.ProcessEnv>;
}

export interface NodeManagedProcessRuntimeContext {
  /** Explicitly verified Node used by the Windows bootstrap when Bun is current. */
  readonly nodeExecutable?: string;
  /** Private environment used only to launch the trusted Windows wrapper. */
  readonly launcherEnvironment?: Readonly<NodeJS.ProcessEnv>;
}

function runtimeContext(
  environment: Readonly<NodeJS.ProcessEnv>
): NodeManagedProcessRuntimeContext {
  const nodeExecutable = environment[NODE_EXECUTABLE_ENVIRONMENT_VARIABLE];
  return Object.freeze({
    ...(nodeExecutable === undefined ? {} : { nodeExecutable }),
    launcherEnvironment: environment
  });
}

interface LaunchAbortBridge {
  readonly signal: AbortSignal;
  fail(): void;
  succeed(): void;
  dispose(): void;
}

/**
 * Holds an abort only across native launch settlement so an observed launch
 * failure keeps its existing precedence. After successful custody the bridge
 * forwards cancellation immediately and the generic executor remains the sole
 * completion arbiter.
 */
function createLaunchAbortBridge(
  source: AbortSignal | undefined
): LaunchAbortBridge {
  const controller = new AbortController();
  if (source === undefined) {
    return Object.freeze({
      signal: controller.signal,
      fail: () => undefined,
      succeed: () => undefined,
      dispose: () => undefined
    });
  }
  let state: "pending" | "failed" | "succeeded" = "pending";
  let sourceAborted = source.aborted;
  let sourceReason: unknown = source.reason;
  const onAbort = () => {
    sourceAborted = true;
    sourceReason = source.reason;
    if (state === "succeeded") {
      controller.abort(sourceReason);
    }
  };
  source.addEventListener("abort", onAbort, { once: true });
  return Object.freeze({
    signal: controller.signal,
    fail: () => {
      state = "failed";
    },
    succeed: () => {
      state = "succeeded";
      if (sourceAborted) {
        controller.abort(sourceReason);
      }
    },
    dispose: () => {
      source.removeEventListener("abort", onAbort);
    }
  });
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
  child: ChildProcess
): Promise<void> {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    // The Windows helper owns its containment, wrapper-exit and forced-wrapper
    // protocol. It is one bounded cleanup path, not a second Host exit arbiter.
    await requestWindowsManagedProcessTermination(child);
    return;
  }
  await terminatePosixProcessGroup(child.pid);
}

function normalizedEnvironment(
  environment: Readonly<NodeJS.ProcessEnv> | undefined
): Readonly<Record<string, string>> | undefined {
  if (environment === undefined) {
    return undefined;
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  ));
}

function runtimeRequest(
  request: ManagedProcessRequest,
  signal: AbortSignal | undefined
): ProcessRuntimeRequest {
  const environment = normalizedEnvironment(request.environment);
  return {
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    ...(signal === undefined ? {} : { signal }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.strictUtf8 === undefined ? {} : { strictUtf8: request.strictUtf8 }),
    ...(environment === undefined ? {} : { environment })
  };
}

function windowsRequest(
  request: ProcessRuntimeRequest,
  context: NodeManagedProcessRuntimeContext
): NodeManagedProcessRequest {
  const explicitNodeExecutable =
    context.nodeExecutable ??
    request.environment?.[NODE_EXECUTABLE_ENVIRONMENT_VARIABLE];
  return {
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    ...(request.environment === undefined
      ? {}
      : { environment: request.environment }),
    ...(explicitNodeExecutable === undefined
      ? {}
      : { nodeExecutable: explicitNodeExecutable }),
    ...(context.launcherEnvironment === undefined
      ? {}
      : { launcherEnvironment: context.launcherEnvironment })
  };
}

export function spawnNodeManagedProcess(
  request: NodeManagedProcessRequest,
  retain?: NodeRetain
): ChildProcess {
  if (process.platform === "win32") {
    return spawnWindowsManagedProcess(request, retain);
  }
  const child = spawn(request.command, [...request.args], {
    cwd: request.cwd,
    detached: true,
    ...(request.environment === undefined ? {} : { env: request.environment }),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  retain?.(child);
  return child;
}

async function cleanupManagedChild(
  child: ChildProcess,
  cause: CompletionCause
): Promise<void> {
  if (process.platform === "win32" && cause === "exited") {
    await waitForWindowsManagedProcessContainment(child);
    return;
  }
  await terminateNodeManagedProcess(child);
}

function createManagedNodeAdapter(
  context: NodeManagedProcessRuntimeContext,
  diagnostics: WrapperStderrDiagnostics,
  launchAbort: LaunchAbortBridge
): ProcessAdapter {
  const acquire: NodeAcquireHook = (request, retain) => {
    spawnNodeManagedProcess(windowsRequest(request, context), retain);
  };
  const cleanup: NodeCleanupHook = (child, cause) =>
    cleanupManagedChild(child, cause);
  const nativeAdapter = createNodeProcessAdapter({ acquire, cleanup });
  return {
    launch: async (request) => {
      let running: Awaited<ReturnType<ProcessAdapter["launch"]>>;
      try {
        running = await nativeAdapter.launch(request);
      } catch (error) {
        launchAbort.fail();
        throw error;
      }
      launchAbort.succeed();
      return {
        ...running,
        stderr: observeWrapperStderr(running.stderr, diagnostics)
      };
    }
  };
}

function mapProcessRuntimeError(
  request: ManagedProcessRequest,
  error: ProcessRuntimeError,
  diagnostics: WrapperStderrDiagnostics
): ReturnType<typeof processFailure> {
  switch (error.code) {
    case "invalid-input":
    case "launch":
      return processFailure(request, "could not be started.", error, { reason: "launch" });
    case "output-limit":
      return processFailure(request, "exceeded its captured output limit.", error, {
        reason: "output-limit"
      });
    case "invalid-output":
      return processFailure(request, "returned output that is not valid UTF-8.", error, {
        reason: "invalid-output"
      });
    case "stream":
      return processFailure(request, "experienced an output stream failure.", error, {
        reason: "stream"
      });
    case "timeout":
      return processTimedOut(request, request.timeoutMs ?? 1);
    case "cancelled":
      return processCancelled(request, "was cancelled.", request.signal?.reason);
    case "cleanup":
      return managedProcessCleanupFailure(
        request,
        error,
        diagnostics.chunks,
        process.platform === "win32"
      );
  }
}

export async function executeManagedProcess(
  request: ManagedProcessRequest,
  context: NodeManagedProcessRuntimeContext = runtimeContext(process.env)
): Promise<ManagedProcessResult> {
  prepareProcessRequest(request);
  const launchAbort = createLaunchAbortBridge(request.signal);
  const input = runtimeRequest(request, request.signal === undefined ? undefined : launchAbort.signal);
  const diagnostics = createWrapperStderrDiagnostics();
  const executor = createProcessExecutor(
    createManagedNodeAdapter(context, diagnostics, launchAbort)
  );
  try {
    const result = await executor.run(input);
    const signal = result.signal === null ? null : result.signal as NodeJS.Signals;
    const managedResult = {
      exitCode: result.exitCode ?? 1,
      signal,
      stdout: result.stdout,
      stderr: result.stderr
    };
    return processExitResult(managedResult, result.exitCode, signal);
  } catch (error) {
    if (isProcessRuntimeError(error)) {
      throw mapProcessRuntimeError(request, error, diagnostics);
    }
    if (isProcessFailure(error)) {
      throw error;
    }
    throw processFailure(request, "could not be completed.", error);
  } finally {
    launchAbort.dispose();
  }
}

export class NodeProcessRunner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    const result = await executeManagedProcess({ ...request } as ManagedProcessRequest);
    if (result.exitCode !== 0) {
      throw processExitFailure(
        request,
        `failed: ${result.stderr.trim() || `exit code ${String(result.exitCode)}${result.signal === null ? "" : ` (${result.signal})`}`}`,
        result
      );
    }
    return { stderr: result.stderr, stdout: result.stdout };
  }
}
