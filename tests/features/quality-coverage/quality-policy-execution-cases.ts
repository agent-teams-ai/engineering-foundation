import assert from "node:assert/strict";
import test from "node:test";
import {
  checkQualityCoverage,
  checkStaticQualityCoverage,
} from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";
import { CapabilityInputError } from "../../../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import { path, invocation, good, reader, tool } from "./quality-policy-fixture.ts";

export function registerQualityExecutionCases(): void {
  void test(
    "static, selected scope, and full execution are distinct operations",
    staticSelectedScopeAndFullExecutionAreDistinct,
  );
  void test(
    "new unclassified private source and weakened protection fail before tool execution",
    newUnclassifiedPrivateSourceAndWeakenedProtectionFail,
  );
  void test(
    "production selection rejects omissions and unknown selected source with exact file evidence",
    productionSelectionRejectsOmissionsAndUnknownSelectedSource,
  );
  void test(
    "selected files absent from production compiler context cannot reach typed success",
    selectedFilesAbsentFromProductionCompilerContextCannot,
  );
  void test(
    "application maps unadmitted source findings to rejecting diagnostics",
    applicationMapsUnadmittedSourceFindingsToRejectingDiagnostics,
  );
  void test(
    "missing tools and malformed output are errors, never lint rejection evidence",
    missingToolsAndMalformedOutputAreErrorsNever,
  );
  void test(
    "typed execution cannot report success for a different file count",
    typedExecutionCannotReportSuccessForADifferent,
  );
  void test(
    "cancellation is preserved before work and after a late successful tool response",
    cancellationIsPreservedBeforeWorkAndAfterA,
  );
}

async function staticSelectedScopeAndFullExecutionAreDistinct(): Promise<void> {
  assert.equal((await checkStaticQualityCoverage(invocation, reader())).outcome, "passed");
  const scoped = tool();
  assert.equal(
    (await checkQualityCoverage({ ...invocation, scopeOnly: true }, reader(), scoped.provider))
      .outcome,
    "passed",
  );
  assert.deepEqual(scoped.calls, ["prepare", "select", "context"]);
  const full = tool();
  assert.equal((await checkQualityCoverage(invocation, reader(), full.provider)).outcome, "passed");
  assert.deepEqual(full.calls, ["prepare", "select", "context", "scan", "lint"]);
}

async function newUnclassifiedPrivateSourceAndWeakenedProtectionFail(): Promise<void> {
  const observation = structuredClone(good);
  observation.sources.push({
    path: "packages/nested/private/src/fixtures/main.test.ts",
    owners: [],
    suppressionCovered: false,
  });
  observation.settings[0].actual = "false";
  observation.routes[0].reached = false;
  const execution = tool();
  const result = await checkQualityCoverage(invocation, reader(observation), execution.provider);
  assert.equal(result.outcome, "violations");
  assert.deepEqual(
    result.diagnostics.map(({ ruleId }) => ruleId),
    [
      "quality.source-coverage.protected-setting",
      "quality.source-coverage.required-route",
      "quality.source-coverage.source-classification",
      "quality.source-coverage.suppression-coverage",
    ],
  );
  assert.deepEqual(execution.calls, []);
}

async function productionSelectionRejectsOmissionsAndUnknownSelectedSource(): Promise<void> {
  const extra = "packages/private/src/extra.ts";
  const execution = tool({ select: async () => [extra] });
  const result = await checkQualityCoverage(invocation, reader(), execution.provider);
  assert.equal(result.outcome, "violations");
  assert.deepEqual(
    result.diagnostics.map(({ location }) => location.path),
    [path, extra],
  );
  assert.ok(
    result.diagnostics.every(
      ({ ruleId }) => ruleId === "quality.source-coverage.selection-mismatch",
    ),
  );
  assert.ok(!execution.calls.includes("lint"));
}

async function selectedFilesAbsentFromProductionCompilerContextCannot(): Promise<void> {
  const execution = tool({ typeContext: async () => [] });
  const result = await checkQualityCoverage(invocation, reader(), execution.provider);
  assert.equal(result.outcome, "violations");
  assert.equal(result.diagnostics[0].ruleId, "quality.source-coverage.type-context");
  assert.equal(result.diagnostics[0].location.path, path);
  assert.ok(!execution.calls.includes("lint"));
}

async function applicationMapsUnadmittedSourceFindingsToRejectingDiagnostics(): Promise<void> {
  const execution = tool({
    explicitUnknown: async () => [{ path, start: 12, end: 24, sha256: "a".repeat(64) }],
  });
  const result = await checkQualityCoverage(invocation, reader(), execution.provider);
  assert.equal(result.outcome, "violations");
  assert.equal(result.diagnostics[0].ruleId, "quality.source-coverage.explicit-unknown");
  assert.equal(result.diagnostics[0].subject, `${path}:12-24`);
  assert.deepEqual(result.diagnostics[0].evidence[1], { kind: "actual", value: "a".repeat(64) });
  assert.ok(!execution.calls.includes("lint"));
}

async function missingToolsAndMalformedOutputAreErrorsNever(): Promise<void> {
  for (const error of [
    new Error("malformed output"),
    new CapabilityInputError({
      code: "QUALITY_TOOL_MISSING",
      message: "Missing pinned tool.",
      phase: "quality-tool",
      retryable: false,
    }),
  ]) {
    const execution = tool({
      select: async () => {
        throw error;
      },
    });
    const result = await checkQualityCoverage(invocation, reader(), execution.provider);
    assert.equal(
      result.outcome,
      error instanceof CapabilityInputError ? "invalid-input" : "failed",
    );
    assert.deepEqual(result.diagnostics, []);
    assert.ok(!execution.calls.includes("lint"));
  }
}

async function typedExecutionCannotReportSuccessForADifferent(): Promise<void> {
  const execution = tool({ lint: async () => ({ files: 2, diagnostics: [] }) });
  const result = await checkQualityCoverage(invocation, reader(), execution.provider);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.diagnostics, []);
}

async function cancellationIsPreservedBeforeWorkAndAfterA(): Promise<void> {
  const controller = new AbortController();
  const execution = tool({
    select: async () => {
      controller.abort();
      return [path];
    },
  });
  const result = await checkQualityCoverage(
    { ...invocation, signal: controller.signal },
    reader(),
    execution.provider,
  );
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(execution.calls, ["prepare"]);
  const aborted = await checkStaticQualityCoverage(
    { ...invocation, signal: controller.signal },
    { read: () => assert.fail("must not read after cancellation") },
  );
  assert.equal(aborted.outcome, "cancelled");
}
