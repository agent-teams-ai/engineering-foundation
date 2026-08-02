import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  check,
  cliPath,
  withAgentWorkflowFixture,
} from "./support/capability-fixtures.mjs";
import { PnpmPackageScriptRunner } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/pnpm/pnpm-package-script-runner.js";

function git(consumerRoot, ...args) {
  const result = spawnSync("git", args, { cwd: consumerRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function initializeRepository(consumerRoot) {
  git(consumerRoot, "init", "--initial-branch=main");
  git(consumerRoot, "config", "user.email", "fixture@agent-teams.invalid");
  git(consumerRoot, "config", "user.name", "Foundation fixture");
  git(consumerRoot, "add", "--all");
  git(consumerRoot, "commit", "--message", "test: initialize fixture");
}

function runChanged(consumerRoot, ...args) {
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "agent-workflow",
      "changed",
      "--base",
      "HEAD",
      "--consumer",
      consumerRoot,
      "--format",
      "json",
      ...args,
    ],
    { encoding: "utf8" },
  );
  return {
    result,
    report: result.stdout.length === 0 ? null : JSON.parse(result.stdout),
  };
}

async function invocations(consumerRoot) {
  const source = await readFile(
    join(consumerRoot, ".fixture-invocations.jsonl"),
    "utf8",
  );
  return source.trim().split("\n").map((line) => JSON.parse(line));
}

test("accepts one canonical instruction source with portable adapters", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0);
    assert.equal(report.outcome, "passed");
    assert.equal(report.capabilities[0].capabilityId, "repository.agent-workflow");
  });
});

test("executes pnpm through its shell-free package entrypoint", async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), "foundation-pnpm-entrypoint-"));
  try {
    const pnpmHome = join(consumerRoot, "node_modules", ".bin");
    const pnpmPackageRoot = join(consumerRoot, "node_modules", "pnpm", "bin");
    await mkdir(pnpmHome, { recursive: true });
    await mkdir(pnpmPackageRoot, { recursive: true });
    await writeFile(
      join(pnpmPackageRoot, "pnpm.cjs"),
      `require("node:fs").writeFileSync(".fake-pnpm-args.json", JSON.stringify(process.argv.slice(2)));\n`,
      "utf8",
    );
    const result = await new PnpmPackageScriptRunner({ pnpmHome }).run({
      consumerRoot,
      script: "lint:files",
      paths: ["src/file with space.ts"],
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      JSON.parse(await readFile(join(consumerRoot, ".fake-pnpm-args.json"), "utf8")),
      ["run", "lint:files", "--", "src/file with space.ts"],
    );
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
});

test("reports broken adapters, undocumented commands, and missing scripts", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    await rm(join(consumerRoot, "CLAUDE.md"));
    await writeFile(
      join(consumerRoot, "GEMINI.md"),
      "# Detached instructions mention @AGENTS.md without importing it\n",
      "utf8",
    );
    await writeFile(join(consumerRoot, "AGENTS.md"), "# Incomplete instructions\n", "utf8");
    const manifestPath = join(consumerRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.scripts.typecheck;
    manifest.scripts["check:changed"] = "node scripts/record-check.mjs changed";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      new Set(report.capabilities[0].diagnostics.map(({ ruleId }) => ruleId)),
      new Set([
        "repository.agent-workflow.adapter-not-linked",
        "repository.agent-workflow.changed-runner-invalid",
        "repository.agent-workflow.command-not-documented",
        "repository.agent-workflow.instruction-file-invalid",
        "repository.agent-workflow.package-script-missing",
      ]),
    );
  });
});

test("rejects instruction adapters that are symbolic links", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const adapterPath = join(consumerRoot, "CLAUDE.md");
    const targetPath = join(consumerRoot, "CLAUDE.real.md");
    await rename(adapterPath, targetPath);
    await symlink(targetPath, adapterPath);
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.equal(
      report.capabilities[0].diagnostics.some(
        ({ ruleId }) => ruleId === "repository.agent-workflow.instruction-file-invalid",
      ),
      true,
    );
  });
});

test("rejects one file being assigned to multiple instruction roles", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const configPath = join(
      consumerRoot,
      "architecture",
      "foundation",
      "repository-agent-workflow.yaml",
    );
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source.replace("claude: CLAUDE.md", "claude: AGENTS.md"),
      "utf8",
    );
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(
      report.capabilities[0].problem.code,
      "REPOSITORY_AGENT_WORKFLOW_CONFIG_INVALID",
    );
  });
});

test("does not run package scripts when the Git delta is empty", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.outcome, "passed");
    assert.equal(report.coverage, "changed");
    assert.deepEqual(report.changedPaths, []);
    assert.deepEqual(report.steps, []);
  });
});

test("routes changed source files to path-aware and project-wide checks", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    await writeFile(join(consumerRoot, "src", "index.ts"), "export const fixture = false;\n");
    await writeFile(join(consumerRoot, "src", "file with space.ts"), "export const spaced = true;\n");

    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.coverage, "changed");
    assert.deepEqual(
      report.steps.map(({ id, paths }) => ({ id, paths })),
      [
        {
          id: "lint",
          paths: ["src/file with space.ts", "src/index.ts"],
        },
        { id: "typecheck", paths: [] },
      ],
    );
    assert.deepEqual(await invocations(consumerRoot), [
      {
        kind: "lint",
        paths: ["src/file with space.ts", "src/index.ts"],
      },
      { kind: "typecheck", paths: [] },
    ]);
  });
});

