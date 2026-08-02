import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { runFoundationCheck } from "../packages/engineering-foundation/dist/check-runner.js";
import { promotePublicApiBaselines } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/promote-public-api-baselines.js";
import { isExactVersion } from "../packages/engineering-foundation/dist/semantic-version.js";
import { releaseOwnedFileViolations } from "../scripts/check-release-owned-files.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
  "cli.js",
);
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "workspace-dependency-declarations",
  "valid",
);
const sourceFixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "source-dependencies",
  "valid",
);
const suppressionFixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "suppression-governance",
  "valid",
);
const publicApiFixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "public-api-compatibility",
  "valid",
);
const repositorySecurityFixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "repository-security-baseline",
  "valid",
);
const reportSchemaPath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "schemas",
  "foundation-check-report",
  "v1.schema.json",
);

async function withFixture(callback) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "foundation-capability-"));
  try {
    await cp(fixtureRoot, temporaryRoot, { recursive: true });
    return await callback(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function withSourceFixture(callback) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "foundation-source-capability-"));
  try {
    await cp(sourceFixtureRoot, temporaryRoot, { recursive: true });
    return await callback(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function withSuppressionFixture(callback) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "foundation-suppression-"));
  try {
    await cp(suppressionFixtureRoot, temporaryRoot, { recursive: true });
    return await callback(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function withPublicApiFixture(callback) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "foundation-public-api-"));
  try {
    await cp(publicApiFixtureRoot, temporaryRoot, { recursive: true });
    return await callback(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function withRepositorySecurityFixture(callback) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "foundation-repository-security-"));
  try {
    await cp(repositorySecurityFixtureRoot, temporaryRoot, { recursive: true });
    return await callback(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

function utcDateAfter(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function check(consumerRoot, ...args) {
  const result = spawnSync(
    process.execPath,
    [cliPath, "check", ...args, "--consumer", consumerRoot, "--format", "json"],
    { encoding: "utf8" },
  );
  assert.equal(result.stderr, "");
  return { result, report: JSON.parse(result.stdout) };
}

test("accepts only exact SemVer versions", () => {
  assert.equal(isExactVersion("0.3.0"), true);
  assert.equal(isExactVersion("1.0.0-rc.4+build.7"), true);
  assert.equal(isExactVersion("1.0.0-01"), false);
  assert.equal(isExactVersion("1.0.0-."), false);
});

test("allows released baseline mutation only in the Changesets release branch", () => {
  assert.deepEqual(
    releaseOwnedFileViolations(
      [
        { status: "M", path: "architecture/public-api/library.json" },
        { status: "M", path: "architecture/decisions/accepted-decisions.json" },
        { status: "A", path: "architecture/contracts/new-contract.json" },
        { status: "M", path: "packages/library/src/index.ts" },
        { status: "A", path: "architecture/public-api/new-library.json" },
      ],
      "feat/change-api",
      "agent-teams-ai/engineering-foundation",
      "agent-teams-ai/engineering-foundation",
    ),
    [
      "architecture/decisions/accepted-decisions.json",
      "architecture/public-api/library.json",
    ],
  );
  assert.deepEqual(
    releaseOwnedFileViolations(
      [{ status: "M", path: "architecture/public-api/library.json" }],
      "changeset-release/main",
      "agent-teams-ai/engineering-foundation",
      "agent-teams-ai/engineering-foundation",
    ),
    [],
  );
  assert.deepEqual(
    releaseOwnedFileViolations(
      [
        {
          status: "R",
          previousPath: "architecture/public-api/library.json",
          path: "tmp/library.json",
        },
      ],
      "feat/move-baseline",
      "agent-teams-ai/engineering-foundation",
      "agent-teams-ai/engineering-foundation",
    ),
    ["architecture/public-api/library.json"],
  );
  assert.deepEqual(
    releaseOwnedFileViolations(
      [{ status: "M", path: "architecture/public-api/library.json" }],
      "changeset-release/main",
      "attacker/engineering-foundation",
      "agent-teams-ai/engineering-foundation",
    ),
    ["architecture/public-api/library.json"],
  );
});

test("passes a materialized pnpm workspace and emits the canonical report", async () => {
  await withFixture(async (consumerRoot) => {
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0);
    assert.equal(report.outcome, "passed");
    assert.deepEqual(report.summary, { errors: 0, warnings: 0, infos: 0 });
    assert.equal(report.capabilities.length, 1);

    const schema = JSON.parse(await readFile(reportSchemaPath, "utf8"));
    const validate = new Ajv2020({ strict: true }).compile(schema);
    assert.equal(validate(report), true, JSON.stringify(validate.errors));
  });
});

test("accepts an explicitly allowed source architecture graph", async () => {
  await withSourceFixture(async (consumerRoot) => {
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0);
    assert.equal(report.outcome, "passed");
    assert.deepEqual(
      report.capabilities.map((capability) => capability.capabilityId),
      ["architecture.source-dependencies"],
    );
  });
});

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

test("accepts a closed-world repository security baseline", async () => {
  await withRepositorySecurityFixture(async (consumerRoot) => {
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0);
    assert.equal(report.outcome, "passed");
  });
});

