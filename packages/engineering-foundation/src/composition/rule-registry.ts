import { createUniqueRegistry } from "../unique-registry.js";
import {
  CAPABILITY_MODULES,
  type CapabilityModuleDescriptor,
  type RuleExplanation
} from "./capability-modules.js";

export type { RuleExplanation } from "./capability-modules.js";

export const RULE_REGISTRIES: readonly ReadonlyMap<
  string,
  RuleExplanation
>[] = Object.freeze(CAPABILITY_MODULES.map(({ rules }) => rules));

export function createRuleRegistry(
  modules: readonly CapabilityModuleDescriptor[]
): ReadonlyMap<string, RuleExplanation> {
  for (const { definition, rules } of modules) {
    const ownedRulePrefix = `${definition.id}.`;
    for (const [ruleId, explanation] of rules) {
      if (explanation.id !== ruleId) {
        throw new Error(
          `Rule registry key ${ruleId} does not match metadata ID ${explanation.id}.`
        );
      }
      if (!ruleId.startsWith(ownedRulePrefix)) {
        throw new Error(
          `Rule ID ${ruleId} is not owned by capability ${definition.id}.`
        );
      }
    }
  }
  return createUniqueRegistry(
    "rule",
    modules.flatMap(({ rules }) => [...rules])
  );
}

export const RULE_REGISTRY: ReadonlyMap<string, RuleExplanation> =
  createRuleRegistry(CAPABILITY_MODULES);
