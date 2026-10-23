import { parseAgentWorkflowPolicy } from "./parse-agent-workflow-policy.js";
import { parseAgentWorkflowPolicyV2 } from "./parse-agent-workflow-policy-v2.js";
import type { AgentWorkflowV2ConfigurationDependencies } from "./load-agent-workflow-policy-v2.js";
import type { RepositoryAgentWorkflowPolicy } from "../../../application/model/repository-agent-workflow.js";
import type { WorkflowCoveragePolicy } from "../../../application/model/check-changed.js";

export interface VersionedWorkflowDependencies {
  readonly readYaml: AgentWorkflowV2ConfigurationDependencies["readYaml"];
  readonly assertSchema: (
    id: "repository-agent-workflow/v1" | "repository-agent-workflow/v2",
    value: unknown,
    phase: string,
  ) => Promise<void>;
}
/** Preserve the declared schema identity independently of the policy shape.
 * Unsupported versions retain the historical v1 schema diagnostic. */
export function agentWorkflowConfigVersion(value: unknown): 1 | 2 {
  return typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 2
    ? 2
    : 1;
}
export async function loadVersionedAgentWorkflowPolicy(
  dependencies: VersionedWorkflowDependencies,
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<
  | {
      readonly kind: "legacy";
      readonly version: 1 | 2;
      readonly policy: RepositoryAgentWorkflowPolicy;
    }
  | { readonly kind: "coverage"; readonly version: 2; readonly policy: WorkflowCoveragePolicy }
> {
  const value = await dependencies.readYaml(root, path, "repository-agent-workflow-config", signal);
  const version = agentWorkflowConfigVersion(value);
  // Any own coverage field commits v2 to coverage validation, even when the
  // remaining fields are missing or legacy fields are also present.
  const coverage =
    version === 2 &&
    typeof value === "object" &&
    value !== null &&
    ["scopes", "checks", "exclusions", "escalationCheck"].some((field) =>
      Object.hasOwn(value, field),
    );
  if (coverage) {
    const policy = parseAgentWorkflowPolicyV2(value);
    await dependencies.assertSchema(
      "repository-agent-workflow/v2",
      value,
      "repository-agent-workflow-config",
    );
    return { kind: "coverage", version: 2, policy };
  }
  await dependencies.assertSchema(
    version === 2 ? "repository-agent-workflow/v2" : "repository-agent-workflow/v1",
    value,
    "repository-agent-workflow-config",
  );
  return { kind: "legacy", version, policy: parseAgentWorkflowPolicy(value, path) };
}
