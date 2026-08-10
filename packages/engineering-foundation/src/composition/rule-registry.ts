import { JSON_SCHEMA_RELEASE_RULES_BY_ID } from "../capabilities/contract-json-schema-releases/module.js";
import { PROTOBUF_EVOLUTION_RULES_BY_ID } from "../capabilities/contract-protobuf-evolution/module.js";
import { DOCUMENTATION_LOCAL_REFERENCE_RULES_BY_ID } from "../capabilities/documentation-local-references/module.js";
import { EXECUTABLE_SPECIFICATION_RULES_BY_ID } from "../capabilities/executable-specifications/module.js";
import { ARCHITECTURE_DECISION_GOVERNANCE_RULES_BY_ID } from "../capabilities/governance-architecture-decisions/module.js";
import { PUBLIC_API_COMPATIBILITY_RULES_BY_ID } from "../capabilities/public-api-compatibility/module.js";
import { REPOSITORY_AGENT_WORKFLOW_RULES_BY_ID } from "../capabilities/repository-agent-workflow/module.js";
import { REPOSITORY_SECURITY_RULES_BY_ID } from "../capabilities/repository-security-baseline/module.js";
import { SOURCE_DEPENDENCY_RULES_BY_ID } from "../capabilities/source-dependencies/module.js";
import { SUPPRESSION_GOVERNANCE_RULES_BY_ID } from "../capabilities/suppression-governance/module.js";
import { RULES_BY_ID as WORKSPACE_RULES_BY_ID } from "../capabilities/workspace-dependency-declarations/module.js";

export interface RuleExplanation {
  readonly id: string;
  readonly rationale: string;
  readonly remediation: string;
  readonly documentation: string;
}

export const RULE_REGISTRY: ReadonlyMap<string, RuleExplanation> = new Map([
  ...JSON_SCHEMA_RELEASE_RULES_BY_ID,
  ...PROTOBUF_EVOLUTION_RULES_BY_ID,
  ...DOCUMENTATION_LOCAL_REFERENCE_RULES_BY_ID,
  ...EXECUTABLE_SPECIFICATION_RULES_BY_ID,
  ...ARCHITECTURE_DECISION_GOVERNANCE_RULES_BY_ID,
  ...PUBLIC_API_COMPATIBILITY_RULES_BY_ID,
  ...REPOSITORY_AGENT_WORKFLOW_RULES_BY_ID,
  ...REPOSITORY_SECURITY_RULES_BY_ID,
  ...SOURCE_DEPENDENCY_RULES_BY_ID,
  ...SUPPRESSION_GOVERNANCE_RULES_BY_ID,
  ...WORKSPACE_RULES_BY_ID
]);
