import {
  capabilityFailureReport,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation,
} from "../../features/validation-reporting/api.js";
import { FilesystemMarkdownRepository } from "@agent-teams/document-authoring/observation";
import {
  DOCUMENTATION_LOCAL_REFERENCE_RULES,
  DOCUMENTATION_LOCAL_REFERENCE_RULES_BY_ID,
} from "./application/rules.js";
import { digestMarkdownSource } from "./adapters/outbound/crypto/node-markdown-source-digest.js";
import { analyzeDocumentationLocalReferences } from "./application/use-cases/analyze-documentation-local-references.js";
import { CAPABILITY_CONFIG_SCHEMA_VERSION, CAPABILITY_ID } from "./contract/config.js";
import {
  loadCapabilityConfig,
  type DocumentationConfigurationDependencies,
} from "./adapters/inbound/configuration/load-capability-config.js";
import { loadStrictYamlFile } from "../../features/configuration-input/node.js";

export { DOCUMENTATION_LOCAL_REFERENCE_RULES_BY_ID };

export function createDocumentationLocalReferencesCapability(input: {
  readonly assertSchema: DocumentationConfigurationDependencies["assertSchema"];
}): CapabilityDefinition {
  return Object.freeze({
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    id: CAPABILITY_ID,
    async run(invocation: CapabilityInvocation) {
      let requestedSchemaVersion: 1 | 2 = 1;
      try {
        const dependencies = Object.freeze({
          repository: new FilesystemMarkdownRepository(),
          digestSource: digestMarkdownSource,
        });
        const policy = await loadCapabilityConfig(
          { readYaml: loadStrictYamlFile, assertSchema: input.assertSchema },
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal,
          (version) => {
            requestedSchemaVersion = version;
          },
        );
        const diagnostics = await analyzeDocumentationLocalReferences(
          {
            consumerRoot: invocation.consumerRoot,
            policy,
            ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
          },
          dependencies,
        );
        return capabilityReport({
          capabilityConfigSchemaVersion: requestedSchemaVersion,
          capabilityId: CAPABILITY_ID,
          diagnostics,
          outcome: diagnostics.every(
            (entry) =>
              entry.ruleId === DOCUMENTATION_LOCAL_REFERENCE_RULES.historicalAbsoluteReference.id &&
              entry.severity === "info",
          )
            ? "passed"
            : "violations",
        });
      } catch (error) {
        return capabilityFailureReport({
          capabilityConfigSchemaVersion: requestedSchemaVersion,
          capabilityId: CAPABILITY_ID,
          error,
          phase: "documentation-local-references-execution",
        });
      }
    },
  });
}
