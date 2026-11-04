import assert from "node:assert/strict";
import test from "node:test";
import {
  checkQualityCoverage,
  checkStaticQualityCoverage,
} from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";
import { invocation, good, reader, tool } from "./quality-policy-fixture.ts";

export function registerQualityProtectionCases(): void {
  void test("required observations cannot be empty", requiredObservationsCannotBeEmpty);
  void test(
    "nonempty routes cannot omit either required execution mode",
    nonemptyRoutesCannotOmitEitherRequiredExecutionMode,
  );
  void test(
    "accepted route entry and mode require exactly one observation",
    acceptedRouteEntryAndModeRequireExactlyOne,
  );
  void test(
    "preset requirements remain mandatory when one observation disappears",
    presetRequirementsRemainMandatoryWhenOneObservationDisappears,
  );
  void test(
    "ceilings require finite nonnegative numbers without coercion",
    ceilingsRequireFiniteNonnegativeNumbersWithoutCoercion,
  );
  void test(
    "duplicate assignment observations cannot serve as valid protection evidence",
    duplicateAssignmentObservationsCannotServeAsValidProtection,
  );
}

async function requiredObservationsCannotBeEmpty(): Promise<void> {
  for (const [field, rule] of [
    ["settings", "protected-setting"],
    ["routes", "required-route"],
  ]) {
    const result = await checkStaticQualityCoverage(invocation, reader({ ...good, [field]: [] }));
    assert.equal(result.outcome, "violations");
    assert.equal(result.diagnostics[0].ruleId, `quality.source-coverage.${rule}`);
  }
}

async function nonemptyRoutesCannotOmitEitherRequiredExecutionMode(): Promise<void> {
  for (const mode of ["scope", "full"]) {
    const routes = good.routes.filter((route) => route.mode !== mode);
    const execution = tool();
    const result = await checkQualityCoverage(
      invocation,
      reader({ ...good, routes }),
      execution.provider,
    );
    assert.equal(result.outcome, "violations");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].ruleId, "quality.source-coverage.required-route");
    assert.equal(result.diagnostics[0].location.path, "package.json");
    assert.deepEqual(result.diagnostics[0].evidence[0], { kind: "expected", value: mode });
    assert.deepEqual(execution.calls, []);
  }
}

async function acceptedRouteEntryAndModeRequireExactlyOne(): Promise<void> {
  const custom = {
    ...good,
    requiredRoutes: [
      { entry: "custom:full", mode: "full" as const },
      { entry: "custom:fast", mode: "scope" as const },
    ],
    routes: [
      { entry: "custom:full", mode: "full" as const, reached: true },
      { entry: "custom:fast", mode: "scope" as const, reached: true },
    ],
  };
  assert.equal((await checkStaticQualityCoverage(invocation, reader(custom))).outcome, "passed");
  for (const routes of [
    [...custom.routes, custom.routes[0]],
    [{ ...custom.routes[0], entry: "not-required-script" }, custom.routes[1]],
    [{ ...custom.routes[0], mode: "scope" as const }, custom.routes[1]],
    [...custom.routes, { entry: "extra", mode: "full" as const, reached: true }],
  ]) {
    const execution = tool();
    const result = await checkQualityCoverage(
      invocation,
      reader({ ...custom, routes }),
      execution.provider,
    );
    assert.equal(result.outcome, "violations");
    assert.ok(
      result.diagnostics.every(
        ({ ruleId, location }) =>
          ruleId === "quality.source-coverage.required-route" && location.path === "package.json",
      ),
    );
    assert.deepEqual(execution.calls, []);
  }
}

async function presetRequirementsRemainMandatoryWhenOneObservationDisappears(): Promise<void> {
  const name = "typescript/no-floating-promises";
  const complete = {
    ...good,
    requiredSettings: [...good.requiredSettings, name],
    requiredSettingObservations: [
      ...good.requiredSettingObservations,
      {
        observationId: "lint.json#1",
        path: "lint.json",
        name,
        expected: "error",
        comparison: "equal" as const,
      },
    ],
    settings: [
      ...good.settings,
      {
        observationId: "lint.json#1",
        path: "lint.json",
        name,
        expected: "error",
        actual: "error",
        comparison: "equal" as const,
      },
    ],
  };
  assert.equal((await checkStaticQualityCoverage(invocation, reader(complete))).outcome, "passed");
  const execution = tool();
  const result = await checkQualityCoverage(
    invocation,
    reader({ ...complete, settings: good.settings }),
    execution.provider,
  );
  assert.equal(result.outcome, "violations");
  assert.ok(
    result.diagnostics.every(
      ({ ruleId, subject }) =>
        ruleId === "quality.source-coverage.protected-setting" && subject === name,
    ),
  );
  assert.deepEqual(execution.calls, []);
  assert.equal(
    (await checkStaticQualityCoverage(invocation, reader({ ...complete, requiredSettings: [] })))
      .outcome,
    "violations",
  );
}

async function ceilingsRequireFiniteNonnegativeNumbersWithoutCoercion(): Promise<void> {
  for (const actual of [0, 99, 100, "", "99", null, undefined, false, [], NaN, Infinity, -1, 101]) {
    const settings = [
      ...good.settings,
      {
        observationId: "lint.json#1",
        path: "lint.json",
        name: "max-lines:ceiling",
        expected: 100,
        actual: 0,
        comparison: "ceiling" as const,
      },
    ];
    // Deliberately malformed runtime observation exercises the fail-closed boundary.
    Object.defineProperty(settings[1], "actual", { value: actual });
    const result = await checkStaticQualityCoverage(
      invocation,
      reader({
        ...good,
        settings,
        requiredSettingObservations: [
          ...good.requiredSettingObservations,
          {
            observationId: "lint.json#1",
            path: "lint.json",
            name: "max-lines:ceiling",
            expected: 100,
            comparison: "ceiling" as const,
          },
        ],
      }),
    );
    const valid =
      typeof actual === "number" && Number.isFinite(actual) && actual >= 0 && actual <= 100;
    assert.equal(result.outcome, valid ? "passed" : "violations", String(actual));
    if (!valid) {
      assert.equal(result.diagnostics[0].ruleId, "quality.source-coverage.protected-setting");
      assert.equal(result.diagnostics[0].location.path, "lint.json");
    }
  }
}

async function duplicateAssignmentObservationsCannotServeAsValidProtection(): Promise<void> {
  const execution = tool();
  const result = await checkQualityCoverage(
    invocation,
    reader({
      ...good,
      settings: [...good.settings, { ...good.settings[0] }],
    }),
    execution.provider,
  );
  assert.equal(result.outcome, "violations");
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].ruleId, "quality.source-coverage.protected-setting");
  assert.equal(result.diagnostics[0].location.path, "lint.json");
  assert.deepEqual(execution.calls, []);
}
