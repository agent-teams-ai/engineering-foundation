import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { promotePublicApiBaselines } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/promote-public-api-baselines.js";
import {
  check,
  cliPath,
  withPublicApiFixture
} from "./support/capability-fixtures.mjs";

test("accepts a public API identical to its released baseline", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0);
    assert.equal(report.outcome, "passed");
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

test("binds a breaking public API approval to its exact fingerprint and accepted ADR", async () => {
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
    config.packages[0].approvedBreakingChanges = [
      {
        fingerprint,
        decisionPath: "docs/decisions/ADR-0001-api-break.md",
      },
    ];
    await writeFile(configPath, stringifyYaml(config, { lineWidth: 0 }), "utf8");
    await mkdir(join(consumerRoot, "docs", "decisions"), { recursive: true });
    await writeFile(
      join(consumerRoot, "docs", "decisions", "ADR-0001-api-break.md"),
      "# ADR-0001: API break\n\nStatus: Accepted\n\n## Context\nApproved fixture.\n",
      "utf8",
    );
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
      await readFile(join(consumerRoot, "architecture", "public-api", "library.json"), "utf8"),
    );
    assert.equal(baseline.packageVersion, "1.3.0");
    assert.equal(check(consumerRoot).result.status, 0);
  });
});

test("promotes namespace exports with a deterministic non-empty signature", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const declarationsRoot = join(consumerRoot, "packages", "library", "dist");
    await writeFile(
      join(declarationsRoot, "index.d.ts"),
      'export * as tools from "./tools.js";\nexport declare function stable(value: string): string;\n',
      "utf8",
    );
    await writeFile(
      join(declarationsRoot, "tools.d.ts"),
      "export declare function inspect(): void;\n",
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
      await readFile(join(consumerRoot, "architecture", "public-api", "library.json"), "utf8"),
    );
    const namespace = baseline.items.find(({ kind }) => kind === "Namespace");
    assert.equal(namespace.signature, "namespace tools");
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
          async isAcceptedDecision() {
            return false;
          },
          async writeReleasedBaseline(...args) {
            writes.push(args);
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
        async isAcceptedDecision() {
          return false;
        },
        async writeReleasedBaseline(_consumerRoot, packagePolicy) {
          writes.push(packagePolicy.packageName);
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
          async isAcceptedDecision() {
            return false;
          },
          async writeReleasedBaseline(...args) {
            writes.push(args);
          },
        },
      },
    ),
    (error) => error?.problem?.code === "PUBLIC_API_BASELINE_PROMOTION_RELEASE_DRIFT",
  );
  assert.deepEqual(writes, []);
});
