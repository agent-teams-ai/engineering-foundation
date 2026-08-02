import {
  CapabilityInputError,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../capability-runtime.js";
import { FilesystemRepositorySecurityReader } from "./adapters/outbound/filesystem/filesystem-repository-security-reader.js";
import { REPOSITORY_SECURITY_RULES_BY_ID } from "./application/rules.js";
import { analyzeRepositorySecurity } from "./application/use-cases/analyze-repository-security.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID,
  loadCapabilityConfig
} from "./contract/config.js";

export { REPOSITORY_SECURITY_RULES_BY_ID };

export function createRepositorySecurityBaselineCapability(): CapabilityDefinition {
  const reader = new FilesystemRepositorySecurityReader();
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      try {
        const policy = await loadCapabilityConfig(
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        const diagnostics = await analyzeRepositorySecurity(
          {
            consumerRoot: invocation.consumerRoot,
            policy,
            ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
          },
          reader
        );
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          diagnostics,
          outcome: diagnostics.some(({ severity }) => severity === "error") ? "violations" : "passed"
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
            message: "Repository security baseline capability execution failed.",
            phase: "repository-security-execution",
            retryable: false
          }
        });
      }
    }
  });
}
