import type { CapabilityDefinition } from "../capability-runtime.js";
import { createPublicApiCompatibilityCapability } from "../capabilities/public-api-compatibility/module.js";
import { createRepositoryAgentWorkflowCapability } from "../capabilities/repository-agent-workflow/module.js";
import { createRepositorySecurityBaselineCapability } from "../capabilities/repository-security-baseline/module.js";
import { createSourceDependenciesCapability } from "../capabilities/source-dependencies/module.js";
import { createSuppressionGovernanceCapability } from "../capabilities/suppression-governance/module.js";
import { createWorkspaceDependencyDeclarationsCapability } from "../capabilities/workspace-dependency-declarations/module.js";

const capabilities: readonly CapabilityDefinition[] = Object.freeze([
  createPublicApiCompatibilityCapability(),
  createRepositoryAgentWorkflowCapability(),
  createRepositorySecurityBaselineCapability(),
  createSourceDependenciesCapability(),
  createSuppressionGovernanceCapability(),
  createWorkspaceDependencyDeclarationsCapability()
]);

export const CAPABILITY_REGISTRY: ReadonlyMap<string, CapabilityDefinition> =
  new Map(capabilities.map((capability) => [capability.id, capability]));
