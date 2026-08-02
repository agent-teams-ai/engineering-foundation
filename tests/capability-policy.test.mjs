import assert from "node:assert/strict";
import {
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  check,
  utcDateAfter,
  withRepositorySecurityFixture,
  withSuppressionFixture
} from "./support/capability-fixtures.mjs";

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
