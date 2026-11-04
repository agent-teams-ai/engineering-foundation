import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { qualityFixtureRecord } from "../../../scripts/quality-command-report.ts";
import type { CapabilityReport } from "../../../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import type { QualityCoverageReader } from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";
import type { WorkspacePackage } from "../../../packages/engineering-foundation/dist/workspace-inventory/api.js";
import {
  assertCanonicalRootAlias,
  fixturePackage,
  moduleRoot,
  sourceRoot,
  main,
  compilerProject,
  topology,
} from "./source-observation-fixture.ts";
import type { QualityTextPut } from "./quality-cli-fixture.ts";

interface StaticPolicyInput {
  root: string;
  put: QualityTextPut;
  run: () => Promise<CapabilityReport>;
  scripts: Readonly<Record<string, string>>;
  packages: WorkspacePackage[];
  reader: QualityCoverageReader;
  t: TestContext;
}

async function assertStaticQualityRoutes({
  put,
  run,
  scripts,
}: Pick<StaticPolicyInput, "put" | "run" | "scripts">) {
  await put("package.json", JSON.stringify({ scripts }));
  assert.equal((await run()).outcome, "passed");
  const host = "node architecture/tooling/runtime/command.ts";
  const hostScripts = {
    ...scripts,
    "check:fast": `${"true && ".repeat(180)}${host} run quality:scope`,
    check: `${host} run lint:typed`,
    "quality:scope": `${host} tool agent-teams-foundation quality check --consumer . --scope-only`,
    "lint:typed": `${host} tool agent-teams-foundation quality check --consumer .`,
  };
  await put("package.json", JSON.stringify({ scripts: hostScripts }));
  assert.equal(
    (await run()).outcome,
    "passed",
    "long Host run/tool declarations retain both mode-specific routes",
  );
  await put(
    "package.json",
    JSON.stringify({ scripts: { ...hostScripts, "lint:typed": hostScripts["quality:scope"] } }),
  );
  assert.equal(
    (await run()).outcome,
    "violations",
    "scope-only Host tools cannot activate the full route",
  );
  await put("package.json", JSON.stringify({ scripts }));
}

async function assertSemanticCheckRejected({
  put,
  run,
  lintBytes,
}: {
  put: QualityTextPut;
  run: () => Promise<CapabilityReport>;
  lintBytes: string;
}) {
  const lint = qualityFixtureRecord(JSON.parse(lintBytes));
  await put(
    "lint.json",
    JSON.stringify({
      ...lint,
      options: { ...qualityFixtureRecord(lint["options"]), typeCheck: true },
    }),
  );
  const semanticRoot = await run();
  assert.equal(
    semanticRoot.outcome,
    "invalid-input",
    "root config cannot start a second semantic checker",
  );
  assert.equal(semanticRoot.problem?.code, "QUALITY_PROFILE_INVALID");
  assert.match(semanticRoot.problem.message, /Oxlint semantic typeCheck/u);
  await put("semantic-base.json", JSON.stringify({ options: { typeCheck: true } }));
  await put("lint.json", JSON.stringify({ ...lint, extends: ["./semantic-base.json"] }));
  const semanticInherited = await run();
  assert.equal(
    semanticInherited.outcome,
    "invalid-input",
    "inherited semantic checker activation rejects before lint execution",
  );
  assert.equal(semanticInherited.problem?.code, "QUALITY_PROFILE_INVALID");
  assert.match(semanticInherited.problem.message, /Oxlint semantic typeCheck/u);
  await put("lint.json", lintBytes);
}

