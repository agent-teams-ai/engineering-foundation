import { associateProcessFailureFacts, readProcessFailureFacts, type ProcessFailureFacts } from "../../features/validation-reporting/process-failure-facts.js";
import { FoundationError } from "../../features/validation-reporting/api.js";
import { ProcessCancellationError, ProcessTimeoutError } from "./errors.js";
import type { ManagedProcessResult, ProcessRequest } from "./process.js";

const MAX_PROCESS_TIMEOUT_MS = 2_147_483_647;

function describeRequest(request: ProcessRequest): string {
  return `${request.command} ${request.args.join(" ")}`;
}

export function processFailure(
  request: ProcessRequest,
  message: string,
  cause?: unknown,
  facts?: ProcessFailureFacts
): FoundationError {
  const failure = new FoundationError(
    "PROCESS_FAILED",
    `${describeRequest(request)} ${message}`,
    cause === undefined ? undefined : { cause }
  );
  associateProcessFailureFacts(failure, facts);
  return failure;
}

export function processCancelled(
  request: ProcessRequest,
  message: string,
  cause?: unknown
): FoundationError {
  return new ProcessCancellationError(
    `${describeRequest(request)} ${message}`,
    cause === undefined ? undefined : { cause }
  );
}

export function processTimedOut(
  request: ProcessRequest,
  timeoutMs: number
): ProcessTimeoutError {
  return new ProcessTimeoutError(timeoutMs, {
    requestDescription: describeRequest(request)
  });
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

export function prepareProcessRequest(request: ProcessRequest): number | undefined {
  const timeoutMs = resolveTimeout(request);
  assertProcessCanStart(request);
  return timeoutMs;
}

export function isProcessFailure(error: unknown): error is FoundationError {
  return error instanceof FoundationError;
}

export function processCleanupFailure(request: ProcessRequest, description: string, error: unknown, windows: boolean): FoundationError {
  const requestDescription = describeRequest(request);
  const failure = new FoundationError(
    "PROCESS_FAILED",
    windows ? `${description} ${requestDescription}` : `${requestDescription} ${description}`,
    { cause: error }
  );
  associateProcessFailureFacts(failure, { reason: "cleanup" });
  return failure;
}

export function processExitResult(result: ManagedProcessResult, exitCode: number | null, signal: NodeJS.Signals | null): ManagedProcessResult {
  associateProcessFailureFacts(result, {
    reason: "exit",
    ...(exitCode === null ? {} : { exitCode }),
    ...(signal === null ? {} : { signal })
  });
  return result;
}

export function processExitFailure(request: ProcessRequest, message: string, result: ManagedProcessResult): FoundationError {
  return processFailure(request, message, undefined, readProcessFailureFacts(result));
}
