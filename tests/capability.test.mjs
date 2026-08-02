import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { runFoundationCheck } from "../packages/engineering-foundation/dist/check-runner.js";
import { isExactVersion } from "../packages/engineering-foundation/dist/semantic-version.js";
import { releaseOwnedFileViolations } from "../scripts/check-release-owned-files.mjs";
import {
  check,
  cliPath,
  reportSchemaPath,
  withFixture,
  withSourceFixture
} from "./support/capability-fixtures.mjs";

test("accepts only exact SemVer versions", () => {
  assert.equal(isExactVersion("0.3.0"), true);
  assert.equal(isExactVersion("1.0.0-rc.4+build.7"), true);
  assert.equal(isExactVersion("1.0.0-01"), false);
  assert.equal(isExactVersion("1.0.0-."), false);
});

test("allows public API baseline mutation only in the Changesets release branch", () => {
  assert.deepEqual(
    releaseOwnedFileViolations(
      [
        { status: "M", path: "architecture/public-api/library.json" },
        { status: "M", path: "packages/library/src/index.ts" },
        { status: "A", path: "architecture/public-api/new-library.json" },
      ],
      "feat/change-api",
      "agent-teams-ai/engineering-foundation",
      "agent-teams-ai/engineering-foundation",
    ),
    ["architecture/public-api/library.json"],
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
      `catalogMode: strict\ncatalog:\n  ajv: 8.20.0\n  previous-ajv: npm:ajv@8.19.0\n  oxlint: 1.76.0\n  typescript: 7.0.2\n`,
      "utf8",
    );
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0);
    assert.equal(report.outcome, "passed");
  });
});

test("rejects npm catalog aliases with non-exact target versions", async () => {
  await withFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "pnpm-workspace.yaml"),
      `packages:\n  - "packages/*"\ncatalogMode: strict\ncatalog:\n  ajv: 8.20.0\n  previous-ajv: npm:ajv@^8.19.0\n  oxlint: 1.76.0\n  typescript: 7.0.2\n`,
      "utf8",
    );
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.equal(report.outcome, "violations");
    assert.deepEqual(
      report.capabilities[0].diagnostics.map((diagnostic) => diagnostic.ruleId),
      ["workspace.dependency-declarations.catalog-version-not-exact"],
    );
  });
});

test("collects deterministic dependency policy violations", async () => {
  await withFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "pnpm-workspace.yaml"),
      `packages:\n  - "packages/*"\ncatalogMode: manual\ncatalog:\n  ajv: ^8.20.0\n  previous-ajv: npm:ajv@8.19.0\n  oxlint: 1.76.0\n  typescript: 7.0.2\n`,
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
