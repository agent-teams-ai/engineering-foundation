import assert from "node:assert/strict";
import {
  readFile,
  mkdir,
  mkdtemp,
  rm,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  check,
  utcDateAfter,
  withRepositorySecurityFixture,
  withSuppressionFixture
} from "./support/capability-fixtures.mjs";

import { createFoundationConfigReader } from "../packages/engineering-foundation/dist/features/foundation-check/module.js";
import { createStrictYamlFileLoader, createPackagedSchemaReader, createSchemaCatalog } from "../packages/engineering-foundation/dist/features/configuration-input/module.js";
import { parseStrictYamlSource } from "../packages/engineering-foundation/dist/features/configuration-input/yaml.js";
import { ContainedFileReadError, readContainedRegularFile } from "../packages/engineering-foundation/dist/source-inventory/node.js";
import { FOUNDATION_SCHEMA_IDS } from "../packages/engineering-foundation/dist/schema-ids.js";
import { readFoundationSchema, assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";

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

test("configuration observation retains failure and cancellation precedence through its byte port", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-config-port-"));
  try {
    const observed = [];
    const load = createStrictYamlFileLoader({
      async read(input) {
        observed.push(input);
        return new TextEncoder().encode("a: 1\n");
      }
    });
    assert.deepEqual(await load(root, "config.yaml", "test-input"), { a: 1 });
    assert.equal(observed[0].maxBytes, 1024 * 1024);
    assert.equal(observed[0].candidate, join(observed[0].root, "config.yaml"));
    for (const [failure, code] of [
      ["escape", "CONFIG_PATH_ESCAPE"],
      ["invalid", "CONFIG_FILE_INVALID"],
      ["symlink", "CONFIG_SYMLINK_PROHIBITED"],
      ["missing", "CONFIG_FILE_UNAVAILABLE"],
      ["changed", "CONFIG_FILE_UNAVAILABLE"],
      ["unavailable", "CONFIG_FILE_UNAVAILABLE"]
    ]) {
      const failed = createStrictYamlFileLoader({ async read() { throw new ContainedFileReadError(failure); } });
      await assert.rejects(failed(root, "config.yaml", "test-input"), (error) =>
        error.problem.code === code && error.problem.phase === "test-input" && error.problem.retryable === false);
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(load("/must-not-be-observed", "../bad", "test-input", controller.signal),
      (error) => error.problem.code === "EXECUTION_CANCELLED");
    assert.equal(observed.length, 1);
    for (const fail of [false, true]) {
      const during = new AbortController();
      const interrupted = createStrictYamlFileLoader({ async read() {
        during.abort();
        if (fail) { throw new ContainedFileReadError("changed"); }
        return new TextEncoder().encode("[malformed");
      } });
      await assert.rejects(interrupted(root, "config.yaml", "test-input", during.signal),
        (error) => error.problem.code === (fail ? "CONFIG_FILE_UNAVAILABLE" : "EXECUTION_CANCELLED"));
    }
    const providerFailure = new Error("provider failed");
    const unavailable = createStrictYamlFileLoader({ async read() { throw providerFailure; } });
    await assert.rejects(unavailable(root, "config.yaml", "test-input"), (error) => error === providerFailure);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict YAML keeps inert values and prohibits duplicate keys, tags, aliases and merge keys", () => {
  assert.deepEqual(parseStrictYamlSource("\uFEFFa: 1\nb: null\nc: [true, false]\n", "input"),
    { a: 1, b: null, c: [true, false] });
  for (const [source, code] of [
    ["a: 1\na: 2", "YAML_INVALID"],
    ["a: &a 1\nb: *a", "YAML_FEATURE_PROHIBITED"],
    ["a: !!str 1", "YAML_FEATURE_PROHIBITED"],
    ["a: {<<: {b: 1}}", "YAML_FEATURE_PROHIBITED"],
    ["a: [", "YAML_INVALID"]
  ]) {
    assert.throws(() => parseStrictYamlSource(source, "input"), (error) => error.problem.code === code);
  }
  assert.deepEqual(parseStrictYamlSource("a: 1\0", "input"), { a: "1\0" });
});

test("check-host config observation receives strict input without a schema registry backedge", async () => {
  const calls = [];
  const config = { schemaVersion: 1, project: { id: "port" }, capabilities: {} };
  const reader = createFoundationConfigReader(new Set(), {
    async loadStrictYamlFile(...args) { calls.push(["load", ...args]); return config; },
    async assertSchema(...args) { calls.push(["schema", ...args]); }
  });
  const result = await reader("/virtual-consumer");
  assert.equal(result.projectId, "port");
  assert.deepEqual(calls, [
    ["load", "/virtual-consumer", "foundation.config.yaml", "foundation-config", undefined],
    ["schema", "foundation-config/v1", config, "foundation-config"]
  ]);
});

test("schema contribution assembly preserves every published source byte and dependency registration", async () => {
  assert.equal(FOUNDATION_SCHEMA_IDS.length, 31);
  assert.equal(new Set(FOUNDATION_SCHEMA_IDS).size, FOUNDATION_SCHEMA_IDS.length);
  for (const id of FOUNDATION_SCHEMA_IDS) {
    const source = await readFoundationSchema(id);
    assert.equal(source, await readFile(new URL(`../packages/engineering-foundation/schemas/${id}.schema.json`, import.meta.url), "utf8"));
    await assert.rejects(assertSchema(id, null, "schema-parity"), (error) => error.problem.code === "SCHEMA_INVALID");
  }
});

test("schema validation retains dependency order, concurrent caching and bounded diagnostics", async () => {
  const reads = [];
  const sources = {
    child: { $id: "urn:ef2:child", type: "string" },
    parent: { $id: "urn:ef2:parent", type: "object", additionalProperties: false,
      required: ["x", "y"], properties: { x: { $ref: "urn:ef2:child" }, y: { type: "integer" } } }
  };
  const catalog = createSchemaCatalog({
    schemaIds: ["parent", "child"], dependencies: { parent: ["child"] },
    async readSchema(id) { reads.push(id); return JSON.stringify(sources[id]); }
  });
  await Promise.all([catalog.assertSchema("parent", { x: "ok", y: 1 }, "input"), catalog.assertSchema("parent", { x: "ok", y: 2 }, "input")]);
  assert.deepEqual(reads, ["child", "parent"]);
  assert.equal(catalog.isSchemaId("child"), true);
  assert.equal(catalog.isSchemaId("missing"), false);
  await assert.rejects(catalog.assertSchema("parent", { x: 1, y: "bad" }, "input"), (error) =>
    error.problem.message === "/x must be string; /y must be integer");
  const many = createSchemaCatalog({ schemaIds: ["many"], dependencies: {}, async readSchema() {
    const required = Array.from({ length: 20 }, (_, i) => `missing${i}`);
    return JSON.stringify({ $id: "urn:ef2:many", type: "object", required,
      properties: Object.fromEntries(required.map((key) => [key, { type: "string" }])) });
  } });
  await assert.rejects(many.assertSchema("many", {}, "input"), (error) =>
    error.problem.message.split("; ").length === 8 && error.problem.message.length <= 1000);
});

test("packaged schema observation enforces the existing contained-file bound before retaining bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-schema-bound-"));
  try {
    await mkdir(join(root, "schemas"));
    const reader = createPackagedSchemaReader({ packageRoot: root, files: { read: readContainedRegularFile },
      async readAuthoringSchema() { throw new Error("unexpected external schema"); } });
    const bytes = " ".repeat(1024 * 1024);
    await writeFile(join(root, "schemas/large.schema.json"), bytes);
    assert.equal(await reader("large"), bytes);
    await writeFile(join(root, "schemas/large.schema.json"), bytes + " ");
    await assert.rejects(reader("large"), (error) => error instanceof ContainedFileReadError && error.failure === "invalid");
    await assert.rejects(reader("../outside"), (error) => error.problem.code === "CONFIG_PATH_INVALID");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("packaged schema observation refuses file and ancestor symlinks", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-schema-symlink-"));
  try {
    await mkdir(join(root, "schemas"));
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real/value.schema.json"), "{}");
    await symlink(join(root, "real/value.schema.json"), join(root, "schemas/file.schema.json"));
    await symlink(join(root, "real"), join(root, "schemas/ancestor"));
    const reader = createPackagedSchemaReader({ packageRoot: root, files: { read: readContainedRegularFile },
      async readAuthoringSchema() { throw new Error("unexpected external schema"); } });
    for (const id of ["file", "ancestor/value"]) {
      await assert.rejects(reader(id), (error) => error instanceof ContainedFileReadError && error.failure === "symlink");
    }
    await rm(join(root, "schemas"), { recursive: true });
    await symlink(join(root, "real"), join(root, "schemas"));
    await assert.rejects(reader("value"), (error) => error instanceof ContainedFileReadError && error.failure === "symlink");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("suppression analysis consumes explicit snapshots and preserves scanner failures", async () => {
  const { analyzeSuppressionGovernance } = await import("../packages/engineering-foundation/dist/capabilities/suppression-governance/api.js");
  const { OxcSuppressionScanner } = await import("../packages/engineering-foundation/dist/capabilities/suppression-governance/adapters/outbound/oxc/oxc-suppression-scanner.js");
  const signal = new AbortController().signal;
  const input = { consumerRoot: "/inert", policy: { governedRoots: ["src"], nonWaivableRulePrefixes: [], waivers: [] }, signal };
  const reader = { async read(root, roots, observedSignal) {
    assert.equal(root, input.consumerRoot);
    assert.deepEqual(roots, ["src"]);
    assert.equal(observedSignal, signal);
    return [{ path: "src/test.ts", source: "// @ts-ignore\nexport const value = 1;" }];
  } };
  const dependencies = { sourceReader: reader, scanner: new OxcSuppressionScanner(), clock: { today: () => "2026-09-05" } };
  const diagnostics = await analyzeSuppressionGovernance(input, dependencies);
  assert.ok(diagnostics.some(({ ruleId }) => ruleId === "quality.suppression-governance.prohibited-typescript-suppression"));
  const failure = new Error("snapshot unavailable");
  await assert.rejects(analyzeSuppressionGovernance(input, {
    ...dependencies, sourceReader: { async read() { throw failure; } },
  }), (error) => error === failure);
});
