import {
  createRuleOwners,
  createRuleRegistries,
  createRuleRegistry as createRegistry,
  type OwnedRuleContribution
} from "../features/validation-reporting/api.js";
import { FINDINGS_BASELINE_COMMAND_RULES } from "../capabilities/findings-baseline/module.js";
import {
  CAPABILITY_MODULES,
  type RuleExplanation
} from "./capability-modules.js";

export type { RuleExplanation } from "./capability-modules.js";

export const RULE_REGISTRIES: readonly ReadonlyMap<
  string,
  RuleExplanation
>[] = createRuleRegistries(CAPABILITY_MODULES);

export function createRuleRegistry(
  modules: readonly OwnedRuleContribution[]
): ReadonlyMap<string, RuleExplanation> {
  return createRegistry(modules);
}

export const RULE_REGISTRY: ReadonlyMap<string, RuleExplanation> =
  createRuleRegistry(createRuleOwners(CAPABILITY_MODULES, [FINDINGS_BASELINE_COMMAND_RULES]));
