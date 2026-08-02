import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { CapabilityInputError } from "../../../../../../capability-runtime.js";
import { assertNotCancelled } from "../../../../../../strict-yaml.js";
import type {
  BufExecutable,
  BufExecutionResult,
  BufInvocation
} from "../../../ports/buf-executable.js";

const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_LENGTH = 16 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true;
    }
  }
  return false;
}

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "protobuf-buf-process",
    retryable: false
  });
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

function execute(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  signal?: AbortSignal
): Promise<BufExecutionResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...arguments_],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: false,
        signal,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        if (signal?.aborted === true) {
          reject(
            new CapabilityInputError({
              code: "EXECUTION_CANCELLED",
              message: "Foundation check was cancelled.",
              phase: "protobuf-buf-process",
              retryable: false
            })
          );
          return;
        }
        const exitCode =
          typeof (error as { readonly code?: unknown }).code === "number"
            ? (error as { readonly code: number }).code
            : undefined;
        if (exitCode !== undefined) {
          resolve({ exitCode, stdout, stderr });
          return;
        }
        reject(
          new CapabilityInputError(
            {
              code: "BUF_EXECUTION_UNAVAILABLE",
              message: "Pinned Buf executable could not be started.",
              phase: "protobuf-buf-process",
              retryable: false
            },
            { cause: error }
          )
        );
      }
    );
  });
}

export class ProcessBufExecutable implements BufExecutable {
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
    return execute(command, invocation.arguments, cwd, signal);
  }
}
