import {
  capabilityFailureReport,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../features/validation-reporting/api.js";
import { FilesystemRepositorySecurityReader } from "./adapters/outbound/filesystem/filesystem-repository-security-reader.js";
import { REPOSITORY_SECURITY_RULES_BY_ID } from "./application/rules.js";
import { analyzeRepositorySecurity } from "./application/use-cases/analyze-repository-security.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID
} from "./contract/config.js";
import { loadCapabilityConfig, type RepositorySecurityConfigurationDependencies } from "./adapters/inbound/configuration/load-capability-config.js";
import { loadStrictYamlFile } from "../../features/configuration-input/node.js";

export { REPOSITORY_SECURITY_RULES_BY_ID };

export function createRepositorySecurityBaselineCapability(input: { readonly assertSchema: RepositorySecurityConfigurationDependencies["assertSchema"] }): CapabilityDefinition {
  const reader = new FilesystemRepositorySecurityReader();
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      try {
        const policy = await loadCapabilityConfig(
          { readYaml: loadStrictYamlFile, assertSchema: input.assertSchema },
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
        return capabilityFailureReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          error,
          phase: "repository-security-execution"
        });
      }
    }
  });
}
