import { createNodeManagedRuntimeScope, type ManagedRuntimeScopeInput,
  type NodeManagedRuntimeScope } from "../adapters/node-managed-runtime.js";

/** Explicit Host composition; no runtime is selected at import or assembly time. */
export function composeManagedRuntime(input: ManagedRuntimeScopeInput): NodeManagedRuntimeScope {
  return createNodeManagedRuntimeScope(input);
}
