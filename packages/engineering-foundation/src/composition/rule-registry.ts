import {
  createRuleRegistries,
  createRuleRegistry as createRegistry
} from "../features/validation-reporting/api.js";
import { FINDINGS_BASELINE_RULES_BY_ID } from "../capabilities/findings-baseline/module.js";
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

type RuleOwner = Pick<CapabilityModuleDescriptor, "rules"> & { readonly definition: Pick<CapabilityModuleDescriptor["definition"], "id"> };

export function createRuleRegistry(
  modules: readonly RuleOwner[]
): ReadonlyMap<string, RuleExplanation> {
  return createRegistry(modules);
}

/** Rules of command-only modules: they run through their own commands, not the `check` capability registry, but `explain` still shows them. */
const COMMAND_RULE_MODULES: readonly RuleOwner[] = [
  { definition: { id: "quality.findings-baseline" }, rules: FINDINGS_BASELINE_RULES_BY_ID }
];

export const RULE_REGISTRY: ReadonlyMap<string, RuleExplanation> =
  createRuleRegistry([...CAPABILITY_MODULES, ...COMMAND_RULE_MODULES]);
