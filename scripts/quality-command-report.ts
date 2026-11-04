import assert from "node:assert/strict";

export interface QualityFixtureReport {
  readonly outcome: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly capabilities: readonly {
    readonly capabilityConfigSchemaVersion: number;
    readonly problem?: { readonly code: string; readonly message: string };
    readonly diagnostics: readonly {
      readonly ruleId: string;
      readonly subject: string;
      readonly location: { readonly path: string };
      readonly evidence: readonly { readonly kind: string; readonly value: string }[];
    }[];
  }[];
}

export function qualityFixtureRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function string(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function problem(value: unknown): { readonly code: string; readonly message: string } {
  const input = qualityFixtureRecord(value);
  return { code: string(input["code"]), message: string(input["message"]) };
}

/** The fields consumed by source and installed quality CLI fixtures have one reader. */
export function qualityFixtureReport(
  source: string,
  capabilityId = "quality.source-coverage",
): QualityFixtureReport {
  const parsed: unknown = JSON.parse(source);
  const report = qualityFixtureRecord(parsed);
  const outcome = string(report["outcome"]);
  assert.ok(["passed", "violations", "invalid-input", "failed", "cancelled"].includes(outcome));
  const capabilities: unknown = report["capabilities"];
  // Root configuration admission can fail before a capability observation exists.
  if (capabilities === undefined) {
    assert.equal(report["schemaVersion"], 1);
    assert.equal(outcome, "invalid-input");
    return { outcome, capabilities: [], error: problem(report["error"]) };
  }
  assert.equal(report["reportSchemaVersion"], 1);
  assert.ok(Array.isArray(capabilities) && capabilities.length <= 1);
  if (capabilities.length === 0) {
    assert.notEqual(outcome, "passed", "quality success requires an actual capability report");
    return { outcome, capabilities: [], error: problem(report["problem"]) };
  }
  const capability = qualityFixtureRecord(capabilities[0]);
  assert.equal(capability["capabilityId"], capabilityId);
  const version = capability["capabilityConfigSchemaVersion"];
  assert.ok(typeof version === "number" && Number.isSafeInteger(version) && version > 0);
  assert.equal(capability["outcome"], outcome);
  const entries: unknown = capability["diagnostics"];
  assert.ok(Array.isArray(entries));
  const diagnostics = entries.map((entry: unknown) => {
    const diagnostic = qualityFixtureRecord(entry);
    const evidence: unknown = diagnostic["evidence"];
    assert.ok(Array.isArray(evidence));
    return {
      ruleId: string(diagnostic["ruleId"]),
      subject: string(diagnostic["subject"]),
      location: { path: string(qualityFixtureRecord(diagnostic["location"])["path"]) },
      evidence: evidence.map((item: unknown) => {
        const record = qualityFixtureRecord(item);
        return { kind: string(record["kind"]), value: string(record["value"]) };
      }),
    };
  });
  return {
    outcome,
    capabilities: [
      {
        capabilityConfigSchemaVersion: version,
        diagnostics,
        ...(capability["problem"] === undefined ? {} : { problem: problem(capability["problem"]) }),
      },
    ],
  };
}
