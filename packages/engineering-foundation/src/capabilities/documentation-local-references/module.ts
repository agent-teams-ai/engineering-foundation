import {
  capabilityFailureReport,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../features/validation-reporting/api.js";
import { FilesystemMarkdownRepository } from "@agent-teams/document-authoring/observation";
import { DOCUMENTATION_LOCAL_REFERENCE_RULES_BY_ID } from "./application/rules.js";
import { analyzeDocumentationLocalReferences } from "./application/use-cases/analyze-documentation-local-references.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID
} from "./contract/config.js";
import { loadCapabilityConfig, type DocumentationConfigurationDependencies } from "./adapters/inbound/configuration/load-capability-config.js";
import { loadStrictYamlFile } from "../../features/configuration-input/node.js";

export { DOCUMENTATION_LOCAL_REFERENCE_RULES_BY_ID };

export function createDocumentationLocalReferencesCapability(input: { readonly assertSchema: DocumentationConfigurationDependencies["assertSchema"] }): CapabilityDefinition {
  return Object.freeze({
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    id: CAPABILITY_ID,
    async run(invocation: CapabilityInvocation) {
      try {
        const dependencies = Object.freeze({ repository: new FilesystemMarkdownRepository() });
        const policy = await loadCapabilityConfig(
          { readYaml: loadStrictYamlFile, assertSchema: input.assertSchema },
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        return capabilityReport({
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          capabilityId: CAPABILITY_ID,
          diagnostics: await analyzeDocumentationLocalReferences(
            {
              consumerRoot: invocation.consumerRoot,
              policy,
              ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
            },
            dependencies
          )
        });
      } catch (error) {
        return capabilityFailureReport({
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          capabilityId: CAPABILITY_ID,
          error,
          phase: "documentation-local-references-execution"
        });
      }
    }
  });
}
