import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { check, cliPath, withAgentWorkflowFixture } from "./support/capability-fixtures.mjs";
import { PnpmPackageScriptRunner } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/pnpm/pnpm-package-script-runner.js";

function git(consumerRoot, ...args) {
  const result = spawnSync("git", args, { cwd: consumerRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function gitOutput(consumerRoot, ...args) {
  const result = spawnSync("git", args, { cwd: consumerRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
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

function runChangedAuto(consumerRoot) {
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "agent-workflow",
      "changed",
      "--consumer",
      consumerRoot,
      "--format",
      "json",
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

async function waitForProcessId(path) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(path, "utf8"), 10);
      if (Number.isSafeInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // The producer may not have created the synchronization file yet.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`Timed out waiting for a process ID in ${path}.`);
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


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

test("SIGTERM cancels the changed workflow and its retained process tree", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const manifestPath = join(consumerRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.scripts["lint:fast:files"] = "node scripts/never-exit.mjs";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(
      join(consumerRoot, "scripts", "never-exit.mjs"),
      `import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore"
});
descendant.once("exit", () => process.exit());
await writeFile(".fixture-descendant.pid", String(descendant.pid));
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    initializeRepository(consumerRoot);
    await writeFile(join(consumerRoot, "src", "index.ts"), "export const fixture = false;\n");

    const command = spawn(
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
      ],
      { encoding: "utf8" },
    );
    let stdout = "";
    command.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    let stderr = "";
    command.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let descendantPid;
    try {
      descendantPid = await waitForProcessId(
        join(consumerRoot, ".fixture-descendant.pid"),
      );
      const closed = new Promise((resolve) => {
        command.once("close", resolve);
      });
      assert.equal(command.kill("SIGTERM"), true);
      const exitCode = await closed;
      for (let attempt = 0; attempt < 100 && processIsRunning(descendantPid); attempt += 1) {
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }

      assert.equal(exitCode, 130, stderr);
      assert.equal(stderr, "");
      assert.equal(JSON.parse(stdout).error.code, "PROCESS_CANCELLED");
      assert.equal(processIsRunning(descendantPid), false);
    } finally {
      if (descendantPid !== undefined && processIsRunning(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      if (command.exitCode === null && command.signalCode === null) {
        command.kill("SIGKILL");
      }
    }
  });
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

test("accepts Foundation's exact built self-dogfood changed runner", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const manifestPath = join(consumerRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.scripts["check:changed"] =
      "pnpm build && node packages/engineering-foundation/dist/cli.js agent-workflow changed --consumer .";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      report.capabilities[0].diagnostics.some(
        ({ ruleId }) => ruleId === "repository.agent-workflow.changed-runner-invalid",
      ),
      false,
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
    assert.equal(report.requestedBaseRef, "HEAD");
    assert.equal(report.resolvedBaseRef, "HEAD");
    assert.equal(report.baseCommit, report.headCommit);
    assert.equal(report.mergeBaseCommit, report.headCommit);
    assert.match(report.scopeDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(report.changeGroups, {
      committed: { paths: [], deletedPaths: [] },
      staged: { paths: [], deletedPaths: [] },
      unstaged: { paths: [], deletedPaths: [] },
      untracked: { paths: [], deletedPaths: [] },
    });
  });
});

test("reports committed, staged, unstaged, and untracked evidence without changing routing", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    for (const name of ["committed.ts", "staged.ts", "unstaged.ts"]) {
      await writeFile(join(consumerRoot, "src", name), "export const value = 0;\n");
    }
    initializeRepository(consumerRoot);
    const baseCommit = gitOutput(consumerRoot, "rev-parse", "HEAD");

    await writeFile(join(consumerRoot, "src", "committed.ts"), "export const value = 1;\n");
    git(consumerRoot, "add", "--", "src/committed.ts");
    git(consumerRoot, "commit", "--message", "test: committed evidence");
    await writeFile(join(consumerRoot, "src", "staged.ts"), "export const value = 2;\n");
    git(consumerRoot, "add", "--", "src/staged.ts");
    await writeFile(join(consumerRoot, "src", "unstaged.ts"), "export const value = 3;\n");
    await writeFile(join(consumerRoot, "src", "untracked.ts"), "export const value = 4;\n");

    const { result, report } = runChanged(consumerRoot, "--base", baseCommit);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.coverage, "changed");
    assert.equal(report.requestedBaseRef, baseCommit);
    assert.equal(report.resolvedBaseRef, baseCommit);
    assert.equal(report.baseCommit, baseCommit);
    assert.equal(report.mergeBaseCommit, baseCommit);
    assert.deepEqual(report.changeGroups, {
      committed: { paths: ["src/committed.ts"], deletedPaths: [] },
      staged: { paths: ["src/staged.ts"], deletedPaths: [] },
      unstaged: { paths: ["src/unstaged.ts"], deletedPaths: [] },
      untracked: { paths: ["src/untracked.ts"], deletedPaths: [] },
    });
    assert.deepEqual(report.changedPaths, [
      "src/committed.ts",
      "src/staged.ts",
      "src/unstaged.ts",
      "src/untracked.ts",
    ]);
  });
});

test("produces a deterministic empty-scope digest and does not mutate the repository", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const indexPath = join(consumerRoot, ".git", "index");
    const indexBefore = await readFile(indexPath);
    const statusBefore = gitOutput(consumerRoot, "status", "--porcelain=v2", "-z");

    const first = runChanged(consumerRoot);
    const second = runChanged(consumerRoot);

    assert.equal(first.result.status, 0, first.result.stderr);
    assert.equal(second.result.status, 0, second.result.stderr);
    assert.equal(second.report.scopeDigest, first.report.scopeDigest);
    assert.deepEqual(await readFile(indexPath), indexBefore);
    assert.equal(
      gitOutput(consumerRoot, "status", "--porcelain=v2", "-z"),
      statusBefore,
    );
  });
});

test("auto base reports the resolved ref separately from its merge base", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const initial = gitOutput(consumerRoot, "rev-parse", "HEAD");
    await writeFile(join(consumerRoot, "src", "index.ts"), "export const fixture = false;\n");
    git(consumerRoot, "add", "--", "src/index.ts");
    git(consumerRoot, "commit", "--message", "test: advance head");

    const { result, report } = runChangedAuto(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.requestedBaseRef, null);
    assert.equal(report.resolvedBaseRef, "refs/heads/main");
    assert.equal(report.baseCommit, report.headCommit);
    assert.equal(report.mergeBaseCommit, report.headCommit);
    assert.notEqual(report.headCommit, initial);
  });
});

test("auto base preserves committed scope from a detached head", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const baseCommit = gitOutput(consumerRoot, "rev-parse", "HEAD");
    await writeFile(join(consumerRoot, "src", "index.ts"), "export const fixture = false;\n");
    git(consumerRoot, "add", "--", "src/index.ts");
    git(consumerRoot, "commit", "--message", "test: detached change");
    const headCommit = gitOutput(consumerRoot, "rev-parse", "HEAD");
    git(consumerRoot, "update-ref", "refs/remotes/origin/main", baseCommit);
    git(consumerRoot, "checkout", "--detach", headCommit);
    git(consumerRoot, "branch", "--delete", "--force", "main");

    const { result, report } = runChangedAuto(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.resolvedBaseRef, "refs/remotes/origin/main");
    assert.equal(report.baseCommit, baseCommit);
    assert.equal(report.headCommit, headCommit);
    assert.equal(report.mergeBaseCommit, baseCommit);
    assert.deepEqual(report.changeGroups.committed.paths, ["src/index.ts"]);
  });
});

test("ignores local replacement objects when deriving immutable Git evidence", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const baseCommit = gitOutput(consumerRoot, "rev-parse", "HEAD");
    await writeFile(join(consumerRoot, "src", "index.ts"), "export const fixture = false;\n");
    git(consumerRoot, "add", "--", "src/index.ts");
    git(consumerRoot, "commit", "--message", "test: replacement target");
    const headCommit = gitOutput(consumerRoot, "rev-parse", "HEAD");
    git(consumerRoot, "update-ref", "refs/remotes/origin/main", baseCommit);
    git(consumerRoot, "checkout", "--detach", headCommit);
    git(consumerRoot, "branch", "--delete", "--force", "main");
    git(consumerRoot, "replace", headCommit, baseCommit);

    const { result, report } = runChangedAuto(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.headCommit, headCommit);
    assert.equal(report.mergeBaseCommit, baseCommit);
    assert.deepEqual(report.changeGroups.committed.paths, ["src/index.ts"]);
  });
});

test("fails closed when an auto base is present but shallow history hides its merge base", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const baseCommit = gitOutput(consumerRoot, "rev-parse", "HEAD");
    await writeFile(join(consumerRoot, "src", "index.ts"), "export const fixture = false;\n");
    git(consumerRoot, "add", "--", "src/index.ts");
    git(consumerRoot, "commit", "--message", "test: shallow head");
    const headCommit = gitOutput(consumerRoot, "rev-parse", "HEAD");
    git(consumerRoot, "update-ref", "refs/remotes/origin/main", baseCommit);
    git(consumerRoot, "checkout", "--detach", headCommit);
    git(consumerRoot, "branch", "--delete", "--force", "main");
    await writeFile(join(consumerRoot, ".git", "shallow"), `${headCommit}\n`, "utf8");

    const { result, report } = runChangedAuto(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(report.error.code, "CONSUMER_INVALID");
    assert.match(report.error.message, /history may be shallow or unrelated/u);
  });
});

test("reports an unborn repository without inventing commit identities", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    git(consumerRoot, "init", "--initial-branch=main");
    const { result, report } = runChangedAuto(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.coverage, "fast-full");
    assert.equal(report.resolvedBaseRef, "unborn-head");
    assert.equal(report.baseCommit, null);
    assert.equal(report.headCommit, null);
    assert.equal(report.mergeBaseCommit, null);
    assert.equal(report.changeGroups.untracked.paths.includes("AGENTS.md"), true);
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
    assert.deepEqual(report.changeGroups.staged, {
      paths: ["src/index.ts"],
      deletedPaths: ["src/index.ts"],
    });
    assert.deepEqual(report.changeGroups.untracked, {
      paths: ["src/index.ts"],
      deletedPaths: [],
    });
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
    assert.equal(result.stderr, "");
    assert.equal(report.outcome, "invalid-input");
    assert.equal(report.error.code, "CONSUMER_INVALID");
    assert.match(report.error.message, /The base ref cannot start with a dash/u);
  });
});

test("rejects an explicit base that is ambiguous across ref namespaces", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    git(consumerRoot, "branch", "collision");
    git(consumerRoot, "tag", "collision");

    const { result, report } = runChanged(consumerRoot, "--base", "collision");
    assert.equal(result.status, 2);
    assert.equal(report.error.code, "CONSUMER_INVALID");
    assert.match(report.error.message, /explicit base ref.*is ambiguous/u);
    assert.match(report.error.message, /refs\/heads\/collision/u);
    assert.match(report.error.message, /refs\/tags\/collision/u);
  });
});

test("rejects revision expressions disguised as exact or shorthand refs", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    await writeFile(join(consumerRoot, "src", "index.ts"), "export const fixture = false;\n");
    git(consumerRoot, "add", "--", "src/index.ts");
    git(consumerRoot, "commit", "--message", "test: ref expression target");

    for (const base of ["refs/heads/main~1", "main~1"]) {
      const { result, report } = runChanged(consumerRoot, "--base", base);
      assert.equal(result.status, 2);
      assert.equal(report.error.code, "CONSUMER_INVALID");
      assert.match(report.error.message, /not an exact Git ref name/u);
    }
  });
});

test("rejects non-UTF8 Git paths instead of decoding replacement characters", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const gitPath = spawnSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim();
    const fakeBin = join(consumerRoot, ".fake-bin");
    await mkdir(fakeBin);
    const fakeGit = join(fakeBin, "git");
    await writeFile(
      fakeGit,
      `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
if (process.argv.includes("ls-files")) {
  process.stdout.write(Buffer.from([0xff, 0x2e, 0x74, 0x73, 0x00]));
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(gitPath)}, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
      "utf8",
    );
    await chmod(fakeGit, 0o755);
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
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      },
    );
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "");
    assert.equal(report.error.code, "CONSUMER_INVALID");
    assert.match(report.error.message, /not valid UTF-8/u);
  });
});

test("rejects Git path evidence without a terminating NUL", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const gitPath = spawnSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim();
    const fakeBin = join(consumerRoot, ".fake-bin");
    await mkdir(fakeBin);
    const fakeGit = join(fakeBin, "git");
    await writeFile(
      fakeGit,
      `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
if (process.argv.includes("ls-files")) {
  process.stdout.write("src/malformed.ts");
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(gitPath)}, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
      "utf8",
    );
    await chmod(fakeGit, 0o755);
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
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      },
    );
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 2);
    assert.equal(report.error.code, "CONSUMER_INVALID");
    assert.match(report.error.message, /malformed NUL-delimited/u);
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
    assert.equal(result.stderr, "");
    assert.equal(report.outcome, "invalid-input");
    assert.equal(report.error.code, "CONSUMER_INVALID");
    assert.match(report.error.message, /Git reported an unsafe repository path/u);
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
    assert.equal(result.stderr, "");
    assert.equal(report.outcome, "invalid-input");
    assert.equal(report.error.code, "CONSUMER_INVALID");
    assert.match(report.error.message, /Changed path is not a regular file/u);
  });
});
