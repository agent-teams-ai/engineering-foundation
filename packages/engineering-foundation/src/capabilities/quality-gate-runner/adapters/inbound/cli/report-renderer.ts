import type { QualityGateRunReport } from "../../../application/model/quality-gate-report.js";

export function renderQualityGateRunReport(report: QualityGateRunReport): string {
  const lines = [
    `Quality gate profile: ${report.profileId}`,
    `Outcome: ${report.outcome}`,
    `Duration: ${report.durationMs}ms`
  ];
  for (const task of report.tasks) {
    const exit = task.exitCode === null ? "" : ` exit=${task.exitCode}`;
    const signal = task.signal === null ? "" : ` signal=${task.signal}`;
    lines.push(`- ${task.id}: ${task.outcome} (${task.durationMs}ms)${exit}${signal}`);
    if (task.failureTail.length > 0) {
      lines.push(task.failureTail);
    }
  }
  return `${lines.join("\n")}\n`;
}
