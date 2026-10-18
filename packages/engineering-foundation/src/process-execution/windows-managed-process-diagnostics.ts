import { processCleanupFailure } from "./application/process-failure-policy.js";
import type { ProcessRequest } from "./api.js";

const MAXIMUM_DIAGNOSTIC_ERROR_NODES = 32;
const MAXIMUM_WRAPPER_STDERR_DIAGNOSTIC_BYTES = 64 * 1024;

export interface WrapperStderrDiagnostics {
  chunks: Buffer[];
  bytes: number;
}

export function createWrapperStderrDiagnostics(): WrapperStderrDiagnostics {
  return { chunks: [], bytes: 0 };
}

function byteView(chunk: Uint8Array): Buffer {
  return Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function copyBytes(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

/** Retains only a sliding copy of the latest Windows protocol suffix. */
export function appendWrapperStderr(
  diagnostics: WrapperStderrDiagnostics,
  chunk: Uint8Array
): void {
  const source = byteView(chunk);
  if (source.length === 0) {
    return;
  }
  if (source.length >= MAXIMUM_WRAPPER_STDERR_DIAGNOSTIC_BYTES) {
    diagnostics.chunks.splice(0);
    diagnostics.bytes = 0;
    const suffix = copyBytes(source.subarray(
      source.length - MAXIMUM_WRAPPER_STDERR_DIAGNOSTIC_BYTES
    ));
    diagnostics.chunks.push(suffix);
    diagnostics.bytes = suffix.length;
    return;
  }

  const accepted = copyBytes(source);
  diagnostics.chunks.push(accepted);
  diagnostics.bytes += accepted.length;
  while (diagnostics.bytes > MAXIMUM_WRAPPER_STDERR_DIAGNOSTIC_BYTES) {
    const overflow = diagnostics.bytes - MAXIMUM_WRAPPER_STDERR_DIAGNOSTIC_BYTES;
    const oldest = diagnostics.chunks[0];
    if (oldest === undefined) {
      diagnostics.bytes = 0;
      return;
    }
    if (oldest.length <= overflow) {
      diagnostics.chunks.shift();
      diagnostics.bytes -= oldest.length;
      continue;
    }
    // Every retained chunk was copied on admission and is at most 64 KiB.
    // A suffix view keeps that bounded owned allocation without recopying it.
    diagnostics.chunks[0] = oldest.subarray(overflow);
    diagnostics.bytes -= overflow;
  }
}

/** Forwards each observed chunk exactly once while retaining its bounded suffix. */
export async function* observeWrapperStderr(
  source: AsyncIterable<Uint8Array>,
  diagnostics: WrapperStderrDiagnostics
): AsyncIterable<Uint8Array> {
  for await (const chunk of source) {
    appendWrapperStderr(diagnostics, chunk);
    yield chunk;
  }
}

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
): ReturnType<typeof processCleanupFailure> {
  const description = describeManagedProcessCleanupFailure(error, wrapperStderr, windows);
  return processCleanupFailure(request, description, error, windows);
}
