import type { AgentWorkflowChangedReport } from "../../../application/model/changed-workflow.js";
import type { EffectiveInstructionsReport } from "../../../application/model/effective-instructions.js";

export function renderAgentWorkflowReport(report: AgentWorkflowChangedReport): string {
  const displayedPaths = report.changedPaths.slice(0, 50);
  const lines = [
    `Agent workflow: ${report.outcome}`,
    `Coverage: ${report.coverage}`,
    `Baseline: ${report.baselineRef}${report.baselineCommit === null ? "" : ` (${report.baselineCommit})`}`,
    `Base: ${report.resolvedBaseRef}${report.baseCommit === null ? "" : ` (${report.baseCommit})`}`,
    `Head: ${report.headRef}${report.headCommit === null ? "" : ` (${report.headCommit})`}`,
    `Merge base: ${report.mergeBaseCommit ?? "none"}`,
    `Scope digest: ${report.scopeDigest}`,
    `Evidence groups: committed ${report.changeGroups.committed.paths.length}, staged ${report.changeGroups.staged.paths.length}, unstaged ${report.changeGroups.unstaged.paths.length}, untracked ${report.changeGroups.untracked.paths.length}`,
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

export function renderEffectiveInstructionsReport(
  report: EffectiveInstructionsReport
): string {
  const lines = [
    `Effective instructions for ${report.target.path}`,
    `Target directory: ${report.target.directory}`,
    `Loaded: ${report.budget.loadedBytes}/${report.budget.maximumBytes} bytes`,
    `Resolution digest: ${report.resolutionDigest}`
  ];
  if (report.layers.length === 0) {
    lines.push("Applicable instruction files: none");
  }
  for (const layer of report.layers) {
    lines.push(
      `${layer.order}. ${layer.selectedPath} [${layer.status}]`,
      `   Scope: ${layer.scope}`,
      `   Size: ${layer.loadedBytes}/${layer.sourceBytes} bytes`,
      `   Source digest: ${layer.sourceDigest ?? "not read (budget exhausted)"}`,
      `   Loaded digest: ${layer.loadedDigest}`,
      "   Why: first regular candidate in an ancestor directory of the target"
    );
    if (layer.canOverrideEarlier.length > 0) {
      lines.push(`   Can override earlier: ${layer.canOverrideEarlier.join(", ")}`);
    }
    for (const shadowed of layer.shadowed) {
      lines.push(`   Shadowed: ${shadowed.path} (higher-priority candidate selected)`);
    }
  }
  if (report.budget.truncated) {
    lines.push("Warning: the final applied instruction file was truncated by the byte budget.");
  }
  if (report.budget.exhausted) {
    lines.push("Warning: later instruction layers may be excluded because the byte budget is exhausted.");
  }
  return `${lines.join("\n")}\n`;
}
