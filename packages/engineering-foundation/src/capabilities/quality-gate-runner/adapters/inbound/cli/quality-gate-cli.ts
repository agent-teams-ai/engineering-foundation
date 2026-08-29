import type { QualityGateRunReport } from "../../../application/model/quality-gate-report.js";

export type QualityGateOperatorCancellation = "interrupt" | "terminate";

export interface QualityGateCancellationSource {
  subscribe(
    onCancellation: (cancellation: QualityGateOperatorCancellation) => void
  ): () => void;
}

export interface QualityGateCliProjection {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

function cancellationExitCode(
  cancellation: QualityGateOperatorCancellation
): 130 | 143 {
  return cancellation === "terminate" ? 143 : 130;
}

function exitCodeForQualityGateRun(
  report: QualityGateRunReport,
  cancellation: QualityGateOperatorCancellation | undefined
): number {
  if (cancellation !== undefined && report.outcome !== "failed") {
    return cancellationExitCode(cancellation);
  }
  if (report.outcome === "passed") {
    return 0;
  }
  for (const task of report.tasks) {
    if (task.outcome === "timed-out") {
      return 124;
    }
    if (task.outcome === "failed") {
      return task.exitCode === null || task.exitCode === 0 ? 1 : task.exitCode;
    }
  }
  return cancellation === undefined ? 130 : cancellationExitCode(cancellation);
}

function renderQualityGateRunReport(report: QualityGateRunReport): string {
  const lines = [
    `Quality gate profile: ${report.profileId}`,
    `Outcome: ${report.outcome}`,
    `Duration: ${report.durationMs}ms`
  ];
  for (const task of report.tasks) {
    const exit = task.exitCode === null ? "" : ` exit=${task.exitCode}`;
    const signal = task.signal === null ? "" : ` signal=${task.signal}`;
    lines.push(
      `- ${task.id}: ${task.outcome} (${task.durationMs}ms)${exit}${signal}`
    );
    if (task.failureTail.length > 0) {
      lines.push(task.failureTail);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function projectQualityGateSetupCancellation(
  format: "json" | "text",
  cancellation: QualityGateOperatorCancellation,
  canonicalFailureJson: string
): QualityGateCliProjection {
  return Object.freeze({
    exitCode: cancellationExitCode(cancellation),
    stderr: format === "text" ? "Quality gate execution was cancelled.\n" : "",
    stdout: format === "json"
      ? `${canonicalFailureJson}\n`
      : ""
  });
}

export function projectQualityGateRun(
  report: QualityGateRunReport,
  format: "json" | "text",
  cancellation: QualityGateOperatorCancellation | undefined
): QualityGateCliProjection {
  return Object.freeze({
    exitCode: exitCodeForQualityGateRun(report, cancellation),
    stderr: "",
    stdout: format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderQualityGateRunReport(report)
  });
}
