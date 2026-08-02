import {
  CapabilityInputError,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../capability-runtime.js";
import { FilesystemMarkdownRepository } from "../../documentation-observation/adapters/outbound/filesystem/filesystem-markdown-repository.js";
import { DOCUMENTATION_LOCAL_REFERENCE_RULES_BY_ID } from "./application/rules.js";
import { analyzeDocumentationLocalReferences } from "./application/use-cases/analyze-documentation-local-references.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID,
  loadCapabilityConfig
} from "./contract/config.js";

export { DOCUMENTATION_LOCAL_REFERENCE_RULES_BY_ID };

export function createDocumentationLocalReferencesCapability(): CapabilityDefinition {
  const dependencies = Object.freeze({ repository: new FilesystemMarkdownRepository() });
  return Object.freeze({
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    id: CAPABILITY_ID,
    async run(invocation: CapabilityInvocation) {
      try {
        const policy = await loadCapabilityConfig(
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
        if (error instanceof CapabilityInputError) {
          return capabilityReport({
            capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
            capabilityId: CAPABILITY_ID,
            outcome:
              error.problem.code === "EXECUTION_CANCELLED" ? "cancelled" : "invalid-input",
            problem: error.problem
          });
        }
        return capabilityReport({
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          capabilityId: CAPABILITY_ID,
          outcome: "failed",
          problem: {
            code: "CAPABILITY_EXECUTION_FAILED",
            message: "Documentation local references capability execution failed.",
            phase: "documentation-local-references-execution",
            retryable: false
          }
        });
      }
    }
  });
}