test("reports deterministic workflow and package supply-chain violations", async () => {
  await withRepositorySecurityFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, ".github", "workflows", "ci.yml"),
      [
        "name: Unsafe CI",
        "on:",
        "  pull_request_target:",
        "permissions: write-all",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-24.04",
        "    steps:",
        "      - uses: actions/checkout@v7",
        "      - uses: ./../outside-action",
        `      - run: echo "\${{ github['event'].pull_request.title }}"`,
        "",
      ].join("\n"),
      "utf8",
    );
    const manifestPath = join(consumerRoot, "packages", "library", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files = [".", "src", "*", "dist/..", "dist\\private"];
    manifest.publishConfig.provenance = false;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      new Set(report.capabilities[0].diagnostics.map(({ ruleId }) => ruleId)),
      new Set([
        "repository.security-baseline.action-not-pinned",
        "repository.security-baseline.dangerous-trigger",
        "repository.security-baseline.event-interpolation-in-run",
        "repository.security-baseline.package-files-unsafe",
        "repository.security-baseline.package-provenance-missing",
        "repository.security-baseline.permissions-invalid",
        "repository.security-baseline.privileged-job-mismatch",
        "repository.security-baseline.sbom-missing",
      ]),
    );
    const filesDiagnostic = report.capabilities[0].diagnostics.find(
      ({ ruleId }) => ruleId === "repository.security-baseline.package-files-unsafe",
    );
    assert.deepEqual(
      filesDiagnostic.evidence.map(({ value }) => value),
      [".", "src", "*", "dist/..", "dist\\private"],
    );
  });
});

test("rejects stale privilege declarations and a missing dependency review action", async () => {
  await withRepositorySecurityFixture(async (consumerRoot) => {
    const configPath = join(
      consumerRoot,
      "architecture",
      "foundation",
      "repository-security-baseline.yaml",
    );
    const config = parseYaml(await readFile(configPath, "utf8"));
    config.privilegedJobs = [
      {
        workflowPath: ".github/workflows/ci.yml",
        jobId: "missing-release",
        permissions: { contents: "write" },
      },
    ];
    await writeFile(configPath, stringifyYaml(config, { lineWidth: 0 }), "utf8");
    await writeFile(
      join(consumerRoot, ".github", "workflows", "dependency-review.yml"),
      "name: Dependency Review\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  dependency-review:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@1111111111111111111111111111111111111111\n",
      "utf8",
    );
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      new Set(report.capabilities[0].diagnostics.map(({ ruleId }) => ruleId)),
      new Set([
        "repository.security-baseline.dependency-review-missing",
        "repository.security-baseline.stale-privileged-job",
      ]),
    );
  });
});

