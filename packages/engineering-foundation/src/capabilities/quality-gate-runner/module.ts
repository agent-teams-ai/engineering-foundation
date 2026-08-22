import {
  CapabilityInputError,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../capability-runtime.js";
import { FilesystemPackageScriptCatalogReader } from "./adapters/outbound/filesystem/filesystem-package-script-catalog-reader.js";
import { QUALITY_GATE_RUNNER_RULES_BY_ID } from "./application/rules.js";
import { analyzeQualityGateRunner } from "./application/use-cases/analyze-quality-gate-runner.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID,
  loadQualityGatePolicy
} from "./contract/config.js";

export { QUALITY_GATE_RUNNER_RULES_BY_ID };

export function createQualityGateRunnerCapability(): CapabilityDefinition {
  const reader = new FilesystemPackageScriptCatalogReader();
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      try {
        const policy = await loadQualityGatePolicy(
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          diagnostics: await analyzeQualityGateRunner(
            {
              consumerRoot: invocation.consumerRoot,
              policy,
              ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
            },
            reader
          )
        });
      } catch (error) {
        if (error instanceof CapabilityInputError) {
          return capabilityReport({
            capabilityId: CAPABILITY_ID,
            capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
            outcome: error.problem.code === "EXECUTION_CANCELLED" ? "cancelled" : "invalid-input",
            problem: error.problem
          });
        }
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          outcome: "failed",
          problem: {
            code: "CAPABILITY_EXECUTION_FAILED",
            message: "Quality gate runner capability validation failed.",
            phase: "quality-gate-runner-execution",
            retryable: false
          }
        });
      }
    }
  });
}
