import { execFile } from "node:child_process";

import { FoundationError } from "../errors.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner
} from "./types.js";

export class NodeProcessRunner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    return await new Promise((resolve, reject) => {
      execFile(
        request.command,
        [...request.args],
        {
          cwd: request.cwd,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(
              new FoundationError(
                "PROCESS_FAILED",
                `${request.command} ${request.args.join(" ")} failed: ${stderr.trim() || error.message}`,
                { cause: error }
              )
            );
            return;
          }
          resolve({ stdout, stderr });
        }
      );
    });
  }
}
