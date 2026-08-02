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
  ...PUBLIC_API_COMPATIBILITY_RULES_BY_ID,
  ...REPOSITORY_AGENT_WORKFLOW_RULES_BY_ID,
  ...REPOSITORY_SECURITY_RULES_BY_ID,
  ...SOURCE_DEPENDENCY_RULES_BY_ID,
  ...SUPPRESSION_GOVERNANCE_RULES_BY_ID,
  ...WORKSPACE_RULES_BY_ID
]);
