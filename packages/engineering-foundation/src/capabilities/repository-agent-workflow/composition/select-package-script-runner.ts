import type { RepositoryPackageManager } from "../../../process-execution/application/runtime-selection.js";
import { selectClosedPackageManager } from "../../../process-execution/application/runtime-selection.js";
import type { PackageScriptRunner } from "../application/ports/changed-workflow.js";

export function createPackageManagerScriptRunner(
  candidates: {
    readonly bun?: PackageScriptRunner;
    readonly pnpm?: PackageScriptRunner;
  }
): PackageScriptRunner {
  return Object.freeze({
    async run(input: {
      readonly packageManager: RepositoryPackageManager;
      readonly consumerRoot: string;
      readonly script: string;
      readonly paths: readonly string[];
      readonly signal?: AbortSignal;
    }) {
      return selectClosedPackageManager(
        input.packageManager,
        candidates
      ).run(input);
    }
  });
}
