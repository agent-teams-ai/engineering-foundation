import { executeManagedProcess } from "./node-process-runner.js";
import type { ManagedProcessExecutor } from "./api.js";

export function createManagedProcessExecutor(): ManagedProcessExecutor {
  return Object.freeze({ run: executeManagedProcess });
}
