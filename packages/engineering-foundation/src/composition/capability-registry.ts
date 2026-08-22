import type { CapabilityDefinition } from "../capability-runtime.js";
import { createUniqueRegistry } from "../unique-registry.js";
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
