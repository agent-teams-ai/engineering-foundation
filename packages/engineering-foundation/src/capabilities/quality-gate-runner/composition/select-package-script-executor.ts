import type { RepositoryPackageManager } from "../../../process-execution/application/runtime-selection.js";
import { selectClosedPackageManager } from "../../../process-execution/application/runtime-selection.js";
import type { PackageScriptExecutor } from "../application/ports/package-script-executor.js";

export interface PackageScriptExecutorCandidates {
  readonly bun?: PackageScriptExecutor;
  readonly pnpm?: PackageScriptExecutor;
}

/**
 * The application request carries the validated profile manager. This outer
 * switch is the only dispatch seam and performs no task effect itself.
 */
export function createPackageManagerScriptExecutor(
  candidates: PackageScriptExecutorCandidates
): PackageScriptExecutor {
  return Object.freeze({
    async run(input: {
      readonly packageManager: RepositoryPackageManager;
      readonly consumerRoot: string;
      readonly scriptId: string;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    }) {
      return selectClosedPackageManager(
        input.packageManager,
        candidates
      ).run(input);
    }
  });
}
