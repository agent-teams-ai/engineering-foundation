import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { classifyPublicApiChange } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/evaluate-public-api-compatibility.js";
import { promotePublicApiBaselines } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/promote-public-api-baselines.js";
import {
  check,
  cliPath,
  withPublicApiFixture
} from "./support/capability-fixtures.mjs";
import {
  ACCEPTED_DECISION_BASELINE_PATH,
  GOVERNANCE_CONFIG_PATH,
  ROOT_STABLE_ITEM,
  configureV2PublicApiFixture,
  sha256,
  v2Baseline,
  writeGovernedDecisionEvidence
} from "./support/public-api-fixtures.mjs";

test("accepts a public API identical to its released baseline", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0);
    assert.equal(report.outcome, "passed");
    assert.equal(report.capabilities[0].capabilityConfigSchemaVersion, 1);
  });
});

test("keeps the schema v1 change fingerprint byte-for-byte compatible", () => {
  const released = {
    schemaVersion: 1,
    packageName: "@fixture/public-api",
    packageVersion: "1.2.3",
    extractorVersion: "7.58.12",
    items: [ROOT_STABLE_ITEM],
  };
  const currentItem = {
    ...ROOT_STABLE_ITEM,
    signature: "export declare function stable(value: number): string;",
  };
  const current = { ...released, items: [currentItem] };
  const expectedEvidence = {
    added: [],
    changed: [{ before: ROOT_STABLE_ITEM, after: currentItem }],
    removed: [],
  };

  const change = classifyPublicApiChange(released, current, { sha256 });

  assert.equal(change.schemaVersion, 1);
  assert.equal(change.classification, "breaking");
  assert.equal(change.fingerprint, `sha256:${sha256(JSON.stringify(expectedEvidence))}`);
});

test("accepts schema v2 with multiple entrypoints and reports its actual schema", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    await configureV2PublicApiFixture(consumerRoot);

    const { result, report } = check(consumerRoot);

    assert.equal(result.status, 0);
    assert.equal(report.outcome, "passed");
    assert.equal(report.capabilities[0].capabilityConfigSchemaVersion, 2);
  });
});

test("checks a root localMode namespace and its independently importable subpath", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    await configureV2PublicApiFixture(consumerRoot);
    const packageDirectory = join(consumerRoot, "packages", "library");
    await writeFile(
      join(packageDirectory, "dist", "index.d.ts"),
      [
        'export * as localMode from "./local-mode.js";',
        "export declare function stable(value: string): string;",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(consumerRoot, ".changeset", "add-root-local-mode.md"),
      '---\n"@fixture/public-api": minor\n---\n\nExpose the local mode namespace from the root entrypoint.\n',
      "utf8",
    );

    const { result, report } = check(consumerRoot);

    assert.equal(result.status, 0);
    assert.equal(report.outcome, "passed");
  });
});

test("scopes v2 collisions by export path and keeps comparisons order-independent", () => {
  const released = v2Baseline();
  const current = {
    ...released,
    entrypoints: [
      {
        exportPath: "./local-mode",
        items: [
          {
            ...ROOT_STABLE_ITEM,
            signature: "export declare function stable(value: number): string;",
          },
        ],
      },
      { exportPath: ".", items: [ROOT_STABLE_ITEM] },
    ],
  };

  const change = classifyPublicApiChange(released, current, { sha256 });
  const reordered = classifyPublicApiChange(
    { ...released, entrypoints: released.entrypoints.toReversed() },
    { ...current, entrypoints: current.entrypoints.toReversed() },
    { sha256 },
  );

  assert.equal(change.schemaVersion, 2);
  assert.equal(change.classification, "breaking");
  assert.deepEqual(change.changed, [
    {
      exportPath: "./local-mode",
      canonicalReference: "@fixture/public-api!stable:function(1)",
    },
  ]);
  assert.equal(change.fingerprint, reordered.fingerprint);
  assert.throws(
    () =>
      classifyPublicApiChange(
        {
          ...released,
          entrypoints: [released.entrypoints[0], released.entrypoints[0]],
        },
        current,
        { sha256 },
      ),
    /duplicate export path/u,
  );
});

