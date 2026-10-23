import { isCheckCancelled } from "../../../application/policies/check-cancellation.js";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  CoverageExecutionFailure,
  InputRevocationError,
  type CoverageCheckRunner,
} from "../../../application/ports/check-changed.js";
import type { ExecuteWorkflowProcess } from "../../../application/ports/process-execution.js";
import type { CoverageExecution } from "../../../application/model/check-changed.js";
import type { PackageScriptRunner } from "../../../application/ports/changed-workflow.js";
import {
  PnpmPackageScriptRunner,
  type PnpmProcessEnvironment,
} from "./pnpm-package-script-runner.js";
import { pnpmLifecycleIsolationArgs } from "./qualified-pnpm-check-runner.js";
import {
  BunPackageScriptRunner,
  type BunProcessEnvironment,
} from "../bun/bun-package-script-runner.js";

/** Honest feedback for the current CLI Host: no trusted tool/script closure or
 * frozen custody is available. No facets or test observations are qualified. */
function createMutableCheckRunner(scriptRunner: PackageScriptRunner): CoverageCheckRunner {
  return {
    async run({ lease, check, packageManager, signal }) {
      if (lease.classification !== "mutable") {
        throw new Error("Feedback runner requires mutable custody.");
      }
      const binding = {
        invocationId: randomUUID(),
        sourceIdentity: lease.sourceIdentity,
        configIdentity: lease.configIdentity,
        checkId: check.id,
      };
      const commands: CoverageExecution["commands"][number][] = [];
      const start = performance.now();
      let exitCode = 0;
      const result = (): CoverageExecution => ({
        binding,
        commands,
        exitCode,
        durationMs: performance.now() - start,
        cancelled: isCheckCancelled(signal),
        output: "Unqualified mutable command feedback; raw output omitted.",
        observation: null,
        qualifiedFacets: [],
      });
      let admissionRevoked = true;
      try {
        for (const script of [...check.prerequisites, check.script]) {
          await lease.assertCurrent(signal);
          if (isCheckCancelled(signal)) {
            break;
          }
          const commandStart = performance.now();
          admissionRevoked = false;
          const execution = await scriptRunner
            .run({
              packageManager,
              consumerRoot: lease.executionRoot,
              script,
              paths: [],
              ...(signal === undefined ? {} : { signal }),
            })
            .catch((error: unknown) => {
              commands.push({
                script,
                exitCode: null,
                durationMs: performance.now() - commandStart,
              });
              throw error;
            });
          commands.push({
            script,
            exitCode: execution.exitCode,
            durationMs: performance.now() - commandStart,
          });
          exitCode = execution.exitCode;
          admissionRevoked = true;
          if (exitCode !== 0 || isCheckCancelled(signal)) {
            break;
          }
        }
        await lease.assertCurrent(signal);
        return result();
      } catch (error) {
        // Admission revocation classifies as revoked (stale) regardless of how
        // many commands ran; a raw rethrow would surface as a plain failure and
        // make the outcome depend on timing.
        if (error instanceof InputRevocationError) {
          throw new CoverageExecutionFailure(result(), true);
        }
        if (commands.length === 0) {
          throw error;
        }
        exitCode ||= 1;
        throw new CoverageExecutionFailure(result(), admissionRevoked);
      }
    },
  };
}

/** Mutable feedback over pnpm with lifecycle and install effects disabled. */
export function createMutablePnpmCheckRunner(
  environment: PnpmProcessEnvironment,
  execute: ExecuteWorkflowProcess,
): CoverageCheckRunner {
  const scriptRunner = new PnpmPackageScriptRunner(environment, (command, args, options) => {
    const index = args.indexOf("run");
    return execute(
      command,
      [...args.slice(0, index), ...pnpmLifecycleIsolationArgs, ...args.slice(index)],
      options,
    );
  });
  return createMutableCheckRunner(scriptRunner);
}

/** Mutable feedback over Bun for repositories with packageManager: bun. */
export function createMutableBunCheckRunner(
  environment: BunProcessEnvironment,
  execute: ExecuteWorkflowProcess,
): CoverageCheckRunner {
  return createMutableCheckRunner(new BunPackageScriptRunner(environment, execute));
}
