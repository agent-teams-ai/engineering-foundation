import { rejectWorkflowBunExecutor } from "../../../application/policies/workflow-input.js";
import type {
  ExecuteWorkflowProcess
} from "../../../application/ports/process-execution.js";
import type { PackageScriptRunner } from "../../../application/ports/changed-workflow.js";

export interface BunProcessEnvironment {
  readonly bunExecutablePath?: string;
}

export class BunPackageScriptRunner implements PackageScriptRunner {
  constructor(
    private readonly environment: BunProcessEnvironment,
    private readonly execute: ExecuteWorkflowProcess
  ) {}

  async run(input: {
    readonly packageManager: "bun" | "pnpm";
    readonly consumerRoot: string;
    readonly script: string;
    readonly paths: readonly string[];
    readonly signal?: AbortSignal;
  }) {
    if (
      input.packageManager !== "bun" ||
      this.environment.bunExecutablePath === undefined
    ) {
      rejectWorkflowBunExecutor();
    }
    return this.execute(
      this.environment.bunExecutablePath,
      [
        "run",
        input.script,
        ...(input.paths.length === 0 ? [] : ["--", ...input.paths])
      ],
      {
        cwd: input.consumerRoot,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      }
    );
  }
}
