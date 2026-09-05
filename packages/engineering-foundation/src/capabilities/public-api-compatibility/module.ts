import {
  capabilityFailureReport,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../features/validation-reporting/api.js";
import { MicrosoftPublicApiExtractor } from "./adapters/outbound/api-extractor/microsoft-public-api-extractor.js";
import { NodeChangeFingerprint } from "./adapters/outbound/crypto/node-change-fingerprint.js";
import { FilesystemPublicApiRepository } from "./adapters/outbound/filesystem/filesystem-public-api-repository.js";
import { GovernanceAcceptedDecisionEvidenceAcl } from "./adapters/outbound/governance/governance-accepted-decision-evidence-acl.js";
import { PUBLIC_API_COMPATIBILITY_RULES_BY_ID } from "./application/rules.js";
import { analyzePublicApiCompatibility } from "./application/use-cases/analyze-public-api-compatibility.js";
import { promotePublicApiBaselines } from "./application/use-cases/promote-public-api-baselines.js";
import { publicApiPolicySchemaVersion } from "./application/model/public-api.js";
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
    repository: new FilesystemPublicApiRepository(),
    acceptedDecisionEvidence: new GovernanceAcceptedDecisionEvidenceAcl()
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
          capabilityConfigSchemaVersion: publicApiPolicySchemaVersion(policy),
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
        return capabilityFailureReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          error,
          phase: "public-api-compatibility-execution"
        });
      }
    }
  });
}
