import type { PackageScriptRunner } from "../../../application/ports/changed-workflow.js";
import { execute } from "../process/process-execution.js";

export class PnpmPackageScriptRunner implements PackageScriptRunner {
  async run(input: {
    readonly consumerRoot: string;
    readonly script: string;
    readonly paths: readonly string[];
    readonly signal?: AbortSignal;
  }) {
    return execute(
      "pnpm",
      ["run", input.script, ...(input.paths.length === 0 ? [] : ["--", ...input.paths])],
      {
        cwd: input.consumerRoot,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      }
    );
  }
}