async function assertRootSuppressionPolicies({
  root,
  put,
  run,
  reader,
  t,
  lintBytes,
}: Pick<StaticPolicyInput, "root" | "put" | "run" | "reader" | "t"> & { lintBytes: string }) {
  await put("suppression-base.json", lintBytes);
  await put("lint.json", JSON.stringify({ extends: ["./suppression-base.json"] }));
  assert.equal(
    (await run()).outcome,
    "violations",
    "root-only suppression options cannot be inherited",
  );
  const missingOptions = qualityFixtureRecord(JSON.parse(lintBytes));
  const options = qualityFixtureRecord(missingOptions["options"]);
  delete options["respectEslintDisableDirectives"];
  delete options["reportUnusedDisableDirectives"];
  missingOptions["options"] = options;
  await put("lint.json", JSON.stringify(missingOptions));
  assert.equal(
    (await run()).outcome,
    "violations",
    "missing root-only options cannot imply protection",
  );
  await put("lint.json", lintBytes);
  await put("untyped-base.json", JSON.stringify({ options: { typeAware: false } }));
  await put(
    "lint.json",
    JSON.stringify({
      ...qualityFixtureRecord(JSON.parse(lintBytes)),
      extends: ["./untyped-base.json"],
    }),
  );
  assert.equal((await run()).outcome, "passed", "typed activation may extend an untyped base");
  await assertCanonicalRootAlias(t, root, reader);
  await put("typed-base.json", lintBytes);
  await put(
    "lint.json",
    JSON.stringify({ extends: ["./typed-base.json"], options: { typeAware: false } }),
  );
  assert.equal(
    (await run()).outcome,
    "violations",
    "a consumer cannot disable inherited typed activation",
  );
  await put("lint.json", lintBytes);
}

async function assertToolingClassification({
  root,
  put,
  run,
  reader,
}: Pick<StaticPolicyInput, "root" | "put" | "run" | "reader">) {
  const topologyBytes = await readFile(join(root, "topology.json"), "utf8");
  const generator = `${moduleRoot}/scripts/generate.mjs`;
  await put("topology.json", JSON.stringify({ ...topology, toolingFiles: [generator] }));
  await put(generator, "export const generate = () => 1;\n");
  assert.equal((await run()).outcome, "passed", "exact tooling files remain classified");
  const newScript = `${moduleRoot}/scripts/unclassified.mjs`;
  await put(newScript, "export const unknown = 1;\n");
  assert.ok(
    (await run()).diagnostics.some(
      ({ ruleId, location }) =>
        ruleId === "quality.source-coverage.source-classification" && location.path === newScript,
    ),
  );
  await rm(join(root, moduleRoot, "scripts"), { recursive: true });
  await put("topology.json", JSON.stringify({ ...topology, toolingFiles: [main] }));
  const withProductionGenerator = await reader.read(root, "quality.yaml");
  assert.ok(
    withProductionGenerator.observation.sources.some(({ path }) => path === main),
    "production generators retain ordinary protection",
  );
  await put("topology.json", topologyBytes);
}

async function assertInheritedProtectedBudgets({
  put,
  run,
  lintBytes,
}: Pick<StaticPolicyInput, "put" | "run"> & { lintBytes: string }) {
  const lint = qualityFixtureRecord(JSON.parse(lintBytes));
  const stronger = {
    ...lint,
    rules: {
      ...qualityFixtureRecord(lint["rules"]),
      "max-lines": ["error", { max: 300 }],
    },
  };
  await put("stronger.json", JSON.stringify(stronger));
  for (const maximum of [250, 300, 400]) {
    await put(
      "lint.json",
      JSON.stringify({
        extends: ["./stronger.json"],
        options: lint["options"],
        rules: { "max-lines": ["error", { max: maximum }] },
      }),
    );
    const inherited = await run();
    assert.equal(inherited.outcome, maximum <= 300 ? "passed" : "violations");
    if (maximum > 300) {
      assert.ok(
        inherited.diagnostics.some(
          ({ ruleId }) => ruleId === "quality.source-coverage.protected-setting",
        ),
      );
    }
  }
  await put(
    "lint.json",
    JSON.stringify({
      ...stronger,
      overrides: [
        {
          files: [`${sourceRoot}/**`],
          rules: { "max-lines": ["error", { max: 400 }] },
        },
      ],
    }),
  );
  assert.equal((await run()).outcome, "violations");
  await put("lint.json", lintBytes);
}

