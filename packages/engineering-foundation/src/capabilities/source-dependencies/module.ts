import {
  CapabilityInputError,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../capability-runtime.js";
import { PnpmWorkspaceInventoryReader } from "../../workspace-inventory/adapters/outbound/pnpm/pnpm-workspace-inventory-reader.js";
import { FilesystemSourceTreeReader } from "./adapters/outbound/filesystem/filesystem-source-tree-reader.js";
import { NodeSourceDependencyResolver } from "./adapters/outbound/node/node-source-dependency-resolver.js";
import { OxcSourceDependencyParser } from "./adapters/outbound/oxc/oxc-source-dependency-parser.js";
import { analyzeSourceDependencies } from "./application/use-cases/analyze-source-dependencies.js";
import { SOURCE_DEPENDENCY_RULES_BY_ID } from "./application/rules.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID,
  loadCapabilityConfig
} from "./contract/config.js";

export { SOURCE_DEPENDENCY_RULES_BY_ID };

export function createSourceDependenciesCapability(): CapabilityDefinition {
  const dependencies = Object.freeze({
    inventoryReader: new PnpmWorkspaceInventoryReader(),
    parser: new OxcSourceDependencyParser(),
    resolver: new NodeSourceDependencyResolver(),
    sourceReader: new FilesystemSourceTreeReader()
  });
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
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
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
        if (error instanceof CapabilityInputError) {
          return capabilityReport({
            capabilityId: CAPABILITY_ID,
            capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
            outcome:
              error.problem.code === "EXECUTION_CANCELLED"
                ? "cancelled"
                : "invalid-input",
            problem: error.problem
          });
        }
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          outcome: "failed",
          problem: {
            code: "CAPABILITY_EXECUTION_FAILED",
            message: "Source dependency capability execution failed.",
            phase: "source-dependency-execution",
            retryable: false
          }
        });
      }
    }
  });
}
