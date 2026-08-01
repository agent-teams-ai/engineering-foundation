import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import { runFoundationCheck } from "../packages/engineering-foundation/dist/check-runner.js";

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

function check(consumerRoot, ...args) {
  const result = spawnSync(
    process.execPath,
    [cliPath, "check", ...args, "--consumer", consumerRoot, "--format", "json"],
    { encoding: "utf8" },
  );
  assert.equal(result.stderr, "");
  return { result, report: JSON.parse(result.stdout) };
}

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
