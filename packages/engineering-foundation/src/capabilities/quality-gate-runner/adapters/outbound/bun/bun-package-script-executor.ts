import { rejectQualityGateExecutor } from "../../../application/policies/quality-gate-input.js";
import {
  ProcessCancellationError,
  ProcessTimeoutError
} from "../../../application/ports/managed-process-executor.js";
import type { QualityGateManagedProcessExecutor } from "../../../application/ports/managed-process-executor.js";
import {
  PackageScriptCancellationError,
  PackageScriptTimeoutError,
  type PackageScriptExecutor
} from "../../../application/ports/package-script-executor.js";

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
      rejectQualityGateExecutor();
    }
    try {
      const result = await this.processExecutor.run({
        command: this.environment.bunExecutablePath,
        args: ["run", input.scriptId],
        cwd: input.consumerRoot,
        environment: this.environment.childEnvironment,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      return {
        ...result,
        exitCode: result.signal === null ? result.exitCode : null
      };
    } catch (error) {
      if (error instanceof ProcessCancellationError) {
        throw new PackageScriptCancellationError({ cause: error });
      }
      if (error instanceof ProcessTimeoutError) {
        throw new PackageScriptTimeoutError(error.timeoutMs, { cause: error });
      }
      throw error;
    }
  }
}
