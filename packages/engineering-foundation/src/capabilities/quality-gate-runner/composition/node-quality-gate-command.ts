import { readContainedRegularFile } from "../../../source-inventory/node.js";
import { createQualityGateCommand, type QualityGateCommand } from "../api.js";
import { FilesystemPackageScriptCatalogReader } from "../adapters/outbound/filesystem/filesystem-package-script-catalog-reader.js";
import { PnpmQualityGateScriptExecutor } from "../adapters/outbound/pnpm/pnpm-package-script-executor.js";
import { performanceMonotonicClock } from "../adapters/outbound/time/performance-monotonic-clock.js";
import { loadQualityGatePolicy, type QualityGateConfigurationDependencies } from "../adapters/inbound/configuration/load-quality-gate-policy.js";
import { loadStrictYamlFile } from "../../../features/configuration-input/node.js";

const ACTIVE_GATE_ENVIRONMENT_VARIABLE = "AGENT_TEAMS_FOUNDATION_QUALITY_GATE_ACTIVE";

export function createNodeQualityGateCommand(
  environment: NodeJS.ProcessEnv,
  processExecutor: import("../application/ports/managed-process-executor.js").QualityGateManagedProcessExecutor,
  assertSchema: QualityGateConfigurationDependencies["assertSchema"]
): QualityGateCommand {
  const snapshot = Object.freeze({ ...environment });
  return async (input) => createQualityGateCommand({
    catalogReader: new FilesystemPackageScriptCatalogReader(readContainedRegularFile),
    clock: performanceMonotonicClock,
    executor: new PnpmQualityGateScriptExecutor({
      childEnvironment: Object.freeze({
        ...snapshot,
        [ACTIVE_GATE_ENVIRONMENT_VARIABLE]: input.profileId
      }),
      ...(snapshot.npm_execpath === undefined
        ? {}
        : { npmExecPath: snapshot.npm_execpath }),
      ...(snapshot.PNPM_HOME === undefined
        ? {}
        : { pnpmHome: snapshot.PNPM_HOME }),
      ...(snapshot.PATH === undefined
        ? {}
        : { pathValue: snapshot.PATH })
    }, processExecutor),
    policyLoader: (consumerRoot, configPath, signal) => loadQualityGatePolicy(
      { readYaml: loadStrictYamlFile, assertSchema }, consumerRoot, configPath, signal
    ),
    qualityGateActive:
      snapshot[ACTIVE_GATE_ENVIRONMENT_VARIABLE] !== undefined
  })(input);
}
