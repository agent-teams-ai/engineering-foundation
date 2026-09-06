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
import { preflightPublicApiPromotions } from "./application/use-cases/preflight-public-api-promotions.js";
import { FilesystemPackageArtifactInventory } from "./adapters/outbound/filesystem/filesystem-package-artifact-inventory.js";
import { ArtifactPublicApiEvidence } from "./adapters/outbound/filesystem/artifact-public-api-evidence.js";
import type { JsonSchemaSetInspector } from "./application/ports/package-artifact-inventory.js";
import { publicApiPolicySchemaVersion } from "./application/model/public-api.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID
} from "./contract/config.js";

import { loadCapabilityConfig, type PublicApiConfigurationDependencies } from "./adapters/inbound/configuration/load-capability-config.js";
import { loadStrictYamlFile } from "../../features/configuration-input/node.js";

import { pathTraversesSymbolicLink, readContainedRegularFile } from "../../source-inventory/node.js";
import { parseStrictYamlSource } from "../../features/configuration-input/yaml.js";
import type { PublicApiExtractor } from "./application/ports/public-api-extractor.js";
import type { PublicApiRepositoryEvidence } from "./application/ports/public-api-evidence.js";

const evidence: PublicApiRepositoryEvidence = {
  files: { read: readContainedRegularFile },
  paths: { traversesSymbolicLink: pathTraversesSymbolicLink },
  parseYaml: parseStrictYamlSource
};

export { PUBLIC_API_COMPATIBILITY_RULES_BY_ID };

export function createPublicApiExtractor(): PublicApiExtractor {
  return new MicrosoftPublicApiExtractor(evidence);
}

function createDependencies(readAcceptedDecisions: import("./application/ports/accepted-decision-evidence.js").AcceptedArchitectureDecisionReader, assertSchema: PublicApiConfigurationDependencies["assertSchema"]) {
  return Object.freeze({
    extractor: createPublicApiExtractor(),
    fingerprint: new NodeChangeFingerprint(),
    repository: new FilesystemPublicApiRepository(assertSchema, evidence),
    acceptedDecisionEvidence: new GovernanceAcceptedDecisionEvidenceAcl(readAcceptedDecisions)
  });
}

export async function promotePublicApiRelease(input: {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly signal?: AbortSignal;
}, readAcceptedDecisions: import("./application/ports/accepted-decision-evidence.js").AcceptedArchitectureDecisionReader, assertSchema: PublicApiConfigurationDependencies["assertSchema"], inspector: JsonSchemaSetInspector) {
  const policy = await loadCapabilityConfig(
    { readYaml: loadStrictYamlFile, assertSchema },
    input.consumerRoot,
    input.configPath,
    input.signal
  );
  const dependencies = createDependencies(readAcceptedDecisions, assertSchema);
  const artifacts = await artifactDependencies(input.consumerRoot, policy.packages, dependencies, inspector, input.signal);
  return preflightPublicApiPromotions(
    {
      consumerRoot: input.consumerRoot,
      policy,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    },
    [dependencies, artifacts]
  );
}

export function createPublicApiCompatibilityCapability(readAcceptedDecisions: import("./application/ports/accepted-decision-evidence.js").AcceptedArchitectureDecisionReader, assertSchema: PublicApiConfigurationDependencies["assertSchema"], inspector: JsonSchemaSetInspector): CapabilityDefinition {
  const dependencies = createDependencies(readAcceptedDecisions, assertSchema);
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      try {
        const policy = await loadCapabilityConfig(
          { readYaml: loadStrictYamlFile, assertSchema },
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        const artifacts = await artifactDependencies(invocation.consumerRoot, policy.packages, dependencies, inspector, invocation.signal);
        const input = { consumerRoot: invocation.consumerRoot, policy, ...(invocation.signal === undefined ? {} : { signal: invocation.signal }) };
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: publicApiPolicySchemaVersion(policy),
          diagnostics: [
            ...await analyzePublicApiCompatibility(input, artifacts),
            ...await analyzePublicApiCompatibility(input, dependencies)
          ]
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

async function artifactDependencies(root: string, packages: readonly import("./application/model/public-api.js").PublicApiPackagePolicy[], dependencies: ReturnType<typeof createDependencies>, inspector: JsonSchemaSetInspector, signal?: AbortSignal) {
  const inventory = new FilesystemPackageArtifactInventory(inspector, evidence);
  const artifacts = new ArtifactPublicApiEvidence(dependencies.repository, await inventory.inspect(root, packages, signal), evidence);
  return { ...dependencies, repository: artifacts, extractor: artifacts };
}

export { observedPackageExports } from "./application/policies/validate-package-export-coverage.js";
export { assertPackedWildcardMembers } from "./application/policies/compare-package-artifact-inventory.js";
export { mapReleasedArtifactBaseline } from "./adapters/outbound/filesystem/public-api-artifact-baseline.js";
export function createPackageArtifactInventory(inspector: JsonSchemaSetInspector) {
  return new FilesystemPackageArtifactInventory(inspector, evidence);
}
