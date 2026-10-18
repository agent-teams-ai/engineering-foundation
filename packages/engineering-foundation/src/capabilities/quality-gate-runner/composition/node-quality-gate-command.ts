import { CapabilityInputError } from "../../../features/validation-reporting/api.js";
import { readContainedRegularFile } from "../../../source-inventory/node.js";
import { createQualityGateCommand, type QualityGateCommand } from "../api.js";
import { FilesystemPackageScriptCatalogReader } from "../adapters/outbound/filesystem/filesystem-package-script-catalog-reader.js";
import { PnpmQualityGateScriptExecutor } from "../adapters/outbound/pnpm/pnpm-package-script-executor.js";
import { BunQualityGateScriptExecutor } from "../adapters/outbound/bun/bun-package-script-executor.js";
import { performanceMonotonicClock } from "../adapters/outbound/time/performance-monotonic-clock.js";
import { loadQualityGatePolicy, type QualityGateConfigurationDependencies } from "../adapters/inbound/configuration/load-quality-gate-policy.js";
import { loadStrictYamlFile } from "../../../features/configuration-input/node.js";
import { resolveRepositoryRuntimeExecutables } from "../../../process-execution/application/runtime-selection.js";
import { createPackageManagerScriptExecutor } from "./select-package-script-executor.js";
import { verifyRepositoryRuntimeExecutable } from "../../../process-execution/module.js";

const ACTIVE_GATE_ENVIRONMENT_VARIABLE = "AGENT_TEAMS_FOUNDATION_QUALITY_GATE_ACTIVE";

export function createNodeQualityGateCommand(
  environment: NodeJS.ProcessEnv,
  processExecutor: import("../application/ports/managed-process-executor.js").QualityGateManagedProcessExecutor,
  assertSchema: QualityGateConfigurationDependencies["assertSchema"]
): QualityGateCommand {
  const snapshot = Object.freeze({ ...environment });
  const pnpmEntrypoint = snapshot.npm_execpath ??
    snapshot["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"];
  return async (input) => {
    const runtime = await resolveRepositoryRuntimeExecutables({
      environment: snapshot,
      currentExecutablePath: process.execPath,
      currentRuntime:
        "bun" in process.versions &&
        typeof process.versions["bun"] === "string"
          ? "bun"
          : "node",
      verifyExecutable: verifyRepositoryRuntimeExecutable
    }).catch((error: unknown) => {
      throw new CapabilityInputError({
        code: "QUALITY_GATE_RUNNER_RUNTIME_INVALID",
        message: error instanceof Error ? error.message : "Repository runtime selection failed.",
        phase: "quality-gate-runner-runtime",
        retryable: false
      });
    });
    const childEnvironment = Object.freeze({
      ...snapshot,
      [ACTIVE_GATE_ENVIRONMENT_VARIABLE]: input.profileId,
      AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: runtime.profile,
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: runtime.executables.node,
      ...(runtime.executables.bun === undefined
        ? {}
        : { AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: runtime.executables.bun })
    });
    return createQualityGateCommand({
      catalogReader: new FilesystemPackageScriptCatalogReader(readContainedRegularFile),
      clock: performanceMonotonicClock,
      executor: createPackageManagerScriptExecutor({
        bun: new BunQualityGateScriptExecutor({
          childEnvironment,
          ...(runtime.executables.bun === undefined
            ? {}
            : { bunExecutablePath: runtime.executables.bun })
        }, processExecutor),
        pnpm: new PnpmQualityGateScriptExecutor({
          childEnvironment,
          nodeExecutablePath: runtime.executables.node,
          ...(pnpmEntrypoint === undefined
            ? {}
            : { npmExecPath: pnpmEntrypoint }),
          ...(snapshot.PNPM_HOME === undefined
            ? {}
            : { pnpmHome: snapshot.PNPM_HOME }),
          ...(snapshot.PATH === undefined
            ? {}
            : { pathValue: snapshot.PATH })
        }, processExecutor)
      }),
      policyLoader: (consumerRoot, configPath, signal) => loadQualityGatePolicy(
        { readYaml: loadStrictYamlFile, assertSchema }, consumerRoot, configPath, signal
      ),
      qualityGateActive:
        snapshot[ACTIVE_GATE_ENVIRONMENT_VARIABLE] !== undefined
    })(input);
  };
}
