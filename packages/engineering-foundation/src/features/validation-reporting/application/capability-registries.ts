import type { RuleExplanation } from "./model.js";
import type { CapabilityDefinition } from "./reporting.js";
import { createUniqueRegistry } from "./unique-registry.js";

export interface CapabilityModuleDescriptor {
  readonly definition: CapabilityDefinition;
  readonly rules: ReadonlyMap<string, RuleExplanation>;
}

export function createCapabilityModule(
  definition: CapabilityDefinition,
  rules: ReadonlyMap<string, RuleExplanation>
): CapabilityModuleDescriptor {
  return Object.freeze({ definition, rules });
}

export function createCapabilityModules(
  modules: readonly CapabilityModuleDescriptor[]
): readonly CapabilityModuleDescriptor[] {
  return Object.freeze(modules);
}

interface CapabilityContribution {
  readonly definition: CapabilityDefinition;
}

interface RuleContribution {
  readonly rules: ReadonlyMap<string, RuleExplanation>;
}

interface OwnedRuleContribution extends RuleContribution {
  readonly definition: Pick<CapabilityDefinition, "id">;
}

export function createCapabilityRegistry(
  modules: readonly CapabilityContribution[]
): ReadonlyMap<string, CapabilityDefinition> {
  return createUniqueRegistry(
    "capability",
    modules.map(({ definition }) => [definition.id, definition])
  );
}

export function createRuleRegistries(
  modules: readonly RuleContribution[]
): readonly ReadonlyMap<string, RuleExplanation>[] {
  return Object.freeze(modules.map(({ rules }) => rules));
}

export function createRuleRegistry(
  modules: readonly OwnedRuleContribution[]
): ReadonlyMap<string, RuleExplanation> {
  // Validate all metadata before duplicate detection, preserving diagnostic precedence.
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
