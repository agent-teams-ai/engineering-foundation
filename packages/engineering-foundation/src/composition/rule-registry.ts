import {
  createRuleRegistries,
  createRuleRegistry as createRegistry
} from "../features/validation-reporting/api.js";
import {
  CAPABILITY_MODULES,
  type CapabilityModuleDescriptor,
  type RuleExplanation
} from "./capability-modules.js";

export type { RuleExplanation } from "./capability-modules.js";

export const RULE_REGISTRIES: readonly ReadonlyMap<
  string,
  RuleExplanation
>[] = createRuleRegistries(CAPABILITY_MODULES);

export function createRuleRegistry(
  modules: readonly CapabilityModuleDescriptor[]
): ReadonlyMap<string, RuleExplanation> {
  return createRegistry(modules);
}

export const RULE_REGISTRY: ReadonlyMap<string, RuleExplanation> =
  createRuleRegistry(CAPABILITY_MODULES);
