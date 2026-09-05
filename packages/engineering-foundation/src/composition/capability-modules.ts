import { assertSchema, readFoundationSchema } from "../schema-catalog.js";
import { createSourceTreeReader } from "../source-inventory/module.js";
import { createWorkspaceInventoryReader } from "../workspace-inventory/module.js";
import type { CapabilityDefinition, RuleExplanation } from "../features/validation-reporting/api.js";
import {
  createJsonSchemaInspector,
  createJsonSchemaReleaseCapability,
  JSON_SCHEMA_RELEASE_RULES_BY_ID
} from "../capabilities/contract-json-schema-releases/module.js";
import {
  GovernanceAcceptedDecisionEvidenceAcl,
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
  createArchitectureDecisionGovernanceCapability,
  readAcceptedArchitectureDecisionEvidence
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

export type { RuleExplanation } from "../features/validation-reporting/api.js";

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
      createJsonSchemaReleaseCapability({ assertSchema }),
      JSON_SCHEMA_RELEASE_RULES_BY_ID
    ),
    defineCapabilityModule(
      createProtobufEvolutionCapability({ acceptedDecisionEvidence: new GovernanceAcceptedDecisionEvidenceAcl(readAcceptedArchitectureDecisionEvidence) }),
      PROTOBUF_EVOLUTION_RULES_BY_ID
    ),
    defineCapabilityModule(
      createDocumentationLocalReferencesCapability({ assertSchema }),
      DOCUMENTATION_LOCAL_REFERENCE_RULES_BY_ID
    ),
    defineCapabilityModule(
      createExecutableSpecificationsCapability({ workspaceManifestPathReader: createWorkspaceInventoryReader(), createJsonSchemaInspector, assertSchema }),
      EXECUTABLE_SPECIFICATION_RULES_BY_ID
    ),
    defineCapabilityModule(
      createArchitectureDecisionGovernanceCapability(),
      ARCHITECTURE_DECISION_GOVERNANCE_RULES_BY_ID
    ),
    defineCapabilityModule(
      createPublicApiCompatibilityCapability(readAcceptedArchitectureDecisionEvidence),
      PUBLIC_API_COMPATIBILITY_RULES_BY_ID
    ),
    defineCapabilityModule(
      createQualityGateRunnerCapability({ assertSchema }),
      QUALITY_GATE_RUNNER_RULES_BY_ID
    ),
    defineCapabilityModule(
      createRepositoryAgentWorkflowCapability({ assertSchema }),
      REPOSITORY_AGENT_WORKFLOW_RULES_BY_ID
    ),
    defineCapabilityModule(
      createRepositorySecurityBaselineCapability({ assertSchema }),
      REPOSITORY_SECURITY_RULES_BY_ID
    ),
    defineCapabilityModule(
      createSourceDependenciesCapability({ inventoryReader: createWorkspaceInventoryReader(), sourceReader: createSourceTreeReader(), assertSchema }),
      SOURCE_DEPENDENCY_RULES_BY_ID
    ),
    defineCapabilityModule(
      createSuppressionGovernanceCapability({ sourceReader: createSourceTreeReader(), assertSchema }),
      SUPPRESSION_GOVERNANCE_RULES_BY_ID
    ),
    defineCapabilityModule(
      createWorkspaceDependencyDeclarationsCapability(createWorkspaceInventoryReader(), readFoundationSchema),
      WORKSPACE_RULES_BY_ID
    )
  ]);
