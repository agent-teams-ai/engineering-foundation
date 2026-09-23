import assert from "node:assert/strict";
import test from "node:test";
import { checkQualityCoverage, checkStaticQualityCoverage } from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";
import { CapabilityInputError } from "../../../packages/engineering-foundation/dist/features/validation-reporting/api.js";

const path = "packages/contexts/private-worker/src/main.ts";
const invocation = { consumerRoot: "/disposable consumer", configPath: "quality.yaml", scopeOnly: false };
const good = {
  testPaths: [],
  sources: [{ path, owners: ["private-worker.application"], suppressionCovered: true }],
  requiredSettings: ["typeAware"],
  requiredSettingObservations: [{ observationId: "lint.json#0", path: "lint.json", name: "typeAware", expected: "true", comparison: "equal" }],
  settings: [{ observationId: "lint.json#0", path: "lint.json", name: "typeAware", expected: "true", actual: "true", comparison: "equal" }],
  requiredRoutes: [{ entry: "check", mode: "full" }, { entry: "check:fast", mode: "scope" }],
  routes: [{ entry: "check", mode: "full", reached: true }, { entry: "check:fast", mode: "scope", reached: true }]
};
const reader = (observation = good) => ({ read: async () => observation });
function tool(overrides = {}) {
  const calls = [];
  const provider = { prepare: async () => {
    calls.push("prepare");
    return {
      select: async () => { calls.push("select"); return [path]; },
      typeContext: async () => { calls.push("context"); return [path]; },
      explicitUnknown: async () => { calls.push("scan"); return []; },
      lint: async () => { calls.push("lint"); return { files: 1, diagnostics: [] }; },
      ...overrides
    };
  } };
  return { calls, provider };
}

test("static, selected scope, and full execution are distinct operations", async () => {
  assert.equal((await checkStaticQualityCoverage(invocation, reader())).outcome, "passed");
  const scoped = tool();
  assert.equal((await checkQualityCoverage({ ...invocation, scopeOnly: true }, reader(), scoped.provider)).outcome, "passed");
  assert.deepEqual(scoped.calls, ["prepare", "select", "context"]);
  const full = tool();
  assert.equal((await checkQualityCoverage(invocation, reader(), full.provider)).outcome, "passed");
  assert.deepEqual(full.calls, ["prepare", "select", "context", "scan", "lint"]);
});

test("new unclassified private source and weakened protection fail before tool execution", async () => {
  const observation = structuredClone(good);
  observation.sources.push({ path: "packages/nested/private/src/fixtures/main.test.ts", owners: [], suppressionCovered: false });
  observation.settings[0].actual = "false";
  observation.routes[0].reached = false;
  const execution = tool();
  const result = await checkQualityCoverage(invocation, reader(observation), execution.provider);
  assert.equal(result.outcome, "violations");
  assert.deepEqual(result.diagnostics.map(({ ruleId }) => ruleId), [
    "quality.source-coverage.protected-setting", "quality.source-coverage.required-route",
    "quality.source-coverage.source-classification", "quality.source-coverage.suppression-coverage"
  ]);
  assert.deepEqual(execution.calls, []);
});

test("production selection rejects omissions and unknown selected source with exact file evidence", async () => {
  const extra = "packages/private/src/extra.ts";
  const execution = tool({ select: async () => [extra] });
  const result = await checkQualityCoverage(invocation, reader(), execution.provider);
  assert.equal(result.outcome, "violations");
  assert.deepEqual(result.diagnostics.map(({ location }) => location.path), [path, extra]);
  assert.ok(result.diagnostics.every(({ ruleId }) => ruleId === "quality.source-coverage.selection-mismatch"));
  assert.ok(!execution.calls.includes("lint"));
});

test("selected files absent from production compiler context cannot reach typed success", async () => {
  const execution = tool({ typeContext: async () => [] });
  const result = await checkQualityCoverage(invocation, reader(), execution.provider);
  assert.equal(result.outcome, "violations");
  assert.equal(result.diagnostics[0].ruleId, "quality.source-coverage.type-context");
  assert.equal(result.diagnostics[0].location.path, path);
  assert.ok(!execution.calls.includes("lint"));
});

test("missing tools and malformed output are errors, never lint rejection evidence", async () => {
  for (const error of [new Error("malformed output"), new CapabilityInputError({ code: "QUALITY_TOOL_MISSING", message: "Missing pinned tool.", phase: "quality-tool", retryable: false })]) {
    const execution = tool({ select: async () => { throw error; } });
    const result = await checkQualityCoverage(invocation, reader(), execution.provider);
    assert.equal(result.outcome, error instanceof CapabilityInputError ? "invalid-input" : "failed");
    assert.deepEqual(result.diagnostics, []);
    assert.ok(!execution.calls.includes("lint"));
  }
});

