import {
  CapabilityInputError,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../capability-runtime.js";
import { PnpmWorkspaceReader } from "./adapters/outbound/pnpm-workspace/pnpm-workspace-reader.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID,
  loadCapabilityConfig
} from "./contract/config.js";
import { evaluateWorkspaceDependencies } from "./application/policies/evaluate-workspace-dependencies.js";

export function createWorkspaceDependencyDeclarationsCapability(): CapabilityDefinition {
  const workspaceReader = new PnpmWorkspaceReader();
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      try {
        const config = await loadCapabilityConfig(
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        const snapshot = await workspaceReader.read(
          invocation.consumerRoot,
          config.workspaceManifestPath,
          invocation.signal
        );
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          diagnostics: evaluateWorkspaceDependencies(snapshot, config.policy)
        });
      } catch (error) {
        if (error instanceof CapabilityInputError) {
          const cancelled = error.problem.code === "EXECUTION_CANCELLED";
          return capabilityReport({
            capabilityId: CAPABILITY_ID,
            capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
            outcome: cancelled ? "cancelled" : "invalid-input",
            problem: error.problem
          });
        }
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          outcome: "failed",
          problem: {
            code: "CAPABILITY_EXECUTION_FAILED",
            message: "Capability execution failed.",
            phase: "capability-execution",
            retryable: false
          }
        });
      }
    }
  });
}
