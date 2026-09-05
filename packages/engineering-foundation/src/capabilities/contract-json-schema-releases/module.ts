import {
  capabilityFailureReport,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../features/validation-reporting/api.js";
import { AjvJsonSchemaReleaseInspector } from "./adapters/outbound/filesystem/ajv-json-schema-release-inspector.js";
import type { JsonSchemaReleaseInspector } from "./application/ports/json-schema-release-inspector.js";
import { verifyJsonSchemaRelease } from "./application/use-cases/verify-json-schema-release.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID
} from "./contract/config.js";

import { loadCapabilityConfig, type JsonSchemaConfigurationDependencies } from "./adapters/inbound/configuration/load-capability-config.js";
import { loadStrictYamlFile } from "../../features/configuration-input/node.js";

export { AjvJsonSchemaReleaseInspector } from "./adapters/outbound/filesystem/ajv-json-schema-release-inspector.js";
export {
  evaluateJsonSchemaRelease
} from "./application/policies/evaluate-json-schema-release.js";
export type {
  JsonSchemaConsumerEvidence,
  JsonSchemaDigest,
  JsonSchemaFixture,
  JsonSchemaFixtureExpectation,
  JsonSchemaFixtureResult,
  JsonSchemaInspection,
  JsonSchemaReleasePolicy,
  ReleasedJsonSchemaContractEvidence
} from "./application/model/json-schema-release.js";
export type { JsonSchemaReleaseInspector } from "./application/ports/json-schema-release-inspector.js";
export {
  JSON_SCHEMA_RELEASE_RULES,
  JSON_SCHEMA_RELEASE_RULES_BY_ID
} from "./application/rules.js";
export { verifyJsonSchemaRelease } from "./application/use-cases/verify-json-schema-release.js";

export interface JsonSchemaReleaseCapabilityDependencies {
  readonly assertSchema: JsonSchemaConfigurationDependencies["assertSchema"];
  readonly inspector?: JsonSchemaReleaseInspector;
}

export function createJsonSchemaReleaseCapability(
  dependencies: JsonSchemaReleaseCapabilityDependencies
): CapabilityDefinition {
  const inspector = dependencies.inspector ?? new AjvJsonSchemaReleaseInspector();
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      try {
        const policy = await loadCapabilityConfig(
          { readYaml: loadStrictYamlFile, assertSchema: dependencies.assertSchema },
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        const result = await verifyJsonSchemaRelease(
          {
            consumerRoot: invocation.consumerRoot,
            policy,
            ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
          },
          inspector
        );
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          diagnostics: result.diagnostics
        });
      } catch (error) {
        return capabilityFailureReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          error,
          phase: "json-schema-release-execution"
        });
      }
    }
  });
}

export function createJsonSchemaInspector(
  readArtifact: (repositoryPath: string) => Promise<Buffer | undefined>
): JsonSchemaReleaseInspector {
  return new AjvJsonSchemaReleaseInspector(readArtifact);
}
