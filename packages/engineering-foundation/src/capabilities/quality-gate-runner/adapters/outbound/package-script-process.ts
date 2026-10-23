import {
  ProcessCancellationError,
  ProcessTimeoutError,
  type QualityGateManagedProcessExecutor,
} from "../../application/ports/managed-process-executor.js";
import {
  PackageScriptCancellationError,
  PackageScriptTimeoutError,
} from "../../application/ports/package-script-executor.js";

/** Feature-local translation of the Host's managed-process containment result. */
export async function runPackageScriptProcess(
  executor: QualityGateManagedProcessExecutor,
  request: Parameters<QualityGateManagedProcessExecutor["run"]>[0],
) {
  try {
    const result = await executor.run(request);
    return { ...result, exitCode: result.signal === null ? result.exitCode : null };
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
