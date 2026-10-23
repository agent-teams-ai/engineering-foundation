import assert from "node:assert/strict";
export interface PackedSdkCheck {
  aggregate: { capabilities: readonly [{ diagnostics: readonly { ruleId: string }[] }] };
  report: {
    verdict: string;
    authority: { status: string };
    phases: readonly { name: string; status: string }[];
    releasedComparison: { status: string };
  };
  bytes: Buffer;
}
export function assertMatchedSdkReport(matched: PackedSdkCheck): void {
  assert.equal(matched.report.verdict, "incomplete");
  assert.equal(matched.report.authority.status, "unverified");
  assert.equal(matched.report.phases.find((row) => row.name === "released")?.status, "unavailable");
  assert.equal(matched.report.releasedComparison.status, "incomplete");
  assert.ok(
    !matched.aggregate.capabilities[0].diagnostics.some((row) => row.ruleId.includes("breaking")),
  );
  assert.ok(
    matched.aggregate.capabilities[0].diagnostics.some((row) =>
      row.ruleId.endsWith("growth-owner-evidence-unavailable"),
    ),
  );
  assert.ok(
    !matched.aggregate.capabilities[0].diagnostics.some((row) =>
      [
        "growth-transition-unadmitted",
        "growth-decision-malformed",
        "growth-decision-fingerprint-mismatch",
      ].some((code) => row.ruleId.endsWith(code)),
    ),
  );
}