test("requires dependency and SBOM evidence on every pull request", async () => {
  await withRepositorySecurityFixture(async (consumerRoot) => {
    const dependencyReviewPath = join(
      consumerRoot,
      ".github",
      "workflows",
      "dependency-review.yml",
    );
    const dependencyReview = parseYaml(await readFile(dependencyReviewPath, "utf8"));
    dependencyReview.jobs["dependency-review"].if = false;
    await writeFile(
      dependencyReviewPath,
      stringifyYaml(dependencyReview, { lineWidth: 0 }),
      "utf8",
    );

    const ciPath = join(consumerRoot, ".github", "workflows", "ci.yml");
    const ci = parseYaml(await readFile(ciPath, "utf8"));
    ci.on.pull_request = { paths: ["packages/**"] };
    await writeFile(ciPath, stringifyYaml(ci, { lineWidth: 0 }), "utf8");

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      new Set(report.capabilities[0].diagnostics.map(({ ruleId }) => ruleId)),
      new Set([
        "repository.security-baseline.dependency-review-missing",
        "repository.security-baseline.sbom-missing",
      ]),
    );
  });
});

test("rejects advisory dependency review and partial SBOM evidence", async () => {
  await withRepositorySecurityFixture(async (consumerRoot) => {
    const dependencyReviewPath = join(
      consumerRoot,
      ".github",
      "workflows",
      "dependency-review.yml",
    );
    const dependencyReview = parseYaml(await readFile(dependencyReviewPath, "utf8"));
    dependencyReview.jobs["dependency-review"].steps[0].with = { "warn-only": true };
    await writeFile(
      dependencyReviewPath,
      stringifyYaml(dependencyReview, { lineWidth: 0 }),
      "utf8",
    );

    const ciPath = join(consumerRoot, ".github", "workflows", "ci.yml");
    const ci = parseYaml(await readFile(ciPath, "utf8"));
    ci.jobs.check.steps[1].with = { path: "packages/library/package.json" };
    await writeFile(ciPath, stringifyYaml(ci, { lineWidth: 0 }), "utf8");

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      new Set(report.capabilities[0].diagnostics.map(({ ruleId }) => ruleId)),
      new Set([
        "repository.security-baseline.dependency-review-missing",
        "repository.security-baseline.sbom-missing",
      ]),
    );
  });
});

test("rejects workflow evidence that traverses a symbolic link", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withRepositorySecurityFixture(async (consumerRoot) => {
    const workflowPath = join(consumerRoot, ".github", "workflows", "ci.yml");
    const realPath = join(consumerRoot, ".github", "ci.real.yml");
    await rename(workflowPath, realPath);
    await symlink(realPath, workflowPath);
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(
      report.capabilities[0].problem.code,
      "REPOSITORY_SECURITY_WORKFLOW_ENTRY_INVALID",
    );
  });
});

test("accepts governed source without suppression directives", async () => {
  await withSuppressionFixture(async (consumerRoot) => {
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0);
    assert.deepEqual(
      report.capabilities.map((capability) => capability.capabilityId),
      ["quality.suppression-governance"],
    );
  });
});

test("accepts one exact accountable suppression waiver", async () => {
  await withSuppressionFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "src", "index.ts"),
      "// oxlint-disable-next-line no-console\nconsole.log('fixture');\n",
      "utf8",
    );
    const configPath = join(
      consumerRoot,
      "architecture",
      "foundation",
      "suppression-governance.yaml",
    );
    const config = parseYaml(await readFile(configPath, "utf8"));
    config.waivers = [
      {
        id: "FIXTURE-WAIVER-1",
        path: "src/index.ts",
        line: 1,
        directive: "oxlint-disable-next-line",
        rules: ["no-console"],
        owner: "fixture-owner",
        reason: "Temporary fixture proves exact waiver matching.",
        createdOn: utcDateAfter(0),
        expiresOn: utcDateAfter(30),
        decisionRef: "ADR-TEST-0001",
      },
    ];
    await writeFile(configPath, stringifyYaml(config, { lineWidth: 0 }), "utf8");

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0);
    assert.equal(report.outcome, "passed");
  });
});

