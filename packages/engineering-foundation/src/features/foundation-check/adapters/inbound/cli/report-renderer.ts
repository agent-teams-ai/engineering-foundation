import type {
  FoundationCheckReport,
  FoundationDiagnostic
} from "../../../../validation-reporting/api.js";

function renderDiagnostic(diagnostic: FoundationDiagnostic): string {
  const location = diagnostic.location.start === undefined
    ? diagnostic.location.path
    : `${diagnostic.location.path}:${diagnostic.location.start.line}:${diagnostic.location.start.column}`;
  return [
    `${location} ${diagnostic.severity.toUpperCase()} ${diagnostic.ruleId}`,
    `  ${diagnostic.message}`,
    `  Fix: ${diagnostic.remediation}`
  ].join("\n");
}

export function renderFoundationReportText(report: FoundationCheckReport): string {
  const lines = [
    `Foundation check: ${report.outcome}`,
    `Foundation version: ${report.foundationVersion}`,
    `Coverage: ${report.coverage}`,
    `Diagnostics: ${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ${report.summary.infos} info`
  ];
  if (report.problem !== undefined) {
    lines.push(`Problem ${report.problem.code}: ${report.problem.message}`);
  }
  for (const capability of report.capabilities) {
    lines.push("", `${capability.capabilityId}: ${capability.outcome}`);
    if (capability.problem !== undefined) {
      lines.push(`Problem ${capability.problem.code}: ${capability.problem.message}`);
    }
    for (const diagnostic of capability.diagnostics) {
      lines.push(renderDiagnostic(diagnostic));
    }
  }
  return `${lines.join("\n")}\n`;
}
