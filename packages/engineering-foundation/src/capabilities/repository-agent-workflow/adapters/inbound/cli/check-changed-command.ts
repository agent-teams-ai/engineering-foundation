import type { CheckChangedDependencies } from "../../../application/ports/check-changed.js";
import { runCheckChangedAgentWorkflow, type CheckChangedInput } from "../../../application/use-cases/run-check-changed-agent-workflow.js";

export function createAgentWorkflowCheckChangedCommand(dependencies: CheckChangedDependencies): (input: CheckChangedInput & { readonly format: "json" | "text" }) => Promise<void> {
  return async (input) => {
    const report = await runCheckChangedAgentWorkflow(input, dependencies);
    dependencies.writeReport(input.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : `check-changed: ${report.outcome} (${report.reason}); ${report.steps.length} executed steps; input binding ${report.inputCustody.binding}\n`);
    dependencies.setExitCode(["passed", "feedback-only", "not-checked"].includes(report.outcome) ? 0 : 1);
  };
}
