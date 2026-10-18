import { rejectQualityGateBunExecutor } from "../../../application/policies/quality-gate-input.js";
import type { QualityGateManagedProcessExecutor } from "../../../application/ports/managed-process-executor.js";
import type { PackageScriptExecutor } from "../../../application/ports/package-script-executor.js";
import { runPackageScriptProcess } from "../package-script-process.js";

export interface QualityGateBunEnvironment {
  readonly childEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly bunExecutablePath?: string;
}

export class BunQualityGateScriptExecutor implements PackageScriptExecutor {
  constructor(
    private readonly environment: QualityGateBunEnvironment,
    private readonly processExecutor: QualityGateManagedProcessExecutor
  ) {}

  async run(input: {
    readonly packageManager: "bun" | "pnpm";
    readonly consumerRoot: string;
    readonly scriptId: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }) {
    if (
      input.packageManager !== "bun" ||
      this.environment.bunExecutablePath === undefined
    ) {
      rejectQualityGateBunExecutor();
    }
    return runPackageScriptProcess(this.processExecutor, {
      command: this.environment.bunExecutablePath,
      args: ["run", input.scriptId],
      cwd: input.consumerRoot,
      environment: this.environment.childEnvironment,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
  }
}
