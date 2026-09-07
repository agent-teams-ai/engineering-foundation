import {
  capabilityFailureReport,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../features/validation-reporting/api.js";
import { PnpmWorkspaceReader } from "./adapters/outbound/pnpm-workspace/pnpm-workspace-reader.js";
import { loadCapabilityConfig, type WorkspaceConfigurationDependencies } from "./adapters/inbound/filesystem/load-capability-config.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID
} from "./contract/config.js";
import { evaluateWorkspaceDependencies } from "./application/policies/evaluate-workspace-dependencies.js";
import { RULES_BY_ID } from "./application/rules.js";

import { loadStrictYamlFile } from "../../features/configuration-input/node.js";

export { RULES_BY_ID };

export function createWorkspaceDependencyDeclarationsCapability(
  inventoryReader: import("./application/ports/workspace-reader.js").WorkspaceReader,
  readSchema: WorkspaceConfigurationDependencies["readSchema"]
): CapabilityDefinition {
  const workspaceReader = new PnpmWorkspaceReader(inventoryReader);
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      try {
        const config = await loadCapabilityConfig(
          { readYaml: loadStrictYamlFile, readSchema },
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
        return capabilityFailureReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          error,
          phase: "capability-execution"
        });
      }
    }
  });
}
