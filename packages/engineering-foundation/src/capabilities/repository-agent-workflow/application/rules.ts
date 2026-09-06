import { createUniqueRegistry } from "../../../features/validation-reporting/api.js";

export interface RepositoryAgentWorkflowRuleMetadata {
  readonly id: string;
  readonly rationale: string;
  readonly remediation: string;
  readonly documentation: string;
}

const DOCUMENTATION =
  "https://github.com/agent-teams-ai/engineering-foundation/blob/main/docs/reference/repository-agent-workflow.md";

const rules: readonly RepositoryAgentWorkflowRuleMetadata[] = [
  {
    id: "repository.agent-workflow.instruction-file-invalid",
    rationale: "Every supported agent must receive the repository's canonical instructions.",
    remediation: "Create a regular, bounded instruction file at the configured path.",
    documentation: DOCUMENTATION
  },
  {
    id: "repository.agent-workflow.adapter-not-linked",
    rationale: "Provider-specific instruction adapters must route to one canonical source.",
    remediation: "Import or explicitly reference the configured canonical instruction file.",
    documentation: DOCUMENTATION
  },
  {
    id: "repository.agent-workflow.command-not-documented",
    rationale: "Agents need exact, stable commands instead of prose-only quality expectations.",
    remediation: "Document the configured changed, fast, and full verification scripts.",
    documentation: DOCUMENTATION
  },
  {
    id: "repository.agent-workflow.package-script-missing",
    rationale: "A documented workflow is reproducible only when every referenced script exists.",
    remediation: "Add the missing package script or update the workflow policy.",
    documentation: DOCUMENTATION
  },
  {
    id: "repository.agent-workflow.changed-runner-invalid",
    rationale: "Changed-file discovery must use the shared Foundation implementation.",
    remediation: "Route the configured changed script to the installed CLI or Foundation's exact built self-dogfood entrypoint.",
    documentation: DOCUMENTATION
  }
];

export const REPOSITORY_AGENT_WORKFLOW_RULES_BY_ID: ReadonlyMap<
  string,
  RepositoryAgentWorkflowRuleMetadata
> = createUniqueRegistry("rule", rules.map((rule) => [rule.id, rule]));