test("rejects unregistered and non-waivable suppression directives", async () => {
  await withSuppressionFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "src", "index.ts"),
      [
        "// oxlint-disable-next-line no-console",
        "console.log('fixture');",
        "// @ts-ignore",
        "unknownCall();",
        "// eslint-disable-next-line no-alert",
        "alert('fixture');",
        "// oxlint-disable-next-line security.no-secret-output",
        "export const exposed = true;",
        "// ast-grep-ignore",
        "export const broad = true;",
        "",
      ].join("\n"),
      "utf8",
    );
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      new Set(report.capabilities[0].diagnostics.map((entry) => entry.ruleId)),
      new Set([
        "quality.suppression-governance.legacy-suppression",
        "quality.suppression-governance.prohibited-typescript-suppression",
        "quality.suppression-governance.protected-rule-suppression",
        "quality.suppression-governance.unregistered-suppression",
        "quality.suppression-governance.unscoped-suppression",
      ]),
    );
  });
});

test("rejects stale, mismatched, expired, and excessive waivers", async () => {
  await withSuppressionFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "src", "index.ts"),
      "// oxlint-disable-next-line no-console\nconsole.log('fixture');\n",
      "utf8",
    );
    const configPath = join(
      consumerRoot,
      "architecture",
      "foundation",
      "suppression-governance.yaml",
    );
    const config = parseYaml(await readFile(configPath, "utf8"));
    config.waivers = [
      {
        id: "FIXTURE-MISMATCH-1",
        path: "src/index.ts",
        line: 1,
        directive: "oxlint-disable-next-line",
        rules: ["no-alert"],
        owner: "fixture-owner",
        reason: "Fixture intentionally mismatches the suppression rule.",
        createdOn: utcDateAfter(-120),
        expiresOn: utcDateAfter(-1),
        decisionRef: "ADR-TEST-0002",
      },
      {
        id: "FIXTURE-STALE-1",
        path: "src/index.ts",
        line: 2,
        directive: "typescript-expect-error",
        rules: ["typescript/type-error"],
        owner: "fixture-owner",
        reason: "Fixture intentionally leaves this waiver without source.",
        createdOn: utcDateAfter(-1),
        expiresOn: utcDateAfter(30),
        decisionRef: "ADR-TEST-0003",
      },
    ];
    await writeFile(configPath, stringifyYaml(config, { lineWidth: 0 }), "utf8");

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      new Set(report.capabilities[0].diagnostics.map((entry) => entry.ruleId)),
      new Set([
        "quality.suppression-governance.stale-waiver",
        "quality.suppression-governance.waiver-mismatch",
      ]),
    );
  });
});

test("rejects expired and overlong exact waivers", async () => {
  await withSuppressionFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "src", "index.ts"),
      "// oxlint-disable-next-line no-console\nconsole.log('fixture');\n",
      "utf8",
    );
    const configPath = join(
      consumerRoot,
      "architecture",
      "foundation",
      "suppression-governance.yaml",
    );
    const config = parseYaml(await readFile(configPath, "utf8"));
    config.waivers = [
      {
        id: "FIXTURE-EXPIRED-1",
        path: "src/index.ts",
        line: 1,
        directive: "oxlint-disable-next-line",
        rules: ["no-console"],
        owner: "fixture-owner",
        reason: "Fixture intentionally proves expiry and lifetime limits.",
        createdOn: utcDateAfter(-120),
        expiresOn: utcDateAfter(-1),
        decisionRef: "ADR-TEST-0004",
      },
    ];
    await writeFile(configPath, stringifyYaml(config, { lineWidth: 0 }), "utf8");

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      new Set(report.capabilities[0].diagnostics.map((entry) => entry.ruleId)),
      new Set([
        "quality.suppression-governance.excessive-waiver-lifetime",
        "quality.suppression-governance.expired-waiver",
      ]),
    );
  });
});

