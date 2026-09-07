import type { AgentWorkflowChangedDependencies } from "../../../application/ports/changed-command.js";
import { renderAgentWorkflowReport } from "./report-renderer.js";
import { runChangedAgentWorkflow } from "../../../application/use-cases/run-changed-agent-workflow.js";

export interface AgentWorkflowChangedInput {
  readonly consumerRoot: string;
  readonly format: "json" | "text";
  readonly baseRef?: string;
  readonly configPath: string;
  readonly signal?: AbortSignal;
}

export function createAgentWorkflowChangedCommand(
  dependencies: AgentWorkflowChangedDependencies
): (input: AgentWorkflowChangedInput) => Promise<void> {
  return async (input) => {
    const report = await runChangedAgentWorkflow(
      {
        consumerRoot: input.consumerRoot,
        policy: await dependencies.loadPolicy(
          input.consumerRoot,
          input.configPath,
          input.signal
        ),
        ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
        ...(input.signal === undefined ? {} : { signal: input.signal })
      },
      dependencies.changesReader,
      dependencies.scriptRunner
    );
    process.stdout.write(
      input.format === "json"
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderAgentWorkflowReport(report)
    );
    process.exitCode = report.outcome === "passed" ? 0 : 1;
  };
}
