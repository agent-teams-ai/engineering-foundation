import { execFile } from "node:child_process";

import { FoundationError } from "../../../../../errors.js";

const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface ProcessExecution {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function execute(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly signal?: AbortSignal;
  }
): Promise<ProcessExecution> {
  return await new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        if (error.name === "AbortError") {
          reject(
            new FoundationError("PROCESS_FAILED", "Agent workflow execution was cancelled.", {
              cause: error
            })
          );
          return;
        }
        if (typeof error.code === "number") {
          resolve({ exitCode: error.code, stdout, stderr });
          return;
        }
        reject(
          new FoundationError(
            "PROCESS_FAILED",
            `Unable to execute ${command}: ${stderr.trim() || error.message}`,
            { cause: error }
          )
        );
      }
    );
  });
}
