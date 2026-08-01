import { SOURCE_DEPENDENCY_RULES_BY_ID } from "../capabilities/source-dependencies/module.js";
import { RULES_BY_ID as WORKSPACE_RULES_BY_ID } from "../capabilities/workspace-dependency-declarations/module.js";

export interface RuleExplanation {
  readonly id: string;
  readonly rationale: string;
  readonly remediation: string;
  readonly documentation: string;
}

export const RULE_REGISTRY: ReadonlyMap<string, RuleExplanation> = new Map([
  ...SOURCE_DEPENDENCY_RULES_BY_ID,
  ...WORKSPACE_RULES_BY_ID
]);
