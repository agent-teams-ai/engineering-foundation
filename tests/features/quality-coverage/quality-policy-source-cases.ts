import assert from "node:assert/strict";
import test from "node:test";
import {
  checkQualityCoverage,
  checkStaticQualityCoverage,
} from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";
import { path, invocation, good, reader, tool } from "./quality-policy-fixture.ts";

export function registerQualitySourceCases(): void {
  void test(
    "owned declarations require actual selection and compiler context",
    ownedDeclarationsRequireActualSelectionAndCompilerContext,
  );
  void test(
    "JavaScript build adapters remain selected without a false TypeScript context claim",
    javascriptBuildAdaptersRemainSelectedWithoutAFalse,
  );
  void test(
    "each accepted config assignment must retain its identity and requirement",
    eachAcceptedConfigAssignmentMustRetainItsIdentity,
  );
  void test(
    "classified selected tests preserve production coverage and full selection evidence",
    classifiedSelectedTestsPreserveProductionCoverageAndFull,
  );
  void test(
    "native production remains classified and requires consumer gate wiring outside Oxlint selection",
    nativeProductionRemainsClassifiedAndRequiresConsumerGate,
  );
  void test(
    "required script routes reject direct and nested literal failure",
    requiredScriptRoutesRejectDirectAndNestedLiteral,
  );
  void test(
    "static Host quality routes preserve failure, missing-script and cycle rejection",
    staticHostQualityRoutesPreserveFailureMissingScript,
  );
}

async function ownedDeclarationsRequireActualSelectionAndCompilerContext(): Promise<void> {
  const declarations = [
    "packages/contexts/private-worker/src/public.d.ts",
    "packages/contexts/private-worker/src/public.d.mts",
  ];
  const production = [path, ...declarations];
  const observation = {
    ...good,
    sources: [
      ...good.sources,
      ...declarations.map((declaration) => ({
        path: declaration,
        owners: ["private-worker.application"],
        suppressionCovered: true,
      })),
    ],
  };
  const complete = tool({
    select: async () => production,
    typeContext: async () => production,
    lint: async () => ({ files: production.length, diagnostics: [] }),
  });
  assert.equal(
    (await checkQualityCoverage(invocation, reader(observation), complete.provider)).outcome,
    "passed",
  );
  for (const declaration of declarations) {
    for (const [overrides, rule] of [
      [
        {
          select: async () => production.filter((candidate) => candidate !== declaration),
          typeContext: async () => production,
        },
        "selection-mismatch",
      ],
      [
        {
          select: async () => production,
          typeContext: async () => production.filter((candidate) => candidate !== declaration),
        },
        "type-context",
      ],
    ] as const) {
      const result = await checkQualityCoverage(
        invocation,
        reader(observation),
        tool(overrides).provider,
      );
      assert.equal(result.outcome, "violations");
      assert.ok(
        result.diagnostics.some(
          ({ ruleId, location }) =>
            ruleId === `quality.source-coverage.${rule}` && location.path === declaration,
        ),
      );
    }
  }
}

async function javascriptBuildAdaptersRemainSelectedWithoutAFalse(): Promise<void> {
  const javascript = "packages/contexts/private-worker/src/build.mjs";
  const observation = {
    ...good,
    sources: [
      ...good.sources,
      { path: javascript, owners: ["private-worker.application"], suppressionCovered: true },
    ],
  };
  const execution = tool({
    select: async () => [path, javascript],
    typeContext: async () => [path],
    lint: async () => ({ files: 2, diagnostics: [] }),
  });
  assert.equal(
    (await checkQualityCoverage(invocation, reader(observation), execution.provider)).outcome,
    "passed",
  );
  const omitted = await checkQualityCoverage(invocation, reader(observation), tool().provider);
  assert.equal(omitted.outcome, "violations");
  assert.ok(
    omitted.diagnostics.some(
      ({ ruleId, location }) =>
        ruleId === "quality.source-coverage.selection-mismatch" && location.path === javascript,
    ),
  );
  const javascriptOnly = await checkStaticQualityCoverage(
    invocation,
    reader({ ...observation, sources: [observation.sources[1]] }),
  );
  assert.equal(javascriptOnly.outcome, "violations");
  assert.ok(
    javascriptOnly.diagnostics.some(
      ({ ruleId }) => ruleId === "quality.source-coverage.source-empty",
    ),
  );
  const unowned = {
    ...observation,
    sources: [good.sources[0], { ...observation.sources[1], owners: [] }],
  };
  const rejected = await checkStaticQualityCoverage(invocation, reader(unowned));
  assert.ok(
    rejected.diagnostics.some(
      ({ ruleId, location }) =>
        ruleId === "quality.source-coverage.source-classification" && location.path === javascript,
    ),
  );
}

