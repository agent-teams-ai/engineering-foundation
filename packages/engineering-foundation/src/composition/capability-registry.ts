import type { CapabilityDefinition } from "../capability-runtime.js";
import { createWorkspaceDependencyDeclarationsCapability } from "../capabilities/workspace-dependency-declarations/module.js";

const capabilities: readonly CapabilityDefinition[] = Object.freeze([
  createWorkspaceDependencyDeclarationsCapability()
]);

export const CAPABILITY_REGISTRY: ReadonlyMap<string, CapabilityDefinition> =
  new Map(capabilities.map((capability) => [capability.id, capability]));