test("matches configured multi-dot extensions", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const configPath = join(
      consumerRoot,
      "architecture",
      "foundation",
      "repository-agent-workflow.yaml",
    );
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source.replace("extensions: [.js, .mjs, .ts, .tsx]", "extensions: [.d.ts]"),
      "utf8",
    );
    initializeRepository(consumerRoot);
    await writeFile(
      join(consumerRoot, "src", "public-api.d.ts"),
      "export declare const publicApi: true;\n",
      "utf8",
    );

    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      report.steps.map(({ id, paths }) => ({ id, paths })),
      [
        { id: "lint", paths: ["src/public-api.d.ts"] },
        { id: "typecheck", paths: [] },
      ],
    );
  });
});

test("rejects a fast workflow that recursively invokes the changed workflow", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const configPath = join(
      consumerRoot,
      "architecture",
      "foundation",
      "repository-agent-workflow.yaml",
    );
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source.replace("fast: check:fast", "fast: check:changed"),
      "utf8",
    );

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(
      report.capabilities[0].problem.code,
      "REPOSITORY_AGENT_WORKFLOW_CONFIG_INVALID",
    );
    assert.match(
      report.capabilities[0].problem.message,
      /fast workflow script cannot be the changed workflow script/u,
    );
  });
});

test("escalates policy changes and deletions to the configured fast full gate", async () => {
  for (const mutate of [
    (consumerRoot) => writeFile(
      join(consumerRoot, "AGENTS.md"),
      "Run `pnpm check:changed`, `pnpm check:fast`, and `pnpm check`.\n",
      "utf8",
    ),
    (consumerRoot) => rm(join(consumerRoot, "src", "index.ts")),
  ]) {
    await withAgentWorkflowFixture(async (consumerRoot) => {
      initializeRepository(consumerRoot);
      await mutate(consumerRoot);
      const { result, report } = runChanged(consumerRoot);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(report.coverage, "fast-full");
      assert.deepEqual(
        report.steps.map(({ id, script, paths }) => ({ id, script, paths })),
        [{ id: "fast-full", script: "check:fast", paths: [] }],
      );
      assert.deepEqual(await invocations(consumerRoot), [{ kind: "fast", paths: [] }]);
    });
  }
});

test("treats a staged rename as deletion plus addition", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    await rename(
      join(consumerRoot, "src", "index.ts"),
      join(consumerRoot, "src", "renamed.ts"),
    );
    git(consumerRoot, "add", "--all");
    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.coverage, "fast-full");
    assert.deepEqual(report.changedPaths, ["src/index.ts", "src/renamed.ts"]);
    assert.deepEqual(await invocations(consumerRoot), [{ kind: "fast", paths: [] }]);
  });
});

test("does not let an untracked replacement mask a staged deletion", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    git(consumerRoot, "rm", "--cached", "src/index.ts");

    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.coverage, "fast-full");
    assert.deepEqual(report.changedPaths, ["src/index.ts"]);
    assert.deepEqual(await invocations(consumerRoot), [{ kind: "fast", paths: [] }]);
  });
});

test("returns a stable violation result from a changed-file check", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    await writeFile(
      join(consumerRoot, "src", "index.ts"),
      "export const fixture = 'FAIL_FIXTURE';\n",
    );
    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 1);
    assert.equal(report.outcome, "violations");
    assert.equal(report.steps[0].outcome, "violations");
    assert.match(report.steps[0].output, /fixture violation: src\/index\.ts/u);
  });
});

test("escalates an oversized changed-file set instead of overflowing arguments", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    await Promise.all(
      Array.from({ length: 201 }, (_, index) =>
        writeFile(
          join(consumerRoot, "src", `generated-${String(index).padStart(3, "0")}.ts`),
          `export const generated${index} = ${index};\n`,
          "utf8",
        ),
      ),
    );
    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.changedPaths.length, 201);
    assert.equal(report.coverage, "fast-full");
    assert.deepEqual(await invocations(consumerRoot), [{ kind: "fast", paths: [] }]);
  });
});

test("rejects option-shaped Git base refs before invoking Git", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const { result, report } = runChanged(consumerRoot, "--base", "--malicious");
    assert.equal(result.status, 2);
    assert.equal(report, null);
    assert.match(result.stderr, /The base ref cannot start with a dash/u);
  });
});

test("rejects ambiguous repository path characters instead of rewriting them", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    await writeFile(
      join(consumerRoot, "src", "back\\slash.ts"),
      "export const ambiguous = true;\n",
      "utf8",
    );
    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(report, null);
    assert.match(result.stderr, /Git reported an unsafe repository path/u);
  });
});

test("rejects changed symbolic links before invoking consumer scripts", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    await symlink("index.ts", join(consumerRoot, "src", "linked.ts"));
    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(report, null);
    assert.match(result.stderr, /Changed path is not a regular file/u);
  });
});
