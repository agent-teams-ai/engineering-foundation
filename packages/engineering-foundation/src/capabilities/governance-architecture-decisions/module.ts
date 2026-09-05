import { resolveAcceptedArchitectureDecisionEvidence } from "./application/use-cases/resolve-accepted-architecture-decision-evidence.js";
import {
  capabilityFailureReport,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../features/validation-reporting/api.js";
import { FilesystemMarkdownRepository } from "@agent-teams/document-authoring/observation";
import { NodeArchitectureDecisionFingerprint } from "./adapters/outbound/crypto/node-architecture-decision-fingerprint.js";
import { FilesystemArchitectureDecisionBaselineRepository } from "./adapters/outbound/filesystem/filesystem-architecture-decision-baseline-repository.js";
import { ARCHITECTURE_DECISION_GOVERNANCE_RULES_BY_ID } from "./application/rules.js";
import {
  analyzeArchitectureDecisions
} from "./application/use-cases/analyze-architecture-decisions.js";
import { promoteArchitectureDecisionBaseline as promoteBaseline } from "./application/use-cases/promote-architecture-decision-baseline.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID
} from "./contract/config.js";

import { loadCapabilityConfig, type ArchitectureDecisionConfigurationDependencies } from "./adapters/inbound/configuration/load-capability-config.js";
import { loadStrictYamlFile } from "../../features/configuration-input/node.js";

export { ARCHITECTURE_DECISION_GOVERNANCE_RULES_BY_ID };

export type { AcceptedArchitectureDecisionEvidence } from "./api.js";
import type { AcceptedArchitectureDecisionEvidence } from "./api.js";

function createDependencies() {
  return Object.freeze({
    baselineRepository: new FilesystemArchitectureDecisionBaselineRepository(),
    fingerprint: new NodeArchitectureDecisionFingerprint(),
    markdownRepository: new FilesystemMarkdownRepository()
  });
}

export async function promoteArchitectureDecisionBaseline(input: {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly signal?: AbortSignal;
}, assertSchema: ArchitectureDecisionConfigurationDependencies["assertSchema"]) {
  const policy = await loadCapabilityConfig(
    { readYaml: loadStrictYamlFile, assertSchema },
    input.consumerRoot,
    input.configPath,
    input.signal
  );
  return promoteBaseline(
    {
      consumerRoot: input.consumerRoot,
      policy,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    },
    createDependencies()
  );
}

/**
 * Provides a narrow, validated view of accepted ADR history to another
 * capability. The caller receives only stable IDs and immutable historical
 * paths; the governance catalog, baseline, immutable digests, and lifecycle
 * validation remain owned here.
 */
export async function readAcceptedArchitectureDecisionEvidence(input: {
  readonly baselinePath: string;
  readonly configPath: string;
  readonly consumerRoot: string;
  readonly signal?: AbortSignal;
}, assertSchema: ArchitectureDecisionConfigurationDependencies["assertSchema"]): Promise<AcceptedArchitectureDecisionEvidence> {
  const dependencies = createDependencies();
  const policy = await loadCapabilityConfig(
    { readYaml: loadStrictYamlFile, assertSchema },    input.consumerRoot,
    input.configPath,
    input.signal
  );
  return resolveAcceptedArchitectureDecisionEvidence({
    consumerRoot: input.consumerRoot, baselinePath: input.baselinePath, policy,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  }, dependencies);
}

export function createArchitectureDecisionGovernanceCapability(input: {
  readonly assertSchema: ArchitectureDecisionConfigurationDependencies["assertSchema"];
}): CapabilityDefinition {
  return Object.freeze({
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    id: CAPABILITY_ID,
    async run(invocation: CapabilityInvocation) {
      try {
        const dependencies = createDependencies();
        const policy = await loadCapabilityConfig(
          { readYaml: loadStrictYamlFile, assertSchema: input.assertSchema },
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        return capabilityReport({
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          capabilityId: CAPABILITY_ID,
          diagnostics: await analyzeArchitectureDecisions(
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
          phase: "architecture-decision-governance-execution"
        });
      }
    }
  });
}