async function eachAcceptedConfigAssignmentMustRetainItsIdentity(): Promise<void> {
  const inherited = {
    ...good.requiredSettingObservations[0],
    observationId: "base.json#options#typeAware",
    path: "base.json",
  };
  const complete = {
    ...good,
    requiredSettingObservations: [...good.requiredSettingObservations, inherited],
    settings: [...good.settings, { ...inherited, actual: "true" }],
  };
  assert.equal((await checkStaticQualityCoverage(invocation, reader(complete))).outcome, "passed");
  for (const settings of [
    good.settings,
    [...complete.settings, { ...complete.settings[1] }],
    [
      ...complete.settings,
      { ...inherited, observationId: "unknown#0", name: "unknown-protected-rule", actual: "true" },
    ],
    [good.settings[0], { ...complete.settings[1], path: "other.json" }],
    [good.settings[0], { ...complete.settings[1], name: "unknown-protected-rule" }],
    [good.settings[0], { ...complete.settings[1], expected: "false", actual: "false" }],
    [
      good.settings[0],
      { ...complete.settings[1], comparison: "ceiling" as const, expected: 1, actual: 0 },
    ],
  ]) {
    const execution = tool();
    const result = await checkQualityCoverage(
      invocation,
      reader({ ...complete, settings }),
      execution.provider,
    );
    assert.equal(result.outcome, "violations");
    assert.ok(
      result.diagnostics.every(
        ({ ruleId }) => ruleId === "quality.source-coverage.protected-setting",
      ),
    );
    assert.deepEqual(execution.calls, []);
  }
}

async function classifiedSelectedTestsPreserveProductionCoverageAndFull(): Promise<void> {
  const testPath = "packages/contexts/private-worker/tests/example.test.ts";
  const observation = { ...good, testPaths: [testPath] };
  const selected = [path, testPath];
  const complete = tool({
    select: async () => selected,
    lint: async () => ({ files: 2, diagnostics: [] }),
  });
  assert.equal(
    (await checkQualityCoverage(invocation, reader(observation), complete.provider)).outcome,
    "passed",
  );
  assert.deepEqual(complete.calls, ["prepare", "context", "scan"]);
  const scope = tool({ select: async () => selected });
  assert.equal(
    (
      await checkQualityCoverage(
        { ...invocation, scopeOnly: true },
        reader(observation),
        scope.provider,
      )
    ).outcome,
    "passed",
  );
  const omitted = await checkQualityCoverage(
    invocation,
    reader(observation),
    tool({ select: async () => [testPath] }).provider,
  );
  assert.equal(omitted.outcome, "violations");
  assert.ok(
    omitted.diagnostics.some(
      ({ location, ruleId }) =>
        location.path === path && ruleId === "quality.source-coverage.selection-mismatch",
    ),
  );
  const unknown = "packages/contexts/private-worker/tests/not-in-census.test.ts";
  const unknownResult = await checkQualityCoverage(
    invocation,
    reader(observation),
    tool({ select: async () => [...selected, unknown] }).provider,
  );
  assert.equal(unknownResult.outcome, "violations");
  assert.ok(
    unknownResult.diagnostics.some(
      ({ location, ruleId }) =>
        location.path === unknown && ruleId === "quality.source-coverage.selection-mismatch",
    ),
  );
  const wrongCount = await checkQualityCoverage(
    invocation,
    reader(observation),
    tool({ select: async () => selected }).provider,
  );
  assert.equal(wrongCount.outcome, "failed");
  assert.deepEqual(wrongCount.diagnostics, []);
}

async function nativeProductionRemainsClassifiedAndRequiresConsumerGate(): Promise<void> {
  const nativePath = "packages/platform/custody/native/rename.c";
  const native = {
    path: nativePath,
    owners: ["custody.native"],
    suppressionCovered: true,
    nativeGates: [{ script: "native:check", reached: true }],
  };
  const observation = { ...good, sources: [...good.sources, native] };
  const execution = tool();
  assert.equal(
    (await checkQualityCoverage(invocation, reader(observation), execution.provider)).outcome,
    "passed",
  );
  assert.deepEqual(execution.calls, ["prepare", "select", "context", "scan", "lint"]);
  for (const nativeGates of [
    [],
    [{ script: "native:check", reached: false }],
    [native.nativeGates[0], native.nativeGates[0]],
  ]) {
    const rejected = await checkStaticQualityCoverage(
      invocation,
      reader({ ...observation, sources: [...good.sources, { ...native, nativeGates }] }),
    );
    assert.equal(rejected.outcome, "violations");
    assert.ok(
      rejected.diagnostics.some(
        ({ ruleId, location }) =>
          ruleId === "quality.source-coverage.native-route" && location.path === nativePath,
      ),
    );
  }
  const unowned = await checkStaticQualityCoverage(
    invocation,
    reader({ ...observation, sources: [...good.sources, { ...native, owners: [] }] }),
  );
  assert.ok(
    unowned.diagnostics.some(
      ({ ruleId }) => ruleId === "quality.source-coverage.source-classification",
    ),
  );
}

