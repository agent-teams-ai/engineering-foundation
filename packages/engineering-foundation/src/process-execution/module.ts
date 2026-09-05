import { executeManagedProcess, NodeProcessRunner } from "./node-process-runner.js";
import type { ManagedProcessExecutor, ProcessRunner } from "./api.js";

export function createManagedProcessExecutor(): ManagedProcessExecutor {
  return Object.freeze({ run: executeManagedProcess });
}

export function createNodeProcessRunner(): ProcessRunner {
  return new NodeProcessRunner();
}
