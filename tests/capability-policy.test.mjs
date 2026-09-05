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

test("fails closed when the repository workflow allowlist is removed", async () => {
  await withRepositorySecurityFixture(async (consumerRoot) => {
    const configPath = join(
      consumerRoot,
      "architecture",
      "foundation",
      "repository-security-baseline.yaml",
    );
    const config = parseYaml(await readFile(configPath, "utf8"));
    delete config.allowedUses;
    await writeFile(configPath, stringifyYaml(config, { lineWidth: 0 }), "utf8");

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(report.capabilities[0].problem.code, "SCHEMA_INVALID");
  });
});

test("fails closed when the repository container-image allowlist is removed", async () => {
  await withRepositorySecurityFixture(async (consumerRoot) => {
    const configPath = join(
      consumerRoot,
      "architecture",
      "foundation",
      "repository-security-baseline.yaml",
    );
    const config = parseYaml(await readFile(configPath, "utf8"));
    delete config.allowedContainerImages;
    await writeFile(configPath, stringifyYaml(config, { lineWidth: 0 }), "utf8");

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(report.capabilities[0].problem.code, "SCHEMA_INVALID");
  });
});

test("binds Dependency Review to the declared job and exact comparison refs", async () => {
  await withRepositorySecurityFixture(async (consumerRoot) => {
    const dependencyReviewPath = join(
      consumerRoot,
      ".github",
      "workflows",
      "ci.yml",
    );
    const dependencyReview = parseYaml(await readFile(dependencyReviewPath, "utf8"));
    const step = dependencyReview.jobs["dependency-review"].steps[0];
    step.with["head-ref"] = step.with["base-ref"];
    await writeFile(
      dependencyReviewPath,
      stringifyYaml(dependencyReview, { lineWidth: 0 }),
      "utf8",
    );

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      report.capabilities[0].diagnostics.map(({ ruleId }) => ruleId),
      ["repository.security-baseline.dependency-review-missing"],
    );
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
        "repository.security-baseline.dependency-review-missing",
        "repository.security-baseline.event-interpolation-in-run",
        "repository.security-baseline.package-files-unsafe",
        "repository.security-baseline.package-provenance-missing",
        "repository.security-baseline.permissions-invalid",
        "repository.security-baseline.privileged-job-mismatch",
        "repository.security-baseline.sbom-missing",
        "repository.security-baseline.stale-allowed-use",
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
    const workflowPath = join(consumerRoot, ".github", "workflows", "ci.yml");
    const workflow = parseYaml(await readFile(workflowPath, "utf8"));
    workflow.jobs["dependency-review"].steps = [
      { uses: "actions/checkout@1111111111111111111111111111111111111111" },
    ];
    await writeFile(workflowPath, stringifyYaml(workflow, { lineWidth: 0 }), "utf8");
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      new Set(report.capabilities[0].diagnostics.map(({ ruleId }) => ruleId)),
      new Set([
        "repository.security-baseline.dependency-review-missing",
        "repository.security-baseline.stale-allowed-use",
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
      "ci.yml",
    );
    const dependencyReview = parseYaml(await readFile(dependencyReviewPath, "utf8"));
    dependencyReview.jobs["dependency-review"].if = false;
    await writeFile(
      dependencyReviewPath,
      stringifyYaml(dependencyReview, { lineWidth: 0 }),
      "utf8",
    );

    dependencyReview.on.pull_request = { paths: ["packages/**"] };
    await writeFile(
      dependencyReviewPath,
      stringifyYaml(dependencyReview, { lineWidth: 0 }),
      "utf8",
    );

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
      "ci.yml",
    );
    const dependencyReview = parseYaml(await readFile(dependencyReviewPath, "utf8"));
    dependencyReview.jobs["dependency-review"].steps[0].with = { "warn-only": true };
    await writeFile(
      dependencyReviewPath,
      stringifyYaml(dependencyReview, { lineWidth: 0 }),
      "utf8",
    );

    dependencyReview.jobs.check.steps[1].with = { path: "packages/library/package.json" };
    await writeFile(
      dependencyReviewPath,
      stringifyYaml(dependencyReview, { lineWidth: 0 }),
      "utf8",
    );

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

test("foundation-check pure mapping preserves ordered settings and mapping diagnostics", async () => {
  const { mapFoundationConfig } = await import("../packages/engineering-foundation/dist/features/foundation-check/application/map-foundation-config.js");
  const supported = new Set(["z.check", "a.check"]);
  const input = { project: { id: "fixture" }, capabilities: {
    "z.check": { configPath: "z.yaml" }, "a.check": { configPath: "a.yaml" },
  }};
  const settings = mapFoundationConfig(input, supported);
  assert.deepEqual(settings, { projectId: "fixture", declaredCapabilities: [
    { id: "a.check", configPath: "a.yaml" }, { id: "z.check", configPath: "z.yaml" },
  ] });
  assert.equal(Object.isFrozen(settings), true);
  assert.equal(Object.isFrozen(settings.declaredCapabilities), true);
  assert.deepEqual(Object.keys(input.capabilities), ["z.check", "a.check"]);
  for (const [value, message] of [
    [null, "foundation config must be an object."],
    [{ project: false }, "project must be an object."],
    [{ project: {}, capabilities: [] }, "capabilities must be an object."],
    [{ project: {}, capabilities: { "x.check": {} } }, "Unsupported capability declaration: x.check."],
    [{ project: {}, capabilities: { "a.check": [] } }, "capabilities.a.check must be an object."],
    [{ project: {}, capabilities: { "a.check": { configPath: 1 } } }, "capabilities.a.check.configPath must be a string."],
    [{ project: {}, capabilities: {} }, "project.id must be a string."],
  ]) {
    assert.throws(() => mapFoundationConfig(value, supported), (error) => {
      assert.deepEqual(error.problem, { code: "FOUNDATION_CONFIG_INVALID", message, phase: "foundation-config", retryable: false });
      return true;
    });
  }
});

test("foundation-check runs injected independent capabilities concurrently and orders their reports", async () => {
  const { createFoundationCheck } = await import("../packages/engineering-foundation/dist/features/foundation-check/api.js");
  const { capabilityReport } = await import("../packages/engineering-foundation/dist/features/validation-reporting/api.js");
  const started = [];
  const releases = new Map();
  const controller = new AbortController();
  const read = Promise.withResolvers();
  const runner = createFoundationCheck({
    readConfig: (root, signal) => {
      assert.equal(root, "no-filesystem-authority");
      assert.equal(signal, controller.signal);
      return read.promise;
    },
    capabilities: new Map(["z.check", "a.check"].map((id) => [id, {
      id, configSchemaVersion: 1,
      run: (input) => {
        assert.deepEqual(input, { consumerRoot: "no-filesystem-authority", configPath: `${id}.yaml`, signal: controller.signal });
        started.push(id);
        const deferred = Promise.withResolvers();
        releases.set(id, () => deferred.resolve(capabilityReport({ capabilityId: id, capabilityConfigSchemaVersion: 1 })));
        return deferred.promise;
      },
    }])),
  });
  const result = runner({ consumerRoot: "no-filesystem-authority", foundationVersion: "1.2.3", signal: controller.signal });
  assert.deepEqual(started, []);
  read.resolve({ projectId: "fixture", declaredCapabilities: ["z.check", "a.check"].map(id => ({ id, configPath: `${id}.yaml` })) });
  await Promise.resolve();
  assert.deepEqual(started, ["z.check", "a.check"]);
  releases.get("a.check")();
  releases.get("z.check")();
  const report = await result;
  assert.equal(report.outcome, "passed");
  assert.equal(report.coverage, "full");
  assert.equal(report.foundationVersion, "1.2.3");
  assert.deepEqual(report.capabilities.map(({ capabilityId }) => capabilityId), ["a.check", "z.check"]);
});

test("foundation-check preserves full versus selected scope and every aggregate outcome", async () => {
  const { createFoundationCheck } = await import("../packages/engineering-foundation/dist/features/foundation-check/api.js");
  const { capabilityReport, exitCodeForOutcome } = await import("../packages/engineering-foundation/dist/features/validation-reporting/api.js");
  const outcomes = ["passed", "violations", "invalid-input", "failed", "cancelled"];
  const exits = [0, 1, 2, 3, 130];
  for (const [index, outcome] of outcomes.entries()) {
    const calls = [];
    const runner = createFoundationCheck({
      readConfig: async () => ({ projectId: "fixture", declaredCapabilities: ["a.check", "b.check"].map(id => ({ id, configPath: `${id}.yaml` })) }),
      capabilities: new Map(["a.check", "b.check"].map(id => [id, { id, configSchemaVersion: 1, run: async () => {
        calls.push(id);
        return capabilityReport({ capabilityId: id, capabilityConfigSchemaVersion: 1, outcome: id === "a.check" ? outcome : "passed" });
      } }])),
    });
    const input = { consumerRoot: "inert", foundationVersion: "1.2.3" };
    const full = await runner(input);
    assert.equal(full.outcome, outcome);
    assert.equal(full.coverage, "full");
    assert.equal(exitCodeForOutcome(full.outcome), exits[index]);
    assert.deepEqual(calls, ["a.check", "b.check"]);
    calls.length = 0;
    const selected = await runner({ ...input, capabilityId: "b.check" });
    assert.equal(selected.outcome, "passed");
    assert.equal(selected.coverage, "selected");
    assert.deepEqual(calls, ["b.check"]);
    calls.length = 0;
    const missing = await runner({ ...input, capabilityId: "missing.check" });
    assert.equal(missing.coverage, "selected");
    assert.equal(missing.problem.code, "CAPABILITY_NOT_DECLARED");
    assert.deepEqual(calls, []);
  }
});

test("foundation-check injected input failures retain cancellation and sanitized root failures", async () => {
  const { createFoundationCheck } = await import("../packages/engineering-foundation/dist/features/foundation-check/api.js");
  const { CapabilityInputError } = await import("../packages/engineering-foundation/dist/features/validation-reporting/api.js");
  const input = { consumerRoot: "inert", foundationVersion: "1.2.3", capabilityId: "a.check" };
  for (const [error, outcome, code] of [
    [new CapabilityInputError({ code: "EXECUTION_CANCELLED", message: "Cancelled.", phase: "fixture", retryable: false }), "cancelled", "EXECUTION_CANCELLED"],
    [Object.assign(new Error("private"), { name: "ProcessCancellationError" }), "cancelled", "EXECUTION_CANCELLED"],
    [new TypeError("private"), "failed", "UNEXPECTED_CONTRACT_FAILURE"],
    [new CapabilityInputError({ code: "CONFIG_FILE_UNAVAILABLE", message: "Missing.", phase: "foundation-config", retryable: false }), "invalid-input", "CONFIG_FILE_UNAVAILABLE"],
  ]) {
    const report = await createFoundationCheck({ readConfig: async () => { throw error; }, capabilities: new Map() })(input);
    assert.equal(report.coverage, "selected");
    assert.equal(report.outcome, outcome);
    assert.equal(report.problem.code, code);
    assert.deepEqual(report.capabilities, []);
    assert.equal(JSON.stringify(report).includes("private"), false);
  }
  const unsupported = await createFoundationCheck({
    readConfig: async () => ({ projectId: "fixture", declaredCapabilities: [{ id: "a.check", configPath: "a.yaml" }] }),
    capabilities: new Map(),
  })(input);
  assert.equal(unsupported.problem.code, "CAPABILITY_UNSUPPORTED");
});
