import {
  capabilityFailureReport,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../features/validation-reporting/api.js";
import { FilesystemExecutableSpecificationInspector } from "./adapters/outbound/filesystem/filesystem-executable-specification-inspector.js";
import { analyzeExecutableSpecifications } from "./application/use-cases/analyze-executable-specifications.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID
} from "./contract/config.js";

import { loadCapabilityConfig, type ExecutableConfigurationDependencies } from "./adapters/inbound/configuration/load-capability-config.js";
import { loadStrictYamlFile } from "../../features/configuration-input/node.js";
import { readContainedRegularFile } from "../../source-inventory/node.js";
import type { ExecutableArtifactFileReader } from "./api.js";

const artifactFiles: ExecutableArtifactFileReader = { read: readContainedRegularFile };

export { FilesystemExecutableSpecificationInspector } from "./adapters/outbound/filesystem/filesystem-executable-specification-inspector.js";
export type {
  ConsumerGateBinding,
  ExecutableSpecification,
  ExecutableSpecificationCatalog,
  ExecutableSpecificationDocument,
  ExecutableSpecificationObservation,
  GeneratedTypeBinding,
  NoStateModel,
  ObservedGateBinding,
  XstateStateModel
} from "./api.js";
export { evaluateExecutableSpecifications } from "./api.js";
export type { ExecutableSpecificationInspector } from "./api.js";
export {
  EXECUTABLE_SPECIFICATION_RULES,
  EXECUTABLE_SPECIFICATION_RULES_BY_ID
} from "./api.js";
export { analyzeExecutableSpecifications } from "./api.js";
export type { JsonSchemaInspectorFactory } from "./api.js";
export type { WorkspaceManifestPathReader } from "./api.js";

export function createExecutableSpecificationsCapability(dependencies: {
  readonly assertSchema: ExecutableConfigurationDependencies["assertSchema"];
  readonly workspaceManifestPathReader: import("./application/ports/workspace-manifest-path-reader.js").WorkspaceManifestPathReader;
  readonly createJsonSchemaInspector: import("./application/ports/json-schema-inspector-factory.js").JsonSchemaInspectorFactory;
}): CapabilityDefinition {
  const inspector = new FilesystemExecutableSpecificationInspector(
    dependencies.workspaceManifestPathReader, dependencies.createJsonSchemaInspector, artifactFiles
  );
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      try {
        const catalog = await loadCapabilityConfig(
          { readYaml: loadStrictYamlFile, readFile: readContainedRegularFile, assertSchema: dependencies.assertSchema },
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          diagnostics: await analyzeExecutableSpecifications(
            {
              consumerRoot: invocation.consumerRoot,
              catalog,
              ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
            },
            inspector
          )
        });
      } catch (error) {
        return capabilityFailureReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          error,
          phase: "executable-specification-execution"
        });
      }
    }
  });
}