test("reports deterministic source boundary and resolution violations", async () => {
  await withSourceFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "packages", "app", "src", "domain", "broken.ts"),
      `// Unicode evidence before imports: agent-\u{1F916}\nimport { createAdapter } from "../infrastructure/adapter.js";\nimport { value } from "../../../core/src/domain/value.js";\nimport "@fixture/core/blocked";\nimport leftPad from "left-pad";\ndeclare const target: string;\nvoid import(target);\nvoid createAdapter;\nvoid value;\nvoid leftPad;\n`,
      "utf8",
    );
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    const ruleIds = report.capabilities[0].diagnostics.map(
      (diagnostic) => diagnostic.ruleId,
    );
    assert.deepEqual(ruleIds, ruleIds.toSorted());
    assert.deepEqual(
      new Set(ruleIds),
      new Set([
        "architecture.source-dependencies.cross-package-relative-import",
        "architecture.source-dependencies.forbidden-boundary-dependency",
        "architecture.source-dependencies.forbidden-package-dependency",
        "architecture.source-dependencies.package-subpath-not-exported",
        "architecture.source-dependencies.undeclared-external-dependency",
        "architecture.source-dependencies.unresolved-runtime-reference",
      ]),
    );
    assert.equal(JSON.stringify(report).includes(consumerRoot), false);
  });
});

test("discards partial dependency evidence when governed source is malformed", async () => {
  await withSourceFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "packages", "app", "src", "domain", "malformed.ts"),
      `import "@fixture/core/blocked";\nimport { broken from "left-pad";\n`,
      "utf8",
    );
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    const malformedDiagnostics = report.capabilities[0].diagnostics.filter(
      (diagnostic) => diagnostic.location.path.endsWith("malformed.ts"),
    );
    assert.deepEqual(
      malformedDiagnostics.map((diagnostic) => diagnostic.ruleId),
      ["architecture.source-dependencies.source-parse-error"],
    );
  });
});

test("fails closed when AI-created source is outside every declared boundary", async () => {
  await withSourceFixture(async (consumerRoot) => {
    const configPath = join(
      consumerRoot,
      "architecture",
      "foundation",
      "source-dependencies.yaml",
    );
    const config = parseYaml(await readFile(configPath, "utf8"));
    const surfaceBoundary = config.boundaries.find(
      (boundary) => boundary.id === "app.surface",
    );
    assert.notEqual(surfaceBoundary, undefined);
    surfaceBoundary.roots = ["packages/app/src/index.ts"];
    await writeFile(
      configPath,
      stringifyYaml(config, { lineWidth: 0 }),
      "utf8",
    );
    await writeFile(
      join(consumerRoot, "packages", "app", "src", "orphan.ts"),
      "export const orphan = true;\n",
      "utf8",
    );
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.equal(
      report.capabilities[0].diagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId ===
            "architecture.source-dependencies.unclassified-source-file" &&
          diagnostic.location.path.endsWith("orphan.ts"),
      ),
      true,
    );
  });
});

test("treats an explicit empty package export map as blocking every subpath", async () => {
  await withSourceFixture(async (consumerRoot) => {
    const manifestPath = join(consumerRoot, "packages", "core", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.exports = {};
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.equal(
      report.capabilities[0].diagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId ===
          "architecture.source-dependencies.package-subpath-not-exported",
      ),
      true,
    );
  });
});

test("rejects source symlinks before parsing", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withSourceFixture(async (consumerRoot) => {
    await symlink(
      join(consumerRoot, "packages", "core", "src", "index.ts"),
      join(consumerRoot, "packages", "app", "src", "domain", "linked.ts"),
    );
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(
      report.capabilities[0].problem.code,
      "SOURCE_SYMLINK_PROHIBITED",
    );
  });
});

