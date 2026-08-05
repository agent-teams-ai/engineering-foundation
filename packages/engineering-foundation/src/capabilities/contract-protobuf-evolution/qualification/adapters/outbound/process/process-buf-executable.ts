import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { CapabilityInputError } from "../../../../../../capability-runtime.js";
import { executeManagedProcess } from "../../../../../../process-execution/node-process-runner.js";
import { assertNotCancelled } from "../../../../../../strict-yaml.js";
import type {
  BufExecutable,
  BufExecutionResult,
  BufInvocation
} from "../../../ports/buf-executable.js";

const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_LENGTH = 16 * 1024;
const DEFAULT_BUF_PROCESS_TIMEOUT_MS = 300_000;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true;
    }
  }
  return false;
}

function inputError(code: string, message: string, cause?: unknown): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "protobuf-buf-process",
    retryable: false
  }, cause === undefined ? undefined : { cause });
}

function assertArgument(value: unknown, index: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_ARGUMENT_LENGTH ||
    hasControlCharacter(value)
  ) {
    inputError("BUF_ARGUMENT_INVALID", `Buf argument ${index} is invalid.`);
  }
}

async function executablePath(path: unknown): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path)) {
    inputError("BUF_EXECUTABLE_PATH_INVALID", "Buf executable path must be absolute.");
  }
  const canonical = await realpath(path).catch(() =>
    inputError("BUF_EXECUTABLE_UNAVAILABLE", "Pinned Buf executable is unavailable.")
  );
  const metadata = await stat(canonical);
  if (!metadata.isFile()) {
    inputError("BUF_EXECUTABLE_INVALID", "Pinned Buf executable must be a regular file.");
  }
  return canonical;
}

async function workingDirectory(path: unknown): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path)) {
    inputError("BUF_WORKING_DIRECTORY_INVALID", "Buf working directory must be absolute.");
  }
  const canonical = await realpath(path).catch(() =>
    inputError("BUF_WORKING_DIRECTORY_UNAVAILABLE", "Buf working directory is unavailable.")
  );
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) {
    inputError("BUF_WORKING_DIRECTORY_INVALID", "Buf working directory must be a directory.");
  }
  return canonical;
}

async function execute(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<BufExecutionResult> {
  try {
    const result = await executeManagedProcess({
      command,
      args: arguments_,
      cwd,
      timeoutMs,
      ...(signal === undefined ? {} : { signal })
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    if (signal?.aborted === true) {
      inputError("EXECUTION_CANCELLED", "Buf qualification was cancelled.", error);
    }
    inputError(
      "BUF_EXECUTION_UNAVAILABLE",
      `Pinned Buf execution failed or exceeded its ${String(timeoutMs)}ms deadline.`,
      error
    );
  }
}

export class ProcessBufExecutable implements BufExecutable {
  readonly #timeoutMs: number;

  constructor(timeoutMs = DEFAULT_BUF_PROCESS_TIMEOUT_MS) {
    this.#timeoutMs = timeoutMs;
  }

  async run(
    invocation: BufInvocation,
    signal?: AbortSignal
  ): Promise<BufExecutionResult> {
    assertNotCancelled(signal);
    if (!Array.isArray(invocation.arguments) || invocation.arguments.length > MAX_ARGUMENTS) {
      inputError("BUF_ARGUMENTS_INVALID", "Buf invocation has too many arguments.");
    }
    invocation.arguments.forEach(assertArgument);
    const [command, cwd] = await Promise.all([
      executablePath(invocation.executablePath),
      workingDirectory(invocation.workingDirectory)
    ]);
    assertNotCancelled(signal);
    return execute(command, invocation.arguments, cwd, this.#timeoutMs, signal);
  }
}
