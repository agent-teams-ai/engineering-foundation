import { appendFile, readFile } from "node:fs/promises";

const capabilityId = "package.public-api-compatibility";
const outcomes = new Set(["passed", "violations", "invalid-input", "failed", "cancelled"]);
const reportPath = process.argv[2];
if (reportPath === undefined) {
  throw new Error("Usage: node scripts/sdk-api-ci-summary.mjs <foundation-check.json>");
}

let capability;
try {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (report.reportSchemaVersion === 1 && Array.isArray(report.capabilities)) {
    const candidate = report.capabilities.find((entry) => entry?.capabilityId === capabilityId);
    if (candidate && outcomes.has(candidate.outcome) &&
      Number.isInteger(candidate.summary?.errors) &&
      Number.isInteger(candidate.summary?.warnings) &&
      Number.isInteger(candidate.summary?.infos)) {
      capability = candidate;
    }
  }
} catch {
  // The check can fail before producing a report. Its original exit status remains authoritative.
}

const lines = [
  "## SDK public API check",
  "",
  "The active v1 compatibility gate checks breaking changes and package exports. Additions require review of the PR diff; this summary is not growth approval.",
  "",
];

if (capability === undefined) {
  lines.push("Report unavailable. See the Foundation check log for the original failure.");
} else {
  const summary = capability.summary;
  lines.push(
    `Result: **${capability.outcome}**. Diagnostics: ${summary.errors} errors, ${summary.warnings} warnings, ${summary.infos} info.`,
  );
  const details = JSON.stringify(capability, null, 2)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  if (details.length <= 40_000) {
    lines.push("", "<details><summary>Full SDK capability report</summary>", "", `<pre>${details}</pre>`, "", "</details>");
  } else {
    lines.push("", "Full report exceeds the summary size limit. See the Foundation check log.");
  }
}

const output = `${lines.join("\n")}\n`;
if (process.env.GITHUB_STEP_SUMMARY === undefined) {
  process.stdout.write(output);
} else {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, output, "utf8");
}