test("typed execution cannot report success for a different file count", async () => {
  const execution = tool({ lint: async () => ({ files: 2, diagnostics: [] }) });
  const result = await checkQualityCoverage(invocation, reader(), execution.provider);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.diagnostics, []);
});

test("cancellation is preserved before work and after a late successful tool response", async () => {
  const controller = new AbortController();
  const execution = tool({ select: async () => { controller.abort(); return [path]; } });
  const result = await checkQualityCoverage({ ...invocation, signal: controller.signal }, reader(), execution.provider);
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(execution.calls, ["prepare"]);
  const aborted = await checkStaticQualityCoverage({ ...invocation, signal: controller.signal }, { read: () => assert.fail("must not read after cancellation") });
  assert.equal(aborted.outcome, "cancelled");
});


test("required observations cannot be empty", async () => {
  for (const [field, rule] of [["settings", "protected-setting"], ["routes", "required-route"]]) {
    const result = await checkStaticQualityCoverage(invocation, reader({ ...good, [field]: [] }));
    assert.equal(result.outcome, "violations");
    assert.equal(result.diagnostics[0].ruleId, `quality.source-coverage.${rule}`);
  }
});

test("nonempty routes cannot omit either required execution mode", async () => {
  for (const mode of ["scope", "full"]) {
    const routes = good.routes.filter((route) => route.mode !== mode);
    const execution = tool();
    const result = await checkQualityCoverage(invocation, reader({ ...good, routes }), execution.provider);
    assert.equal(result.outcome, "violations");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].ruleId, "quality.source-coverage.required-route");
    assert.equal(result.diagnostics[0].location.path, "package.json");
    assert.deepEqual(result.diagnostics[0].evidence[0], { kind: "expected", value: mode });
    assert.deepEqual(execution.calls, []);
  }
});

test("accepted route entry and mode require exactly one observation", async () => {
  const custom = {
    ...good,
    requiredRoutes: [{ entry: "custom:full", mode: "full" }, { entry: "custom:fast", mode: "scope" }],
    routes: [{ entry: "custom:full", mode: "full", reached: true }, { entry: "custom:fast", mode: "scope", reached: true }]
  };
  assert.equal((await checkStaticQualityCoverage(invocation, reader(custom))).outcome, "passed");
  for (const routes of [
    [...custom.routes, custom.routes[0]],
    [{ ...custom.routes[0], entry: "not-required-script" }, custom.routes[1]],
    [{ ...custom.routes[0], mode: "scope" }, custom.routes[1]],
    [...custom.routes, { entry: "extra", mode: "full", reached: true }]
  ]) {
    const execution = tool();
    const result = await checkQualityCoverage(invocation, reader({ ...custom, routes }), execution.provider);
    assert.equal(result.outcome, "violations");
    assert.ok(result.diagnostics.every(({ ruleId, location }) =>
      ruleId === "quality.source-coverage.required-route" && location.path === "package.json"));
    assert.deepEqual(execution.calls, []);
  }
});

test("preset requirements remain mandatory when one observation disappears", async () => {
  const name = "typescript/no-floating-promises";
  const complete = {
    ...good,
    requiredSettings: [...good.requiredSettings, name],
    requiredSettingObservations: [...good.requiredSettingObservations, { observationId: "lint.json#1", path: "lint.json", name, expected: "error", comparison: "equal" }],
    settings: [...good.settings, { observationId: "lint.json#1", path: "lint.json", name, expected: "error", actual: "error", comparison: "equal" }]
  };
  assert.equal((await checkStaticQualityCoverage(invocation, reader(complete))).outcome, "passed");
  const execution = tool();
  const result = await checkQualityCoverage(invocation, reader({ ...complete, settings: good.settings }), execution.provider);
  assert.equal(result.outcome, "violations");
  assert.ok(result.diagnostics.every(({ ruleId, subject }) => ruleId === "quality.source-coverage.protected-setting" && subject === name));
  assert.deepEqual(execution.calls, []);
  assert.equal((await checkStaticQualityCoverage(invocation, reader({ ...complete, requiredSettings: [] }))).outcome, "violations");
});

