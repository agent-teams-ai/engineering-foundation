import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import { assertNotCancelled } from "../../../../features/validation-reporting/api.js";
import type { RepositoryAgentWorkflowPolicy } from "../model/repository-agent-workflow.js";
import { evaluateRepositoryAgentWorkflow } from "../policies/evaluate-repository-agent-workflow.js";
import type { RepositoryAgentWorkflowReader } from "../ports/repository-agent-workflow-reader.js";

export async function analyzeRepositoryAgentWorkflow(
  input: {
    readonly consumerRoot: string;
    readonly policy: RepositoryAgentWorkflowPolicy;
    readonly signal?: AbortSignal;
  },
  reader: RepositoryAgentWorkflowReader
): Promise<readonly FoundationDiagnostic[]> {
  assertNotCancelled(input.signal);
  return evaluateRepositoryAgentWorkflow(
    input.policy,
    await reader.read(input.consumerRoot, input.policy, input.signal)
  );
}
