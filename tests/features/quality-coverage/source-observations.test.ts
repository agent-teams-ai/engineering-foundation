import assert from "node:assert/strict";
import { qualityFixtureRecord } from "../../../scripts/quality-command-report.ts";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readContainedRegularFile } from "../../../packages/engineering-foundation/dist/source-inventory/node.js";
import { createStrictYamlFileLoader } from "../../../packages/engineering-foundation/dist/features/configuration-input/node.js";
import { createQualityCoverageReader } from "../../../packages/engineering-foundation/dist/features/quality-coverage/node.js";
import { checkStaticQualityCoverage } from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";
import {
  fixture,
  fixturePackage,
  sourceRoot,
  compilerProject,
  topology,
  authority,
  censusReader,
} from "./source-observation-fixture.ts";
import { qualityReport, type QualityFixtureProfile } from "./quality-cli-fixture.ts";
import { assertStaticReaderPolicies } from "./source-static-policy-cases.ts";
import { assertPublicQualityChecks } from "./source-public-check-cases.ts";
import { registerCensusCases } from "./source-census-cases.ts";
import { registerDiscoveryCases, registerTopologyCases } from "./source-discovery-cases.ts";
import { registerFormatAdmissionCases } from "./format-coverage-admission.ts";
import { registerFormatCoverageSeams } from "./format-coverage-seams.ts";

registerCensusCases();
registerDiscoveryCases();
registerTopologyCases();
registerFormatAdmissionCases();
registerFormatCoverageSeams();

void test("quality CLI fixtures reject incomplete success reports before asserting outcomes", () => {
  for (const value of [
    { outcome: "passed" },
    { reportSchemaVersion: 1, outcome: "passed", capabilities: [] },
    {
      reportSchemaVersion: 1,
      outcome: "passed",
      capabilities: [
        { capabilityId: "quality.source-coverage", outcome: "passed", diagnostics: [] },
      ],
    },
  ]) {
    assert.throws(() => qualityReport(JSON.stringify(value)));
  }
  assert.deepEqual(
    qualityReport(
      JSON.stringify({
        schemaVersion: 1,
        outcome: "invalid-input",
        error: { code: "SCHEMA_VALIDATION_FAILED", message: "Invalid root configuration." },
      }),
    ),
    {
      outcome: "invalid-input",
      capabilities: [],
      error: { code: "SCHEMA_VALIDATION_FAILED", message: "Invalid root configuration." },
    },
  );
});

void test("static reader joins owned authorities and rejects removed or scope-only full activation", async (t) => {
  const { root, put } = await fixture(t);
  const profile: QualityFixtureProfile = {
    schemaVersion: 5,
    budgetMs: 120000,
    sourcePolicyPath: "source.yaml",
    suppressionPolicyPath: "suppressions.yaml",
    topologyPath: "topology.json",
    lintConfigPath: "lint.json",
    toolchainConfigPath: "toolchain.config.json",
    scripts: { fast: "check:fast", full: "check", scope: "quality:scope", typed: "lint:typed" },
  };
  await put("quality.yaml", JSON.stringify(profile));
  await put(
    "toolchain.config.json",
    JSON.stringify({ typecheck: { projects: [compilerProject] } }),
  );
  await put(
    compilerProject,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        types: [],
        noEmit: true,
      },
      include: ["./**/*.ts"],
    }),
  );
  await put("topology.json", JSON.stringify(topology));
  const typedInput: unknown = JSON.parse(
    await readFile(
      new URL("../../../packages/stack-toolchain/presets/oxlint/type-aware.json", import.meta.url),
      "utf8",
    ),
  );
  const maintainabilityInput: unknown = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/stack-toolchain/presets/oxlint/maintainability.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const typed = qualityFixtureRecord(typedInput);
  const maintainability = qualityFixtureRecord(maintainabilityInput);
  await put(
    "lint.json",
    JSON.stringify({
      options: {
        ...qualityFixtureRecord(typed["options"]),
        respectEslintDisableDirectives: false,
        reportUnusedDisableDirectives: "error",
      },
      rules: {
        ...qualityFixtureRecord(typed["rules"]),
        ...qualityFixtureRecord(maintainability["rules"]),
      },
    }),
  );
  const scripts = {
    "check:fast": "pnpm quality:scope",
    check: "pnpm lint:typed",
    "quality:scope": "agent-teams-foundation quality check --consumer . --scope-only",
    "lint:typed": "agent-teams-foundation quality check --consumer .",
  };
  const packages = [fixturePackage("spikes/parser")];
  const reader = createQualityCoverageReader(
    {
      census: censusReader,
      inventory: { read: async () => ({ packages, catalogs: [] }) },
      authority: {
        source: async () => authority,
        suppressions: async () => ({ governedRoots: [sourceRoot] }),
      },
    },
    {
      createReader: createStrictYamlFileLoader,
      assertProfile: async (value) => {
        assert.deepEqual(value, profile);
      },
    },
    readContainedRegularFile,
  );
  const run = () =>
    checkStaticQualityCoverage({ consumerRoot: root, configPath: "quality.yaml" }, reader);
  const lintBytes = await assertStaticReaderPolicies({
    root,
    put,
    run,
    scripts,
    packages,
    reader,
    t,
  });
  await assertPublicQualityChecks({ root, put, profile, scripts, lintBytes });
});