async function assertScopedOverrides({
  root,
  put,
  run,
  lintBytes,
}: Pick<StaticPolicyInput, "root" | "put" | "run"> & { lintBytes: string }) {
  const lint = qualityFixtureRecord(JSON.parse(lintBytes));
  await put(`${moduleRoot}/tests/example.test.ts`, "export const example = true;\n");
  const withOverride = async (files: readonly string[], maximum: unknown = 800) => {
    await put(
      "lint.json",
      JSON.stringify({
        ...lint,
        overrides: [{ files, rules: { "max-lines": ["error", { max: maximum }] } }],
      }),
    );
    return run();
  };
  assert.equal((await withOverride([`${moduleRoot}/tests/**`])).outcome, "passed");
  assert.equal((await withOverride([`${sourceRoot}/**`], 300)).outcome, "passed");
  assert.equal((await withOverride([compilerProject], 300)).outcome, "invalid-input");
  await put(`${sourceRoot}/unknown.json`, "{}");
  const unknownJson = await withOverride([`${sourceRoot}/**`], 300);
  assert.equal(unknownJson.outcome, "violations");
  assert.ok(
    unknownJson.diagnostics.some(
      ({ ruleId, location }) =>
        ruleId === "quality.source-coverage.source-language" &&
        location.path === `${sourceRoot}/unknown.json`,
    ),
  );
  await rm(join(root, sourceRoot, "unknown.json"));

  for (const maximum of ["800", null, -1]) {
    assert.equal((await withOverride([`${moduleRoot}/tests/**`], maximum)).outcome, "violations");
  }
  await put(`${sourceRoot}/fixtures/production.test.ts`, "export const production = true;\n");
  for (const files of [["**/*.test.ts"], [`${sourceRoot}/fixtures/**`]]) {
    const overlapping = await withOverride(files);
    assert.equal(overlapping.outcome, "violations");
    assert.ok(
      overlapping.diagnostics.some(
        ({ ruleId }) => ruleId === "quality.source-coverage.protected-setting",
      ),
    );
  }
  assert.equal((await withOverride(["unknown-tests/**"])).outcome, "invalid-input");
  await put(
    "lint.json",
    JSON.stringify({
      ...lint,
      overrides: [
        {
          files: [`${moduleRoot}/tests/**`],
          rules: { "typescript/no-floating-promises": "off" },
        },
      ],
    }),
  );
  assert.equal((await run()).outcome, "violations");
  await put("lint.json", lintBytes);
  await rm(join(root, sourceRoot, "fixtures"), { recursive: true });
}

async function assertRequiredRoutesAndCensus({
  root,
  put,
  run,
  scripts,
  packages,
}: Pick<StaticPolicyInput, "root" | "put" | "run" | "scripts" | "packages">) {
  for (const command of [
    undefined,
    "true",
    "echo quality check",
    "true || pnpm lint:typed",
    scripts["quality:scope"],
  ]) {
    await put("package.json", JSON.stringify({ scripts: { ...scripts, "lint:typed": command } }));
    const report = await run();
    assert.equal(report.outcome, "violations");
    assert.ok(
      report.diagnostics.some(({ ruleId }) => ruleId === "quality.source-coverage.required-route"),
    );
  }
  await put("package.json", JSON.stringify({ scripts }));
  packages.push(fixturePackage("new-root/worker"));
  const unknown = await run();
  assert.equal(unknown.outcome, "violations");
  assert.ok(
    unknown.diagnostics.some(
      ({ ruleId, location }) =>
        ruleId === "quality.source-coverage.source-package" &&
        location.path === "new-root/worker/package.json",
    ),
  );

  packages.pop();
  assert.equal((await run()).outcome, "passed");
  await put(`${sourceRoot}/unclassified.future`, "unknown language\n");
  const pendingSource = await run();
  assert.ok(
    pendingSource.diagnostics.some(
      ({ ruleId, location }) =>
        ruleId === "quality.source-coverage.source-language" &&
        location.path === `${sourceRoot}/unclassified.future`,
    ),
  );
  await rm(join(root, sourceRoot, "unclassified.future"));
  await put("topology.json", JSON.stringify({ ...topology, sourceRoots: ["../wrong/src"] }));
  assert.equal((await run()).outcome, "invalid-input");
  await put("topology.json", JSON.stringify(topology));
}

export async function assertStaticReaderPolicies(input: StaticPolicyInput) {
  await assertStaticQualityRoutes(input);
  const lintBytes = await readFile(join(input.root, "lint.json"), "utf8");
  await assertSemanticCheckRejected({ ...input, lintBytes });
  await assertRootSuppressionPolicies({ ...input, lintBytes });
  await assertToolingClassification(input);
  await assertInheritedProtectedBudgets({ ...input, lintBytes });
  await assertScopedOverrides({ ...input, lintBytes });
  await assertRequiredRoutesAndCensus(input);
  return lintBytes;
}
