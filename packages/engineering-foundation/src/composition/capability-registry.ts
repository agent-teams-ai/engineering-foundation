import type { CapabilityDefinition } from "../features/validation-reporting/api.js";
import { createCapabilityRegistry as createRegistry } from "../features/validation-reporting/api.js";
import {
  CAPABILITY_MODULES,
  type CapabilityModuleDescriptor
} from "./capability-modules.js";

export function createCapabilityRegistry(
  modules: readonly CapabilityModuleDescriptor[]
): ReadonlyMap<string, CapabilityDefinition> {
  return createRegistry(modules);
}

export const CAPABILITY_REGISTRY: ReadonlyMap<string, CapabilityDefinition> =
  createCapabilityRegistry(CAPABILITY_MODULES);
