const MAXIMUM_DIAGNOSTIC_ERROR_NODES = 32;
const MAXIMUM_WRAPPER_STDERR_DIAGNOSTIC_BYTES = 64 * 1024;

const WINDOWS_CONTAINMENT_FAILURE_MESSAGES = [
  ["invalid-confirmation", "Windows Job Object wrapper sent an invalid containment confirmation."],
  [
    "wrapper-exited-before-confirmation",
    "Windows Job Object wrapper exited before it confirmed process containment."
  ],
  ["wrapper-confirmation-timeout", "Windows Job Object wrapper did not confirm containment within "],
  ["wrapper-exit-timeout", "Windows Job Object wrapper did not exit within "]
] as const;

const WINDOWS_CONTAINMENT_FILESYSTEM_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EISDIR",
  "EPERM"
]);

function candidateFailureReason(candidate: unknown): string | undefined {
  try {
    if (!(candidate instanceof Error)) {
      return undefined;
    }
    for (const [reason, message] of WINDOWS_CONTAINMENT_FAILURE_MESSAGES) {
      if (candidate.message.startsWith(message)) {
        return reason;
      }
    }
    const code = "code" in candidate ? candidate.code : undefined;
    return typeof code === "string" && WINDOWS_CONTAINMENT_FILESYSTEM_CODES.has(code)
      ? `confirmation-read-${code}`
      : undefined;
  } catch {
    return undefined;
  }
}

function enqueueRelatedFailures(
  candidate: unknown,
  pending: unknown[],
  maximum: number
): void {
  try {
    if (candidate instanceof AggregateError && Array.isArray(candidate.errors)) {
      const limit = Math.min(candidate.errors.length, maximum);
      for (let index = 0; index < limit; index += 1) {
        pending.push(candidate.errors[index] as unknown);
      }
    }
    if (candidate instanceof Error) {
      pending.push(candidate.cause);
    }
  } catch {
    // Diagnostics must never replace the original cleanup failure.
  }
}

function windowsContainmentFailureReason(error: unknown): string {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0 && seen.size < MAXIMUM_DIAGNOSTIC_ERROR_NODES) {
    const candidate = pending.shift();
    if (candidate === undefined || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const reason = candidateFailureReason(candidate);
    if (reason !== undefined) {
      return reason;
    }
    enqueueRelatedFailures(
      candidate,
      pending,
      Math.max(0, MAXIMUM_DIAGNOSTIC_ERROR_NODES - seen.size - pending.length)
    );
  }
  return "unknown";
}

function boundedWrapperStderrSuffix(chunks: readonly Buffer[]): string {
  const selected: Buffer[] = [];
  let remaining = MAXIMUM_WRAPPER_STDERR_DIAGNOSTIC_BYTES;
  for (let index = chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = chunks[index];
    if (chunk === undefined) {
      continue;
    }
    const suffix = chunk.subarray(Math.max(0, chunk.length - remaining));
    selected.unshift(suffix);
    remaining -= suffix.length;
  }
  return Buffer.concat(selected).toString("utf8");
}

function finalWrapperFailurePhase(stderr: string): string {
  const matches = stderr.matchAll(
    /(?:^|\r?\n)Windows Job Object runner failed \[phase=(helper-source-read|helper-compile|helper-load|bootstrap-request|managed-run)\]:/gu
  );
  let phase = "unreported";
  for (const match of matches) {
    phase = match[1] ?? phase;
  }
  return phase;
}

export function describeManagedProcessCleanupFailure(
  error: unknown,
  wrapperStderr: readonly Buffer[],
  windows: boolean
): string {
  if (!windows) {
    return "could not clean up its process tree after exit.";
  }
  try {
    const wrapperPhase = finalWrapperFailurePhase(boundedWrapperStderrSuffix(wrapperStderr));
    return `could not clean up its process tree after exit. [windows-containment=${windowsContainmentFailureReason(error)};wrapper-phase=${wrapperPhase}]`;
  } catch {
    return "could not clean up its process tree after exit. [windows-containment=unknown;wrapper-phase=unreported]";
  }
}

export function managedProcessCleanupFailure(
  request: ProcessRequest,
  error: unknown,
  wrapperStderr: readonly Buffer[],
  windows: boolean
): FoundationError {
  const description = describeManagedProcessCleanupFailure(error, wrapperStderr, windows);
  const requestDescription = `${request.command} ${request.args.join(" ")}`;
  return new FoundationError(
    "PROCESS_FAILED",
    windows ? `${description} ${requestDescription}` : `${requestDescription} ${description}`,
    { cause: error }
  );
}
import { FoundationError } from "../local-mode/application/errors/foundation-error.js";
import type { ProcessRequest } from "./types.js";
