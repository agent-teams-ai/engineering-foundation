import { executeManagedProcess } from "./node-process-runner.js";
import type { ManagedProcessExecutor } from "./api.js";

export { verifyRepositoryRuntimeExecutable } from "./node-runtime-verifier.js";

export function createManagedProcessExecutor(): ManagedProcessExecutor {
  return Object.freeze({ run: executeManagedProcess });
}
