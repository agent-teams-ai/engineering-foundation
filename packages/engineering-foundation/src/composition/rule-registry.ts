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
  return createUniqueRegistry(
    "rule",
    modules.flatMap(({ rules }) => [...rules])
  );
}

export const RULE_REGISTRY: ReadonlyMap<string, RuleExplanation> =
  createRuleRegistry(CAPABILITY_MODULES);
