import type { CapabilityDefinition } from "../capability-runtime.js";
import {
  createJsonSchemaReleaseCapability,
  JSON_SCHEMA_RELEASE_RULES_BY_ID
} from "../capabilities/contract-json-schema-releases/module.js";
import {
  createProtobufEvolutionCapability,
  PROTOBUF_EVOLUTION_RULES_BY_ID
} from "../capabilities/contract-protobuf-evolution/module.js";
import {
  createDocumentationLocalReferencesCapability,
  DOCUMENTATION_LOCAL_REFERENCE_RULES_BY_ID
} from "../capabilities/documentation-local-references/module.js";
import {
  createExecutableSpecificationsCapability,
  EXECUTABLE_SPECIFICATION_RULES_BY_ID
} from "../capabilities/executable-specifications/module.js";
import {
  ARCHITECTURE_DECISION_GOVERNANCE_RULES_BY_ID,
  createArchitectureDecisionGovernanceCapability
} from "../capabilities/governance-architecture-decisions/module.js";
import {
  createPublicApiCompatibilityCapability,
  PUBLIC_API_COMPATIBILITY_RULES_BY_ID
} from "../capabilities/public-api-compatibility/module.js";
import {
  createQualityGateRunnerCapability,
  QUALITY_GATE_RUNNER_RULES_BY_ID
} from "../capabilities/quality-gate-runner/module.js";
import {
  createRepositoryAgentWorkflowCapability,
  REPOSITORY_AGENT_WORKFLOW_RULES_BY_ID
} from "../capabilities/repository-agent-workflow/module.js";
import {
  createRepositorySecurityBaselineCapability,
  REPOSITORY_SECURITY_RULES_BY_ID
} from "../capabilities/repository-security-baseline/module.js";
import {
  createSourceDependenciesCapability,
  SOURCE_DEPENDENCY_RULES_BY_ID
} from "../capabilities/source-dependencies/module.js";
import {
  createSuppressionGovernanceCapability,
  SUPPRESSION_GOVERNANCE_RULES_BY_ID
} from "../capabilities/suppression-governance/module.js";
import {
  createWorkspaceDependencyDeclarationsCapability,
  RULES_BY_ID as WORKSPACE_RULES_BY_ID
} from "../capabilities/workspace-dependency-declarations/module.js";

export interface RuleExplanation {
  readonly id: string;
  readonly rationale: string;
  readonly remediation: string;
  readonly documentation: string;
}

export interface CapabilityModuleDescriptor {
  readonly definition: CapabilityDefinition;
  readonly rules: ReadonlyMap<string, RuleExplanation>;
}

function defineCapabilityModule(
  definition: CapabilityDefinition,
  rules: ReadonlyMap<string, RuleExplanation>
): CapabilityModuleDescriptor {
  return Object.freeze({ definition, rules });
}

export const CAPABILITY_MODULES: readonly CapabilityModuleDescriptor[] =
  Object.freeze([
    defineCapabilityModule(
      createJsonSchemaReleaseCapability(),
      JSON_SCHEMA_RELEASE_RULES_BY_ID
    ),
    defineCapabilityModule(
      createProtobufEvolutionCapability(),
      PROTOBUF_EVOLUTION_RULES_BY_ID
    ),
    defineCapabilityModule(
      createDocumentationLocalReferencesCapability(),
      DOCUMENTATION_LOCAL_REFERENCE_RULES_BY_ID
    ),
    defineCapabilityModule(
      createExecutableSpecificationsCapability(),
      EXECUTABLE_SPECIFICATION_RULES_BY_ID
    ),
    defineCapabilityModule(
      createArchitectureDecisionGovernanceCapability(),
      ARCHITECTURE_DECISION_GOVERNANCE_RULES_BY_ID
    ),
    defineCapabilityModule(
      createPublicApiCompatibilityCapability(),
      PUBLIC_API_COMPATIBILITY_RULES_BY_ID
    ),
    defineCapabilityModule(
      createQualityGateRunnerCapability(),
      QUALITY_GATE_RUNNER_RULES_BY_ID
    ),
    defineCapabilityModule(
      createRepositoryAgentWorkflowCapability(),
      REPOSITORY_AGENT_WORKFLOW_RULES_BY_ID
    ),
    defineCapabilityModule(
      createRepositorySecurityBaselineCapability(),
      REPOSITORY_SECURITY_RULES_BY_ID
    ),
    defineCapabilityModule(
      createSourceDependenciesCapability(),
      SOURCE_DEPENDENCY_RULES_BY_ID
    ),
    defineCapabilityModule(
      createSuppressionGovernanceCapability(),
      SUPPRESSION_GOVERNANCE_RULES_BY_ID
    ),
    defineCapabilityModule(
      createWorkspaceDependencyDeclarationsCapability(),
      WORKSPACE_RULES_BY_ID
    )
  ]);