async function requiredScriptRoutesRejectDirectAndNestedLiteral(): Promise<void> {
  const { containsScriptRoute, executesScript } =
    await import("../../../packages/engineering-foundation/dist/features/quality-coverage/application/script-route.js");
  const expected = "agent-teams-foundation quality check --consumer .";
  const valid = {
    check: "pnpm build && pnpm lint:typed",
    build: "tsc --build",
    "lint:typed": expected,
  };
  assert.equal(executesScript(valid, "check", "lint:typed", expected), true);
  for (const scripts of [
    { ...valid, check: "false && pnpm lint:typed" },
    { ...valid, build: "false" },
    { ...valid, build: "pnpm prepare", prepare: "false" },
    { ...valid, "lint:typed": "false && " + expected },
  ]) {
    assert.equal(containsScriptRoute(scripts, "check", "lint:typed", expected), true);
    assert.equal(executesScript(scripts, "check", "lint:typed", expected), false);
  }
}

async function staticHostQualityRoutesPreserveFailureMissingScript(): Promise<void> {
  const { executesScript, qualityHostCommand, nativeScriptEntrypoint } =
    await import("../../../packages/engineering-foundation/dist/features/quality-coverage/application/script-route.js");
  const host = "node architecture/tooling/runtime/command.ts";
  const other = "node .tools/dispatch.mjs";
  const full = `${host} tool agent-teams-foundation quality check --consumer .`;
  const scope = `${other} tool agent-teams-foundation quality check --consumer . --scope-only`;
  assert.equal(qualityHostCommand(full, false), true);
  assert.equal(qualityHostCommand(scope, true), true);
  assert.equal(qualityHostCommand(scope, false), false);
  assert.equal(qualityHostCommand(full, true), false);
  for (const command of [
    full + " extra",
    full + "\n",
    full.replace("quality check", "quality plan"),
    full.replace("--consumer .", "--consumer other"),
    full.replace("agent-teams-foundation", "other"),
    full.replace("architecture/", "../"),
    full.replace("architecture/", "/architecture/"),
    full.replace("node ", "env X=1 node "),
    full.replace("node ", "node --import x "),
    full.replace("command.ts", "command.txt"),
    full.replace("command.ts", "'command.ts'"),
    full.replace("architecture/", "https://host/"),
    full + " || true",
  ]) {
    assert.equal(qualityHostCommand(command, false), false, command);
  }
  const valid = {
    check: `${host} run build && ${other} run nested`,
    build: "tsc --build",
    nested: `${host} script lint:typed`,
    "lint:typed": full,
  };
  assert.equal(executesScript(valid, "check", "lint:typed", full), true);
  for (const scripts of [
    { ...valid, build: "false" },
    { ...valid, build: `${host} run missing` },
    { ...valid, build: `${host} run build` },
    { ...valid, build: "pnpm missing" },
    { ...valid, nested: `${host} run absent` },
    { ...valid, nested: "true" },
    { ...valid, check: `${host} run nested || true` },
    { ...valid, check: `${host} run nested\n` },
    { ...valid, check: `${host} run nested extra` },
    { ...valid, "lint:typed": "true" },
  ]) {
    assert.equal(executesScript(scripts, "check", "lint:typed", full), false);
  }
  const deep: Record<string, string> = { ...valid, build: `${host} run depth0` };
  for (let index = 0; index < 129; index += 1) {
    deep[`depth${index}`] = `${host} run depth${index + 1}`;
  }
  deep.depth129 = "true";
  assert.equal(executesScript(deep, "check", "lint:typed", full), false);
  // Readability/declaration only: even this no-op dispatcher body is not inspected here.
  assert.equal(
    nativeScriptEntrypoint(`${host} tool native:check`),
    "architecture/tooling/runtime/command.ts",
  );
  assert.equal(
    nativeScriptEntrypoint(`${other} tool architecture/checks/native.mjs`),
    ".tools/dispatch.mjs",
  );
  for (const command of [
    `${host} run native:check`,
    `${host} tool native:check extra`,
    `${host} tool ../native.mjs`,
    `${host} tool C:/outside.ts`,
    `${host} tool https://host/native.ts`,
    `${host} tool /outside.ts`,
    `${host} tool native:check\n`,
    "true",
  ]) {
    assert.equal(nativeScriptEntrypoint(command), undefined);
  }
}
