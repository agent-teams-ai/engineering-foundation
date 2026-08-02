import type { AgentWorkflowChangedReport } from "../../../application/model/changed-workflow.js";

export function renderAgentWorkflowReport(report: AgentWorkflowChangedReport): string {
  const displayedPaths = report.changedPaths.slice(0, 50);
  const lines = [
    `Agent workflow: ${report.outcome}`,
    `Coverage: ${report.coverage}`,
    `Baseline: ${report.baselineRef}${report.baselineCommit === null ? "" : ` (${report.baselineCommit})`}`,
    `Changed paths: ${report.changedPaths.length}`
  ];
  if (report.changedPaths.length > 0) {
    lines.push(...displayedPaths.map((path) => `  ${path}`));
    if (displayedPaths.length < report.changedPaths.length) {
      lines.push(`  ... ${report.changedPaths.length - displayedPaths.length} more`);
    }
  }
  if (report.steps.length === 0) {
    lines.push("Checks: none required for the changed paths");
  }
  for (const step of report.steps) {
    lines.push(`Check ${step.id}: ${step.outcome} (${step.script}, ${step.paths.length} paths)`);
    if (step.output.length > 0) {
      lines.push(step.output);
    }
  }
  return `${lines.join("\n")}\n`;
}
