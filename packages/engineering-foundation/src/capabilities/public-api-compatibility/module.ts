import { createManagedProcessExecutor } from "../../process-execution/module.js";
import { assertGrowthReportDestination } from "./adapters/inbound/configuration/parse-growth-config.js";
import { readGrowthInvocation, assertGrowthDestination } from "./adapters/outbound/filesystem/growth-invocation.js";
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
import { configurationInputError } from "./application/configuration-input.js";
import { createWorkspaceInventoryReader } from "../../workspace-inventory/module.js";
import { createWorkspaceGrowthReader } from "./adapters/outbound/filesystem/workspace-growth-reader.js";
import { createFilesystemGrowthInputContext } from "./adapters/outbound/filesystem/growth-input-context.js";
import { createFilesystemGrowthReportWriter } from "./adapters/outbound/filesystem/growth-report-writer.js";
import { checkSdkGrowth } from "./application/use-cases/check-sdk-growth.js";

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
  if (policy.schemaVersion === 2) {
    configurationInputError("SDK growth release promotion requires the separately qualified S3 authority route.");
  }
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
  const processes = createManagedProcessExecutor();
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      let configVersion: number = CAPABILITY_CONFIG_SCHEMA_VERSION;
      try {
        const policy = await loadCapabilityConfig(
          { readYaml: loadStrictYamlFile, assertSchema },
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        configVersion = policy.schemaVersion;
        if (policy.schemaVersion === 2) {
          await assertGrowthDestination(invocation.consumerRoot, policy.sdkGrowth.reportPath);
          const inventory = await createWorkspaceGrowthReader(createWorkspaceInventoryReader()).read(invocation.consumerRoot, "pnpm-workspace.yaml", invocation.signal);
          assertGrowthReportDestination(policy.sdkGrowth.reportPath, inventory.packages.flatMap((pkg) => [pkg.rootPath, pkg.manifestPath]));
          const identityInputs = { files: evidence.files, runGit: (args: readonly string[], signal?: AbortSignal) =>
            processes.run({ command: "git", args, cwd: invocation.consumerRoot, timeoutMs: 10_000,
              ...(signal === undefined ? {} : { signal }) }) };
          return await checkSdkGrowth({ consumerRoot: invocation.consumerRoot, policy,
            invocation: await readGrowthInvocation(invocation.consumerRoot, inventory, identityInputs, invocation.signal),
            ...(invocation.signal === undefined ? {} : { signal: invocation.signal }) }, {
            readInvocation: (cancellation) => readGrowthInvocation(invocation.consumerRoot, inventory, identityInputs, cancellation.signal),
            repository: dependencies.repository, fingerprint: dependencies.fingerprint, typed: dependencies.extractor,
            artifact: new FilesystemPackageArtifactInventory(inspector, evidence),
            workspace: { read: async () => inventory },
            context: createFilesystemGrowthInputContext({ consumerRoot: invocation.consumerRoot, policy: policy.compatibility }, { ...dependencies, assertSchema }),
            writer: createFilesystemGrowthReportWriter(invocation.consumerRoot)
          });
        }
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
          capabilityConfigSchemaVersion: configVersion,
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
