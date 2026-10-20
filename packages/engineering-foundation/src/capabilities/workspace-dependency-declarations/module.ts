import {
  capabilityFailureReport,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../features/validation-reporting/api.js";
import { PnpmWorkspaceReader } from "./adapters/outbound/pnpm-workspace/pnpm-workspace-reader.js";
import { loadCapabilityConfig } from "./adapters/inbound/filesystem/load-capability-config.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID
} from "./contract/config.js";
import { evaluateWorkspaceDependencies } from "./application/policies/evaluate-workspace-dependencies.js";
import { RULES_BY_ID } from "./application/rules.js";

import type { WorkspaceConfigurationSchemaAssertion } from "./application/configuration-input.js";
import { WORKSPACE_DEPENDENCY_DECLARATIONS_SCHEMA_IDS } from "./schemas.js";
import { createSchemaCatalog } from "../../features/configuration-input/module.js";
import { loadStrictYamlFile } from "../../features/configuration-input/node.js";

export { RULES_BY_ID };

export function createWorkspaceDependencyDeclarationsCapability(
  inventoryReader: import("./application/ports/workspace-reader.js").WorkspaceReader,
  readSchema: (schemaId: Parameters<WorkspaceConfigurationSchemaAssertion>[0]) => Promise<string>
): CapabilityDefinition {
  const workspaceReader = new PnpmWorkspaceReader(inventoryReader);
  const schemas = createSchemaCatalog({
    schemaIds: WORKSPACE_DEPENDENCY_DECLARATIONS_SCHEMA_IDS,
    dependencies: {},
    readSchema: async (schemaId: string) => {
      const selected = WORKSPACE_DEPENDENCY_DECLARATIONS_SCHEMA_IDS.find((candidate) => candidate === schemaId);
      if (selected === undefined) {
        throw new Error(`Workspace dependency schema is not declared: ${schemaId}.`);
      }
      return readSchema(selected);
    }
  });
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      try {
        const config = await loadCapabilityConfig(
          { readYaml: loadStrictYamlFile, assertSchema: schemas.assertSchema },
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
          diagnostics: evaluateWorkspaceDependencies(snapshot, config.policy, config.packageManagerKind)
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
