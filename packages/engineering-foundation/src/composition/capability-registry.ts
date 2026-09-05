import type { CapabilityDefinition } from "../features/validation-reporting/api.js";
import { createUniqueRegistry } from "../features/validation-reporting/api.js";
import {
  CAPABILITY_MODULES,
  type CapabilityModuleDescriptor
} from "./capability-modules.js";

export function createCapabilityRegistry(
  modules: readonly CapabilityModuleDescriptor[]
): ReadonlyMap<string, CapabilityDefinition> {
  return createUniqueRegistry(
    "capability",
    modules.map(({ definition }) => [definition.id, definition])
  );
}

export const CAPABILITY_REGISTRY: ReadonlyMap<string, CapabilityDefinition> =
  createCapabilityRegistry(CAPABILITY_MODULES);
