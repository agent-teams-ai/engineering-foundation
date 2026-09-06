import {
  capabilityFailureReport,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../features/validation-reporting/api.js";
import type { SourceTreeReader } from "./application/ports/source-tree-reader.js";
import type { WorkspaceInventoryReader } from "../../workspace-inventory/api.js";
import type { SourceWorkspaceInventorySnapshotReader } from "./application/ports/source-workspace-topology-inspector.js";
import { NodeSourceDependencyResolver } from "./adapters/outbound/node/node-source-dependency-resolver.js";
import { PnpmSourceWorkspaceTopologyInspector } from "./adapters/outbound/node/pnpm-source-workspace-topology-inspector.js";
import { OxcSourceDependencyParser } from "./adapters/outbound/oxc/oxc-source-dependency-parser.js";
import { analyzeSourceDependencies } from "./application/use-cases/analyze-source-dependencies.js";
import { SOURCE_DEPENDENCY_RULES_BY_ID } from "./application/rules.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID
} from "./contract/config.js";

import { loadCapabilityConfig, type SourceArchitectureConfigurationDependencies } from "./adapters/inbound/configuration/load-capability-config.js";
import { loadStrictYamlFile } from "../../features/configuration-input/node.js";
import { readContainedRegularFile } from "../../source-inventory/node.js";
import type { SourceWorkspaceFileReader } from "./api.js";

const fileReader: SourceWorkspaceFileReader = { read: readContainedRegularFile };

export { SOURCE_DEPENDENCY_RULES_BY_ID };

export interface SourceDependenciesCapabilityDependencies {
  readonly assertSchema: SourceArchitectureConfigurationDependencies["assertSchema"];
  readonly inventoryReader: WorkspaceInventoryReader & SourceWorkspaceInventorySnapshotReader;
  readonly sourceReader: SourceTreeReader;
}

export function createSourceDependenciesCapability(input: SourceDependenciesCapabilityDependencies): CapabilityDefinition {
  const inventoryReader = input.inventoryReader;
  const dependencies = Object.freeze({
    inventoryReader,
    parser: new OxcSourceDependencyParser(),
    resolver: new NodeSourceDependencyResolver(),
    sourceReader: input.sourceReader,
    topologyInspector: new PnpmSourceWorkspaceTopologyInspector({
      inventoryReader, fileReader, workspaceManifestLoader: loadStrictYamlFile
    })
  });
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      let requestedSchemaVersion: 1 | 2 = CAPABILITY_CONFIG_SCHEMA_VERSION;
      try {
        const policy = await loadCapabilityConfig(
          { readYaml: loadStrictYamlFile, assertSchema: input.assertSchema },
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal,
          (schemaVersion) => {
            requestedSchemaVersion = schemaVersion;
          }
        );
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: requestedSchemaVersion,
          diagnostics: await analyzeSourceDependencies(
            {
              consumerRoot: invocation.consumerRoot,
              policy,
              ...(invocation.signal === undefined
                ? {}
                : { signal: invocation.signal })
            },
            dependencies
          )
        });
      } catch (error) {
        return capabilityFailureReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: requestedSchemaVersion,
          error,
          phase: "source-dependency-execution"
        });
      }
    }
  });
}