test("requires a minor Changeset for a schema v2 additive subpath export", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    await configureV2PublicApiFixture(consumerRoot);
    await writeFile(
      join(consumerRoot, "packages", "library", "dist", "local-mode.d.ts"),
      [
        "export declare function added(): void;",
        "export declare function stable(value: string): string;",
        "",
      ].join("\n"),
      "utf8",
    );

    const missing = check(consumerRoot);
    assert.equal(missing.result.status, 1);
    assert.deepEqual(
      missing.report.capabilities[0].diagnostics.map(({ ruleId }) => ruleId),
      ["package.public-api-compatibility.missing-changeset"],
    );

    await writeFile(
      join(consumerRoot, ".changeset", "add-local-mode-api.md"),
      '---\n"@fixture/public-api": minor\n---\n\nAdd a local-mode API.\n',
      "utf8",
    );
    assert.equal(check(consumerRoot).result.status, 0);
  });
});

test("requires an accepted exact fingerprint for a schema v2 breaking subpath change", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const configPath = await configureV2PublicApiFixture(consumerRoot);
    await writeFile(
      join(consumerRoot, "packages", "library", "dist", "local-mode.d.ts"),
      "export declare function stable(value: number): string;\n",
      "utf8",
    );
    await writeFile(
      join(consumerRoot, ".changeset", "break-local-mode-api.md"),
      '---\n"@fixture/public-api": major\n---\n\nBreak a local-mode API.\n',
      "utf8",
    );

    const blocked = check(consumerRoot);
    assert.equal(blocked.result.status, 1);
    const diagnostic = blocked.report.capabilities[0].diagnostics.find(
      ({ ruleId }) =>
        ruleId === "package.public-api-compatibility.breaking-change-not-approved",
    );
    assert.notEqual(diagnostic, undefined);
    const fingerprint = diagnostic.evidence.find(
      ({ kind }) => kind === "change-fingerprint",
    ).value;

    const config = parseYaml(await readFile(configPath, "utf8"));
    config.governanceConfigPath = GOVERNANCE_CONFIG_PATH;
    config.packages[0].approvedBreakingChanges = [
      {
        fingerprint,
        decisionId: "ADR-0001",
      },
    ];
    await writeFile(configPath, stringifyYaml(config, { lineWidth: 0 }), "utf8");
    const missingGovernanceEvidence = check(consumerRoot);
    assert.equal(missingGovernanceEvidence.result.status, 2);
    assert.equal(
      missingGovernanceEvidence.report.capabilities[0].problem?.code,
      "CONFIG_FILE_UNAVAILABLE",
    );

    await writeGovernedDecisionEvidence(consumerRoot);
    const validBaselinePath = join(consumerRoot, ACCEPTED_DECISION_BASELINE_PATH);
    const validBaseline = await readFile(validBaselinePath, "utf8");
    const fabricatedBaseline = JSON.parse(validBaseline);
    fabricatedBaseline.decisions[0].immutableDigest = `sha256:${"a".repeat(64)}`;
    await writeFile(
      validBaselinePath,
      `${JSON.stringify(fabricatedBaseline, null, 2)}\n`,
      "utf8",
    );

    const fabricatedEvidence = check(consumerRoot);
    assert.equal(fabricatedEvidence.result.status, 2);
    assert.equal(
      fabricatedEvidence.report.capabilities[0].problem?.code,
      "ARCHITECTURE_DECISION_EVIDENCE_INVALID",
    );

    await writeFile(validBaselinePath, validBaseline, "utf8");
    assert.equal(check(consumerRoot).result.status, 0);

    await writeFile(
      validBaselinePath,
      `${JSON.stringify({
        schemaVersion: 1,
        algorithm: "sha256",
        decisions: [
          {
            id: "ADR-0001",
            path: "docs/decisions/0001-approve-public-api-break.md",
            immutableDigest: `sha256:${"b".repeat(64)}`,
          },
          {
            id: "ADR-0001",
            path: "docs/decisions/0001-other.md",
            immutableDigest: `sha256:${"c".repeat(64)}`,
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );
    const malformedBaseline = check(consumerRoot);
    assert.equal(malformedBaseline.result.status, 2);
    assert.equal(
      malformedBaseline.report.capabilities[0].problem?.code,
      "ARCHITECTURE_DECISION_EVIDENCE_INVALID",
    );

    await writeFile(validBaselinePath, validBaseline, "utf8");
    const accepted = check(consumerRoot);
    assert.equal(accepted.result.status, 0);
  });
});

test("rejects a schema v2 configuration that omits a public typed subpath", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const configPath = await configureV2PublicApiFixture(consumerRoot);
    const config = parseYaml(await readFile(configPath, "utf8"));
    config.packages[0].entrypoints = config.packages[0].entrypoints.filter(
      ({ exportPath }) => exportPath !== "./local-mode",
    );
    await writeFile(configPath, stringifyYaml(config, { lineWidth: 0 }), "utf8");

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(report.outcome, "invalid-input");
    assert.equal(
      report.capabilities[0].problem?.code,
      "PUBLIC_API_PACKAGE_EXPORTS_INVALID",
    );
  });
});

test("requires explicit non-type export classification in schema v2", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const configPath = await configureV2PublicApiFixture(consumerRoot);
    const manifestPath = join(consumerRoot, "packages", "library", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.exports["./package.json"] = "./package.json";
    manifest.exports["./schemas/*"] = "./schemas/*";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const missing = check(consumerRoot);
    assert.equal(missing.result.status, 2);
    assert.equal(
      missing.report.capabilities[0].problem?.code,
      "PUBLIC_API_PACKAGE_EXPORTS_INVALID",
    );

    const config = parseYaml(await readFile(configPath, "utf8"));
    config.packages[0].nonTypeExports = [
      { exportPath: "./schemas/*", kind: "wildcard" },
      { exportPath: "./package.json", kind: "data" },
    ];
    await writeFile(configPath, stringifyYaml(config, { lineWidth: 0 }), "utf8");
    assert.equal(check(consumerRoot).result.status, 0);
  });
});

test("rejects v2 baseline pointer reset and paths outside its release-owned anchor", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const configPath = await configureV2PublicApiFixture(consumerRoot);
    const config = parseYaml(await readFile(configPath, "utf8"));
    config.packages[0].releasedBaselinePath = "architecture/public-api/reset.json";
    await writeFile(configPath, stringifyYaml(config, { lineWidth: 0 }), "utf8");

    const reset = check(consumerRoot);
    assert.equal(reset.result.status, 2);
    assert.equal(reset.report.outcome, "invalid-input");
    assert.equal(
      reset.report.capabilities[0].problem?.code,
      "PUBLIC_API_COMPATIBILITY_CONFIG_INVALID",
    );

    config.packages[0].releasedBaselinePath = "architecture/private/public-api.json";
    await writeFile(configPath, stringifyYaml(config, { lineWidth: 0 }), "utf8");

    const outside = check(consumerRoot);
    assert.equal(outside.result.status, 2);
    assert.equal(outside.report.outcome, "invalid-input");
    assert.equal(
      outside.report.capabilities[0].problem?.code,
      "PUBLIC_API_COMPATIBILITY_CONFIG_INVALID",
    );
  });
});

test("requires a minor Changeset for an additive public API", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const declarationPath = join(consumerRoot, "packages", "library", "dist", "index.d.ts");
    await writeFile(
      declarationPath,
      "export declare function added(): void;\nexport declare function stable(value: string): string;\n",
      "utf8",
    );
    const missing = check(consumerRoot);
    assert.equal(missing.result.status, 1);
    assert.deepEqual(
      missing.report.capabilities[0].diagnostics.map(({ ruleId }) => ruleId),
      ["package.public-api-compatibility.missing-changeset"],
    );

    await writeFile(
      join(consumerRoot, ".changeset", "add-api.md"),
      '---\n"@fixture/public-api": minor\n---\n\nAdd an API.\n',
      "utf8",
    );
    const accepted = check(consumerRoot);
    assert.equal(accepted.result.status, 0);
  });
});

test("rejects a package version older than its released API baseline", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const declarationPath = join(consumerRoot, "packages", "library", "dist", "index.d.ts");
    await writeFile(
      declarationPath,
      "export declare function added(): void;\nexport declare function stable(value: string): string;\n",
      "utf8",
    );
    const manifestPath = join(consumerRoot, "packages", "library", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "1.2.2";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(
      join(consumerRoot, ".changeset", "downgrade-api.md"),
      '---\n"@fixture/public-api": minor\n---\n\nAttempt a downgrade.\n',
      "utf8",
    );

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      report.capabilities[0].diagnostics.map(({ ruleId }) => ruleId),
      ["package.public-api-compatibility.baseline-version-mismatch"],
    );
  });
});

test("binds a legacy breaking approval to its exact fingerprint and immutable ADR path", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "packages", "library", "dist", "index.d.ts"),
      "export declare function stable(value: number): string;\n",
      "utf8",
    );
    await writeFile(
      join(consumerRoot, ".changeset", "break-api.md"),
      '---\n"@fixture/public-api": major\n---\n\nChange an API.\n',
      "utf8",
    );
    const blocked = check(consumerRoot);
    assert.equal(blocked.result.status, 1);
    const approvalDiagnostic = blocked.report.capabilities[0].diagnostics.find(
      ({ ruleId }) =>
        ruleId === "package.public-api-compatibility.breaking-change-not-approved",
    );
    assert.notEqual(approvalDiagnostic, undefined);
    const fingerprint = approvalDiagnostic.evidence.find(
      ({ kind }) => kind === "change-fingerprint",
    ).value;

    await writeFile(
      join(consumerRoot, "packages", "library", "dist", "index.d.ts"),
      "export declare function added(): void;\nexport declare function stable(value: number): string;\n",
      "utf8",
    );
    const expandedBreak = check(consumerRoot);
    const expandedFingerprint = expandedBreak.report.capabilities[0].diagnostics
      .find(
        ({ ruleId }) =>
          ruleId === "package.public-api-compatibility.breaking-change-not-approved",
      )
      .evidence.find(({ kind }) => kind === "change-fingerprint").value;
    assert.notEqual(expandedFingerprint, fingerprint);
    await writeFile(
      join(consumerRoot, "packages", "library", "dist", "index.d.ts"),
      "export declare function stable(value: number): string;\n",
      "utf8",
    );

    const configPath = join(
      consumerRoot,
      "architecture",
      "foundation",
      "public-api-compatibility.yaml",
    );
    const config = parseYaml(await readFile(configPath, "utf8"));
    const decision = await writeGovernedDecisionEvidence(consumerRoot);
    config.packages[0].approvedBreakingChanges = [
      {
        fingerprint,
        decisionPath: decision.decisionPath,
      },
    ];
    await writeFile(configPath, stringifyYaml(config, { lineWidth: 0 }), "utf8");
    const accepted = check(consumerRoot);
    assert.equal(accepted.result.status, 0);

    await writeFile(
      join(consumerRoot, "packages", "library", "dist", "index.d.ts"),
      "export declare function stable(value: boolean): string;\n",
      "utf8",
    );
    const differentBreak = check(consumerRoot);
    assert.equal(differentBreak.result.status, 1);
    assert.equal(
      differentBreak.report.capabilities[0].diagnostics.some(
        ({ ruleId }) =>
          ruleId === "package.public-api-compatibility.breaking-change-not-approved",
      ),
      true,
    );
  });
});

test("requires immutable decision evidence before promoting a breaking public API", async () => {
  const packagePolicy = {
    packageName: "@fixture/library",
    packageRoot: "packages/library",
    manifestPath: "packages/library/package.json",
    declarationEntryPoint: "packages/library/dist/index.d.ts",
    tsconfigPath: "packages/library/tsconfig.json",
    releasedBaselinePath: "architecture/public-api/library.json",
    approvedBreakingChanges: [],
  };
  const released = {
    schemaVersion: 1,
    packageName: packagePolicy.packageName,
    packageVersion: "1.0.0",
    extractorVersion: "7.58.12",
    items: [ROOT_STABLE_ITEM],
  };
  const current = {
    ...released,
    packageVersion: "2.0.0",
    items: [
      {
        ...ROOT_STABLE_ITEM,
        signature: "export declare function stable(value: number): string;",
      },
    ],
  };
  const fingerprint = classifyPublicApiChange(released, current, { sha256 }).fingerprint;
  packagePolicy.approvedBreakingChanges.push({
    fingerprint,
    decisionPath: "docs/decisions/0001-approve-public-api-break.md",
  });
  const evidenceRequests = [];

  await assert.rejects(
    promotePublicApiBaselines(
      {
        consumerRoot: "/fixture",
        policy: {
          schemaVersion: 1,
          acceptedDecisionBaselinePath: "architecture/decisions/accepted-decisions.json",
          governanceConfigPath: GOVERNANCE_CONFIG_PATH,
          changesetDirectory: ".changeset",
          packages: [packagePolicy],
        },
      },
      {
        extractor: {
          async extract() {
            return current;
          },
        },
        fingerprint: { sha256 },
        repository: {
          async readReleasedBaseline() {
            return released;
          },
          async readReleaseEvidence() {
            return { packageName: packagePolicy.packageName, packageVersion: "2.0.0" };
          },
          async writeReleasedBaseline() {
            throw new Error("must not write an unapproved breaking baseline");
          },
        },
        acceptedDecisionEvidence: {
          async readAcceptedDecisionEvidence(request) {
            evidenceRequests.push(request);
            return { acceptedDecisionIds: [], acceptedDecisionPaths: [] };
          },
        },
      },
    ),
    (error) => error?.problem?.code === "PUBLIC_API_BASELINE_PROMOTION_DECISION_NOT_ACCEPTED",
  );
  assert.deepEqual(evidenceRequests, [
    {
      consumerRoot: "/fixture",
      baselinePath: "architecture/decisions/accepted-decisions.json",
      governanceConfigPath: GOVERNANCE_CONFIG_PATH,
    },
  ]);
});

test("promotes a public API baseline only after a sufficient package release", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "packages", "library", "dist", "index.d.ts"),
      "export declare function added(): void;\nexport declare function stable(value: string): string;\n",
      "utf8",
    );
    const manifestPath = join(consumerRoot, "packages", "library", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "1.2.4";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const insufficient = spawnSync(
      process.execPath,
      [cliPath, "public-api-promote-release", "--consumer", consumerRoot, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(insufficient.status, 2);
    assert.match(
      insufficient.stderr,
      /^PUBLIC_API_BASELINE_PROMOTION_VERSION_INSUFFICIENT:/u,
    );

    manifest.version = "1.3.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const promotion = spawnSync(
      process.execPath,
      [cliPath, "public-api-promote-release", "--consumer", consumerRoot, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(promotion.status, 0, promotion.stderr);
    assert.equal(JSON.parse(promotion.stdout).promoted[0].packageVersion, "1.3.0");
    const baseline = JSON.parse(
      await readFile(join(consumerRoot, "architecture", "public-api", "public-api.json"), "utf8"),
    );
    assert.equal(baseline.packageVersion, "1.3.0");
    assert.equal(check(consumerRoot).result.status, 0);
  });
});

test("promotes one deterministic schema v2 baseline for every public entrypoint", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    await configureV2PublicApiFixture(consumerRoot);
    await writeFile(
      join(consumerRoot, "packages", "library", "dist", "local-mode.d.ts"),
      [
        "export declare function added(): void;",
        "export declare function stable(value: string): string;",
        "",
      ].join("\n"),
      "utf8",
    );
    const manifestPath = join(consumerRoot, "packages", "library", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "1.3.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const promotion = spawnSync(
      process.execPath,
      [cliPath, "public-api-promote-release", "--consumer", consumerRoot, "--json"],
      { encoding: "utf8" },
    );

    assert.equal(promotion.status, 0, promotion.stderr);
    const baseline = JSON.parse(
      await readFile(join(consumerRoot, "architecture", "public-api", "public-api.json"), "utf8"),
    );
    assert.equal(baseline.schemaVersion, 2);
    assert.equal(baseline.packageVersion, "1.3.0");
    assert.deepEqual(
      baseline.entrypoints.map(({ exportPath }) => exportPath),
      [".", "./local-mode"],
    );
    assert.equal(check(consumerRoot).result.status, 0);
  });
});

test("validates every public API promotion before writing any baseline", async () => {
  const packagePolicies = ["first", "second"].map((name) => ({
    packageName: `@fixture/${name}`,
    packageRoot: `packages/${name}`,
    manifestPath: `packages/${name}/package.json`,
    declarationEntryPoint: `packages/${name}/dist/index.d.ts`,
    tsconfigPath: `packages/${name}/tsconfig.json`,
    releasedBaselinePath: `architecture/public-api/${name}.json`,
    approvedBreakingChanges: [],
  }));
  const writes = [];

  await assert.rejects(
    promotePublicApiBaselines(
      {
        consumerRoot: "/fixture",
        policy: {
          schemaVersion: 1,
          changesetDirectory: ".changeset",
          packages: packagePolicies,
        },
      },
      {
        extractor: {
          async extract(_consumerRoot, packagePolicy, packageVersion) {
            if (packagePolicy.packageName === "@fixture/second") {
              throw new Error("invalid second package declaration");
            }
            return {
              schemaVersion: 1,
              packageName: packagePolicy.packageName,
              packageVersion,
              extractorVersion: "7.58.12",
              items: [],
            };
          },
        },
        fingerprint: { sha256: () => "a".repeat(64) },
        repository: {
          async readReleasedBaseline(_consumerRoot, packagePolicy) {
            return {
              schemaVersion: 1,
              packageName: packagePolicy.packageName,
              packageVersion: "1.0.0",
              extractorVersion: "7.58.12",
              items: [],
            };
          },
          async readReleaseEvidence() {
            return { packageVersion: "1.0.1" };
          },
          async writeReleasedBaseline(...args) {
            writes.push(args);
          },
        },
        acceptedDecisionEvidence: {
          async readAcceptedDecisionEvidence() {
            return { acceptedDecisionIds: [], acceptedDecisionPaths: [] };
          },
        },
      },
    ),
    /invalid second package declaration/u,
  );
  assert.deepEqual(writes, []);
});

test("replays public API promotion after a partially written multi-package release", async () => {
  const packagePolicies = ["first", "second"].map((name) => ({
    packageName: `@fixture/${name}`,
    packageRoot: `packages/${name}`,
    manifestPath: `packages/${name}/package.json`,
    declarationEntryPoint: `packages/${name}/dist/index.d.ts`,
    tsconfigPath: `packages/${name}/tsconfig.json`,
    releasedBaselinePath: `architecture/public-api/${name}.json`,
    approvedBreakingChanges: [],
  }));
  const writes = [];
  const item = {
    canonicalReference: "@fixture/api!stable:function(1)",
    kind: "Function",
    parentKind: "EntryPoint",
    signature: "export declare function stable(): void;",
  };

  const promoted = await promotePublicApiBaselines(
    {
      consumerRoot: "/fixture",
      policy: {
        schemaVersion: 1,
        changesetDirectory: ".changeset",
        packages: packagePolicies,
      },
    },
    {
      extractor: {
        async extract(_consumerRoot, packagePolicy, packageVersion) {
          return {
            schemaVersion: 1,
            packageName: packagePolicy.packageName,
            packageVersion,
            extractorVersion: "7.58.12",
            items: [item],
          };
        },
      },
      fingerprint: { sha256: () => "a".repeat(64) },
      repository: {
        async readReleasedBaseline(_consumerRoot, packagePolicy) {
          const alreadyPromoted = packagePolicy.packageName === "@fixture/first";
          return {
            schemaVersion: 1,
            packageName: packagePolicy.packageName,
            packageVersion: alreadyPromoted ? "1.1.0" : "1.0.0",
            extractorVersion: "7.58.12",
            items: alreadyPromoted ? [item] : [],
          };
        },
        async readReleaseEvidence(_consumerRoot, _changesetDirectory, packagePolicy) {
          return { packageName: packagePolicy.packageName, packageVersion: "1.1.0" };
        },
        async writeReleasedBaseline(_consumerRoot, packagePolicy) {
          writes.push(packagePolicy.packageName);
        },
      },
      acceptedDecisionEvidence: {
        async readAcceptedDecisionEvidence() {
          return { acceptedDecisionIds: [], acceptedDecisionPaths: [] };
        },
      },
    },
  );

  assert.deepEqual(writes, ["@fixture/second"]);
  assert.deepEqual(promoted.map(({ packageName }) => packageName), ["@fixture/second"]);
});

test("rejects public API drift after a package version was already promoted", async () => {
  const packagePolicy = {
    packageName: "@fixture/library",
    packageRoot: "packages/library",
    manifestPath: "packages/library/package.json",
    declarationEntryPoint: "packages/library/dist/index.d.ts",
    tsconfigPath: "packages/library/tsconfig.json",
    releasedBaselinePath: "architecture/public-api/library.json",
    approvedBreakingChanges: [],
  };
  const writes = [];

  await assert.rejects(
    promotePublicApiBaselines(
      {
        consumerRoot: "/fixture",
        policy: {
          schemaVersion: 1,
          changesetDirectory: ".changeset",
          packages: [packagePolicy],
        },
      },
      {
        extractor: {
          async extract() {
            return {
              schemaVersion: 1,
              packageName: packagePolicy.packageName,
              packageVersion: "1.1.0",
              extractorVersion: "7.58.12",
              items: [
                {
                  canonicalReference: "@fixture/api!added:function(1)",
                  kind: "Function",
                  parentKind: "EntryPoint",
                  signature: "export declare function added(): void;",
                },
              ],
            };
          },
        },
        fingerprint: { sha256: () => "a".repeat(64) },
        repository: {
          async readReleasedBaseline() {
            return {
              schemaVersion: 1,
              packageName: packagePolicy.packageName,
              packageVersion: "1.1.0",
              extractorVersion: "7.58.12",
              items: [],
            };
          },
          async readReleaseEvidence() {
            return { packageName: packagePolicy.packageName, packageVersion: "1.1.0" };
          },
          async writeReleasedBaseline(...args) {
            writes.push(args);
          },
        },
        acceptedDecisionEvidence: {
          async readAcceptedDecisionEvidence() {
            return { acceptedDecisionIds: [], acceptedDecisionPaths: [] };
          },
        },
      },
    ),
    (error) => error?.problem?.code === "PUBLIC_API_BASELINE_PROMOTION_RELEASE_DRIFT",
  );
  assert.deepEqual(writes, []);
});
