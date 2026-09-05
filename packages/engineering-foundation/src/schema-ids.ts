// Module assembly indexes feature-owned identities in the established public order.
import { SOURCE_DEPENDENCIES_SCHEMA_IDS } from "./capabilities/source-dependencies/schemas.js";
import { CONTRACT_JSON_SCHEMA_RELEASES_SCHEMA_IDS } from "./capabilities/contract-json-schema-releases/schemas.js";
import { CONTRACT_PROTOBUF_EVOLUTION_SCHEMA_IDS } from "./capabilities/contract-protobuf-evolution/schemas.js";
import { DOCUMENTATION_LOCAL_REFERENCES_SCHEMA_IDS } from "./capabilities/documentation-local-references/schemas.js";
import { COMMAND_HOST_SCHEMA_IDS } from "./features/command-host/schemas.js";
import { FOUNDATION_CHECK_SCHEMA_IDS } from "./features/foundation-check/schemas.js";
import { VALIDATION_REPORTING_SCHEMA_IDS } from "./features/validation-reporting/schemas.js";
import { TRANSACTION_COORDINATION_SCHEMA_IDS } from "./transaction-coordination/schemas.js";
import { GOVERNANCE_ARCHITECTURE_DECISIONS_SCHEMA_IDS } from "./capabilities/governance-architecture-decisions/schemas.js";
import { PUBLIC_API_COMPATIBILITY_SCHEMA_IDS } from "./capabilities/public-api-compatibility/schemas.js";
import { EXECUTABLE_SPECIFICATIONS_SCHEMA_IDS } from "./capabilities/executable-specifications/schemas.js";
import { QUALITY_GATE_RUNNER_SCHEMA_IDS } from "./capabilities/quality-gate-runner/schemas.js";
import { SUPPRESSION_GOVERNANCE_SCHEMA_IDS } from "./capabilities/suppression-governance/schemas.js";
import { REPOSITORY_AGENT_WORKFLOW_SCHEMA_IDS } from "./capabilities/repository-agent-workflow/schemas.js";
import { REPOSITORY_SECURITY_BASELINE_SCHEMA_IDS } from "./capabilities/repository-security-baseline/schemas.js";
import { SCAFFOLDING_SCHEMA_IDS } from "./scaffolding/schemas.js";
import { WORKSPACE_DEPENDENCY_DECLARATIONS_SCHEMA_IDS } from "./capabilities/workspace-dependency-declarations/schemas.js";

export const FOUNDATION_SCHEMA_IDS = [
  ...SOURCE_DEPENDENCIES_SCHEMA_IDS,
  ...CONTRACT_JSON_SCHEMA_RELEASES_SCHEMA_IDS,
  ...CONTRACT_PROTOBUF_EVOLUTION_SCHEMA_IDS,
  ...DOCUMENTATION_LOCAL_REFERENCES_SCHEMA_IDS,
  ...COMMAND_HOST_SCHEMA_IDS,
  ...FOUNDATION_CHECK_SCHEMA_IDS,
  ...VALIDATION_REPORTING_SCHEMA_IDS,
  ...TRANSACTION_COORDINATION_SCHEMA_IDS,
  ...GOVERNANCE_ARCHITECTURE_DECISIONS_SCHEMA_IDS,
  ...PUBLIC_API_COMPATIBILITY_SCHEMA_IDS,
  ...EXECUTABLE_SPECIFICATIONS_SCHEMA_IDS,
  ...QUALITY_GATE_RUNNER_SCHEMA_IDS,
  ...SUPPRESSION_GOVERNANCE_SCHEMA_IDS,
  ...REPOSITORY_AGENT_WORKFLOW_SCHEMA_IDS,
  ...REPOSITORY_SECURITY_BASELINE_SCHEMA_IDS,
  ...SCAFFOLDING_SCHEMA_IDS,
  ...WORKSPACE_DEPENDENCY_DECLARATIONS_SCHEMA_IDS
] as const;

export type FoundationSchemaId = (typeof FOUNDATION_SCHEMA_IDS)[number];

export type FoundationSchemaCatalogId = FoundationSchemaId;
