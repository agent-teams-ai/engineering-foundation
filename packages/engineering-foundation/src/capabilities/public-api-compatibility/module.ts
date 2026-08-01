import {
  CapabilityInputError,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../capability-runtime.js";
import { MicrosoftPublicApiExtractor } from "./adapters/outbound/api-extractor/microsoft-public-api-extractor.js";
import { NodeChangeFingerprint } from "./adapters/outbound/crypto/node-change-fingerprint.js";
import { FilesystemPublicApiRepository } from "./adapters/outbound/filesystem/filesystem-public-api-repository.js";
import { PUBLIC_API_COMPATIBILITY_RULES_BY_ID } from "./application/rules.js";
import { analyzePublicApiCompatibility } from "./application/use-cases/analyze-public-api-compatibility.js";
import { promotePublicApiBaselines } from "./application/use-cases/promote-public-api-baselines.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID,
  loadCapabilityConfig
} from "./contract/config.js";

export { PUBLIC_API_COMPATIBILITY_RULES_BY_ID };

function createDependencies() {
  return Object.freeze({
    extractor: new MicrosoftPublicApiExtractor(),
    fingerprint: new NodeChangeFingerprint(),
    repository: new FilesystemPublicApiRepository()
  });
}

export async function promotePublicApiRelease(input: {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly signal?: AbortSignal;
}) {
  const policy = await loadCapabilityConfig(
    input.consumerRoot,
    input.configPath,
    input.signal
  );
  return promotePublicApiBaselines(
    {
      consumerRoot: input.consumerRoot,
      policy,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    },
    createDependencies()
  );
}

export function createPublicApiCompatibilityCapability(): CapabilityDefinition {
  const dependencies = createDependencies();
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
          diagnostics: await analyzePublicApiCompatibility(
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
            message: "Public API compatibility capability execution failed.",
            phase: "public-api-compatibility-execution",
            retryable: false
          }
        });
      }
    }
  });
}