test("rejects governed roots and manifests that traverse symlinks", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withSourceFixture(async (consumerRoot) => {
    const packageRoot = join(consumerRoot, "packages", "app");
    await rename(join(packageRoot, "src"), join(packageRoot, "source-real"));
    await symlink(join(packageRoot, "source-real"), join(packageRoot, "src"));
    const sourceResult = check(consumerRoot);
    assert.equal(sourceResult.result.status, 2);
    assert.equal(
      sourceResult.report.capabilities[0].problem.code,
      "SOURCE_SYMLINK_PROHIBITED",
    );
  });

  await withSourceFixture(async (consumerRoot) => {
    const manifestPath = join(consumerRoot, "packages", "core", "package.json");
    const targetPath = join(consumerRoot, "packages", "core", "package.real.json");
    await rename(manifestPath, targetPath);
    await symlink(targetPath, manifestPath);
    const manifestResult = check(consumerRoot);
    assert.equal(manifestResult.result.status, 2);
    assert.equal(
      manifestResult.report.capabilities[0].problem.code,
      "PACKAGE_MANIFEST_SYMLINK_PROHIBITED",
    );
  });
});

test("rejects case-folding collisions on case-sensitive filesystems", async () => {
  await withSourceFixture(async (consumerRoot) => {
    const domainRoot = join(consumerRoot, "packages", "app", "src", "domain");
    await writeFile(join(domainRoot, "Collision.ts"), "export const upper = 1;\n");
    await writeFile(join(domainRoot, "collision.ts"), "export const lower = 2;\n");
    const entries = await readdir(domainRoot);
    if (!entries.includes("Collision.ts") || !entries.includes("collision.ts")) {
      return;
    }
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(
      report.capabilities[0].problem.code,
      "SOURCE_PATH_CASE_COLLISION",
    );
  });
});

test("supports a root-only pnpm workspace", async () => {
  await withFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "pnpm-workspace.yaml"),
      `catalogMode: strict\ncatalog:\n  ajv: 8.20.0\n  oxlint: 1.76.0\n  typescript: 7.0.2\n`,
      "utf8",
    );
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0);
    assert.equal(report.outcome, "passed");
  });
});

test("collects deterministic dependency policy violations", async () => {
  await withFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "pnpm-workspace.yaml"),
      `packages:\n  - "packages/*"\ncatalogMode: manual\ncatalog:\n  ajv: ^8.20.0\n  oxlint: 1.76.0\n  typescript: 7.0.2\n`,
      "utf8",
    );
    await writeFile(
      join(consumerRoot, "packages", "app", "package.json"),
      `${JSON.stringify(
        {
          name: "@fixture/app",
          version: "0.0.0",
          dependencies: {
            "@fixture/core": "1.0.0",
            "@fixture/missing": "catalog:",
            ajv: "^8.20.0",
          },
          devDependencies: {
            ajv: "catalog:",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.equal(report.outcome, "violations");
    const ruleIds = report.capabilities[0].diagnostics.map(
      (diagnostic) => diagnostic.ruleId,
    );
    assert.deepEqual(ruleIds, ruleIds.toSorted());
    assert.deepEqual(
      new Set(ruleIds),
      new Set([
        "workspace.dependency-declarations.catalog-mode-not-strict",
        "workspace.dependency-declarations.catalog-version-not-exact",
        "workspace.dependency-declarations.dependency-declared-multiple-times",
        "workspace.dependency-declarations.external-version-not-cataloged",
        "workspace.dependency-declarations.internal-dependency-without-workspace-protocol",
        "workspace.dependency-declarations.reserved-scope-package-not-in-workspace",
      ]),
    );
    assert.equal(JSON.stringify(report).includes(consumerRoot), false);
  });
});

test("enforces development-only package placement, exactness, and bundling", async () => {
  await withFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "packages", "app", "package.json"),
      `${JSON.stringify(
        {
          name: "@fixture/app",
          version: "0.0.0",
          dependencies: {
            "@agent-teams/engineering-foundation": "^0.1.1",
          },
          bundledDependencies: ["@agent-teams/engineering-foundation"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      report.capabilities[0].diagnostics.map((diagnostic) => diagnostic.ruleId),
      [
        "workspace.dependency-declarations.development-only-package-bundled",
        "workspace.dependency-declarations.development-only-package-in-runtime-section",
        "workspace.dependency-declarations.exact-registry-development-only-package-version-not-exact",
      ],
    );
  });
});