test("ceilings require finite nonnegative numbers without coercion", async () => {
  for (const actual of [0, 99, 100, "", "99", null, undefined, false, [], NaN, Infinity, -1, 101]) {
    const settings = [...good.settings, { observationId: "lint.json#1", path: "lint.json", name: "max-lines:ceiling", expected: 100, actual, comparison: "ceiling" }];
    const result = await checkStaticQualityCoverage(invocation, reader({ ...good, settings, requiredSettingObservations: [...good.requiredSettingObservations, { observationId: "lint.json#1", path: "lint.json", name: "max-lines:ceiling", expected: 100, comparison: "ceiling" }] }));
    const valid = typeof actual === "number" && Number.isFinite(actual) && actual >= 0 && actual <= 100;
    assert.equal(result.outcome, valid ? "passed" : "violations", String(actual));
    if (!valid) {
      assert.equal(result.diagnostics[0].ruleId, "quality.source-coverage.protected-setting");
      assert.equal(result.diagnostics[0].location.path, "lint.json");
    }
  }
});

test("duplicate assignment observations cannot serve as valid protection evidence", async () => {
  const execution = tool();
  const result = await checkQualityCoverage(invocation, reader({
    ...good, settings: [...good.settings, { ...good.settings[0] }]
  }), execution.provider);
  assert.equal(result.outcome, "violations");
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].ruleId, "quality.source-coverage.protected-setting");
  assert.equal(result.diagnostics[0].location.path, "lint.json");
  assert.deepEqual(execution.calls, []);
});


test("owned declarations require actual selection and compiler context", async () => {
  const declarations = [
    "packages/contexts/private-worker/src/public.d.ts",
    "packages/contexts/private-worker/src/public.d.mts"
  ];
  const production = [path, ...declarations];
  const observation = { ...good, sources: [...good.sources, ...declarations.map((declaration) => ({
    path: declaration, owners: ["private-worker.application"], suppressionCovered: true
  }))] };
  const complete = tool({ select: async () => production, typeContext: async () => production,
    lint: async () => ({ files: production.length, diagnostics: [] }) });
  assert.equal((await checkQualityCoverage(invocation, reader(observation), complete.provider)).outcome, "passed");
  for (const declaration of declarations) {
    for (const [overrides, rule] of [
      [{ select: async () => production.filter((candidate) => candidate !== declaration), typeContext: async () => production }, "selection-mismatch"],
      [{ select: async () => production, typeContext: async () => production.filter((candidate) => candidate !== declaration) }, "type-context"]
    ]) {
      const result = await checkQualityCoverage(invocation, reader(observation), tool(overrides).provider);
      assert.equal(result.outcome, "violations");
      assert.ok(result.diagnostics.some(({ ruleId, location }) => ruleId === `quality.source-coverage.${rule}` && location.path === declaration));
    }
  }
});


test("JavaScript build adapters remain selected without a false TypeScript context claim", async () => {
  const javascript = "packages/contexts/private-worker/src/build.mjs";
  const observation = { ...good, sources: [...good.sources, { path: javascript, owners: ["private-worker.application"], suppressionCovered: true }] };
  const execution = tool({ select: async () => [path, javascript], typeContext: async () => [path], lint: async () => ({ files: 2, diagnostics: [] }) });
  assert.equal((await checkQualityCoverage(invocation, reader(observation), execution.provider)).outcome, "passed");
  const omitted = await checkQualityCoverage(invocation, reader(observation), tool().provider);
  assert.equal(omitted.outcome, "violations");
  assert.ok(omitted.diagnostics.some(({ ruleId, location }) => ruleId === "quality.source-coverage.selection-mismatch" && location.path === javascript));
  const javascriptOnly = await checkStaticQualityCoverage(invocation, reader({ ...observation, sources: [observation.sources[1]] }));
  assert.equal(javascriptOnly.outcome, "violations");
  assert.ok(javascriptOnly.diagnostics.some(({ ruleId }) => ruleId === "quality.source-coverage.source-empty"));
  const unowned = { ...observation, sources: [good.sources[0], { ...observation.sources[1], owners: [] }] };
  const rejected = await checkStaticQualityCoverage(invocation, reader(unowned));
  assert.ok(rejected.diagnostics.some(({ ruleId, location }) => ruleId === "quality.source-coverage.source-classification" && location.path === javascript));
});


test("each accepted config assignment must retain its identity and requirement", async () => {
  const inherited = { ...good.requiredSettingObservations[0], observationId: "base.json#options#typeAware", path: "base.json" };
  const complete = {
    ...good,
    requiredSettingObservations: [...good.requiredSettingObservations, inherited],
    settings: [...good.settings, { ...inherited, actual: "true" }]
  };
  assert.equal((await checkStaticQualityCoverage(invocation, reader(complete))).outcome, "passed");
  for (const settings of [
    good.settings,
    [...complete.settings, { ...complete.settings[1] }],
    [...complete.settings, { ...inherited, observationId: "unknown#0", name: "unknown-protected-rule", actual: "true" }],
    [good.settings[0], { ...complete.settings[1], path: "other.json" }],
    [good.settings[0], { ...complete.settings[1], name: "unknown-protected-rule" }],
    [good.settings[0], { ...complete.settings[1], expected: "false", actual: "false" }],
    [good.settings[0], { ...complete.settings[1], comparison: "ceiling", expected: 1, actual: 0 }]
  ]) {
    const execution = tool();
    const result = await checkQualityCoverage(invocation, reader({ ...complete, settings }), execution.provider);
    assert.equal(result.outcome, "violations");
    assert.ok(result.diagnostics.every(({ ruleId }) => ruleId === "quality.source-coverage.protected-setting"));
    assert.deepEqual(execution.calls, []);
  }
});


