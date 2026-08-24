import {
  capabilityFailureReport,
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
        return capabilityFailureReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          error,
          phase: "quality-gate-runner-execution"
        });
      }
    }
  });
}