test("rejects unsupported YAML features and invalid capability selection", async () => {
  await withFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "foundation.config.yaml"),
      `schemaVersion: 1\nproject: &project\n  id: fixture\ncapabilities:\n  workspace.dependency-declarations:\n    configPath: architecture/foundation/dependency-declarations.yaml\ncopy: *project\n`,
      "utf8",
    );
    const invalidYaml = check(consumerRoot);
    assert.equal(invalidYaml.result.status, 2);
    assert.equal(invalidYaml.report.outcome, "invalid-input");
    assert.equal(invalidYaml.report.problem.code, "YAML_FEATURE_PROHIBITED");
  });

  await withFixture(async (consumerRoot) => {
    const selection = check(consumerRoot, "architecture.source-dependencies");
    assert.equal(selection.result.status, 2);
    assert.equal(selection.report.problem.code, "CAPABILITY_NOT_DECLARED");
  });
});

test("rejects duplicate YAML keys and configuration symlink escapes", async () => {
  await withFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "foundation.config.yaml"),
      `schemaVersion: 1\nschemaVersion: 1\nproject:\n  id: fixture\ncapabilities:\n  workspace.dependency-declarations:\n    configPath: architecture/foundation/dependency-declarations.yaml\n`,
      "utf8",
    );
    const duplicate = check(consumerRoot);
    assert.equal(duplicate.result.status, 2);
    assert.equal(duplicate.report.problem.code, "YAML_INVALID");
  });

  if (process.platform !== "win32") {
    await withFixture(async (consumerRoot) => {
      const outsideRoot = await mkdtemp(join(tmpdir(), "foundation-outside-"));
      try {
        const outsideConfig = join(outsideRoot, "outside.yaml");
        await writeFile(
          outsideConfig,
          `schemaVersion: 1\nproject:\n  id: fixture\ncapabilities: {}\n`,
          "utf8",
        );
        await rm(join(consumerRoot, "foundation.config.yaml"));
        await symlink(outsideConfig, join(consumerRoot, "foundation.config.yaml"));
        const escaped = check(consumerRoot);
        assert.equal(escaped.result.status, 2);
        assert.equal(escaped.report.problem.code, "CONFIG_PATH_ESCAPE");
      } finally {
        await rm(outsideRoot, { force: true, recursive: true });
      }
    });
  }
});

test("returns the stable cancellation outcome without reading consumer input", async () => {
  const controller = new AbortController();
  controller.abort();
  const report = await runFoundationCheck({
    consumerRoot: "/consumer-path-must-not-be-read",
    foundationVersion: "0.2.0",
    signal: controller.signal,
  });
  assert.equal(report.outcome, "cancelled");
  assert.equal(report.problem.code, "EXECUTION_CANCELLED");
});

test("classifies an unavailable consumer root as invalid input", () => {
  const { result, report } = check(
    join(tmpdir(), "foundation-consumer-that-does-not-exist"),
  );
  assert.equal(result.status, 2);
  assert.equal(report.outcome, "invalid-input");
  assert.equal(report.problem.code, "CONSUMER_ROOT_UNAVAILABLE");
});

test("exposes immutable schemas and rule explanations through the CLI", () => {
  const schema = spawnSync(
    process.execPath,
    [cliPath, "schema", "foundation-config/v1"],
    { encoding: "utf8" },
  );
  assert.equal(schema.status, 0);
  assert.equal(JSON.parse(schema.stdout).$schema, "https://json-schema.org/draft/2020-12/schema");

  const explanation = spawnSync(
    process.execPath,
    [
      cliPath,
      "explain",
      "workspace.dependency-declarations.external-version-not-cataloged",
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(explanation.status, 0);
  assert.equal(
    JSON.parse(explanation.stdout).id,
    "workspace.dependency-declarations.external-version-not-cataloged",
  );
});