test("classified selected tests preserve production coverage and full selection evidence", async () => {
  const testPath = "packages/contexts/private-worker/tests/example.test.ts";
  const observation = { ...good, testPaths: [testPath] };
  const selected = [path, testPath];
  const complete = tool({ select: async () => selected, lint: async () => ({ files: 2, diagnostics: [] }) });
  assert.equal((await checkQualityCoverage(invocation, reader(observation), complete.provider)).outcome, "passed");
  assert.deepEqual(complete.calls, ["prepare", "context", "scan"]);
  const scope = tool({ select: async () => selected });
  assert.equal((await checkQualityCoverage({ ...invocation, scopeOnly: true }, reader(observation), scope.provider)).outcome, "passed");
  const omitted = await checkQualityCoverage(invocation, reader(observation), tool({ select: async () => [testPath] }).provider);
  assert.equal(omitted.outcome, "violations");
  assert.ok(omitted.diagnostics.some(({ location, ruleId }) => location.path === path && ruleId === "quality.source-coverage.selection-mismatch"));
  const unknown = "packages/contexts/private-worker/tests/not-in-census.test.ts";
  const unknownResult = await checkQualityCoverage(invocation, reader(observation), tool({ select: async () => [...selected, unknown] }).provider);
  assert.equal(unknownResult.outcome, "violations");
  assert.ok(unknownResult.diagnostics.some(({ location, ruleId }) => location.path === unknown && ruleId === "quality.source-coverage.selection-mismatch"));
  const wrongCount = await checkQualityCoverage(invocation, reader(observation), tool({ select: async () => selected }).provider);
  assert.equal(wrongCount.outcome, "failed");
  assert.deepEqual(wrongCount.diagnostics, []);
});


test("native production remains classified and requires consumer gate wiring outside Oxlint selection", async () => {
  const nativePath = "packages/platform/custody/native/rename.c";
  const native = { path: nativePath, owners: ["custody.native"], suppressionCovered: true,
    nativeGates: [{ script: "native:check", reached: true }] };
  const observation = { ...good, sources: [...good.sources, native] };
  const execution = tool();
  assert.equal((await checkQualityCoverage(invocation, reader(observation), execution.provider)).outcome, "passed");
  assert.deepEqual(execution.calls, ["prepare", "select", "context", "scan", "lint"]);
  for (const nativeGates of [[], [{ script: "native:check", reached: false }], [native.nativeGates[0], native.nativeGates[0]]]) {
    const rejected = await checkStaticQualityCoverage(invocation, reader({ ...observation,
      sources: [...good.sources, { ...native, nativeGates }] }));
    assert.equal(rejected.outcome, "violations");
    assert.ok(rejected.diagnostics.some(({ ruleId, location }) =>
      ruleId === "quality.source-coverage.native-route" && location.path === nativePath));
  }
  const unowned = await checkStaticQualityCoverage(invocation, reader({ ...observation,
    sources: [...good.sources, { ...native, owners: [] }] }));
  assert.ok(unowned.diagnostics.some(({ ruleId }) => ruleId === "quality.source-coverage.source-classification"));
});


test("required script routes reject direct and nested literal failure", async () => {
  const { containsScriptRoute, executesScript } = await import("../../../packages/engineering-foundation/dist/features/quality-coverage/application/script-route.js");
  const expected = "agent-teams-foundation quality check --consumer .";
  const valid = { check: "pnpm build && pnpm lint:typed", build: "tsc --build", "lint:typed": expected };
  assert.equal(executesScript(valid, "check", "lint:typed", expected), true);
  for (const scripts of [
    { ...valid, check: "false && pnpm lint:typed" },
    { ...valid, build: "false" },
    { ...valid, build: "pnpm prepare", prepare: "false" },
    { ...valid, "lint:typed": "false && " + expected }
  ]) {
    assert.equal(containsScriptRoute(scripts, "check", "lint:typed", expected), true);
    assert.equal(executesScript(scripts, "check", "lint:typed", expected), false);
  }
});
