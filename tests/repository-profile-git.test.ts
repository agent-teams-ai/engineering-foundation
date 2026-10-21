import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitRepositoryChangesReader } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/git/git-repository-changes-reader.js";
import { withGitIndexSnapshot } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/git/git-index-snapshot.js";
import { createProcessExecution } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/process/process-execution.js";
import type { ManagedProcessRequest } from "../packages/engineering-foundation/dist/process-execution/api.js";
import { createWorkflowProcess } from "./support/capability-adapters.mjs";

test("Git snapshot preserves the explicit operator environment and owns only its forced overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foundation-profile-git-environment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceIndex = join(root, "operator-index");
  await writeFile(sourceIndex, "source index bytes");
  const environment = Object.freeze({
    PATH: "/operator/bin",
    HOME: "/operator/home",
    GIT_AUTHOR_NAME: "Operator",
    GIT_SSH_COMMAND: "operator-ssh -F /operator/ssh-config",
    GIT_ASKPASS: "/operator/askpass",
    GIT_CONFIG_GLOBAL: "/operator/gitconfig",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.quotePath",
    GIT_CONFIG_VALUE_0: "false",
    GIT_OPTIONAL_LOCKS: "1",
    GIT_INDEX_FILE: sourceIndex,
    REMOVE_FOR_READ: "present"
  });
  const overrides = Object.freeze({
    GIT_AUTHOR_NAME: "Per-call identity",
    GIT_OPTIONAL_LOCKS: "1",
    GIT_INDEX_FILE: "/unowned/per-call-index",
    REQUEST_SETTING: "per-call value",
    REMOVE_FOR_READ: undefined
  });
  const originalEnvironment = { ...environment };
  const originalOverrides = { ...overrides };
  const requests: ManagedProcessRequest[] = [];
  const execute = createProcessExecution({ async run(request) {
    requests.push(request);
    return { exitCode: 0, signal: null, stdout: `${sourceIndex}\n`, stderr: "" };
  } }, environment);
  let ownedIndex = "";
  await withGitIndexSnapshot(execute, root, async (read) => {
    assert.deepEqual(requests[0]?.environment, originalEnvironment,
      "index discovery must use the supplied operator environment");
    await read("git", ["diff"], { cwd: root, environment: overrides });
    const observed = requests[1]?.environment;
    assert.ok(observed);
    ownedIndex = observed.GIT_INDEX_FILE ?? "";
    assert.notEqual(ownedIndex, sourceIndex);
    assert.notEqual(ownedIndex, overrides.GIT_INDEX_FILE);
    assert.equal(await readFile(ownedIndex, "utf8"), "source index bytes");
    assert.deepEqual(observed, {
      PATH: "/operator/bin",
      HOME: "/operator/home",
      GIT_AUTHOR_NAME: "Per-call identity",
      GIT_SSH_COMMAND: "operator-ssh -F /operator/ssh-config",
      GIT_ASKPASS: "/operator/askpass",
      GIT_CONFIG_GLOBAL: "/operator/gitconfig",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.quotePath",
      GIT_CONFIG_VALUE_0: "false",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_INDEX_FILE: ownedIndex,
      REQUEST_SETTING: "per-call value"
    });
  });
  assert.deepEqual(environment, originalEnvironment);
  assert.deepEqual(overrides, originalOverrides);
  assert.deepEqual(requests[0]?.environment, originalEnvironment,
    "snapshot overrides must not mutate earlier process requests");
  assert.equal(await readFile(sourceIndex, "utf8"), "source index bytes");
  await assert.rejects(readFile(ownedIndex), { code: "ENOENT" });
});

test("workflow environment overrides use Windows name identity and preserve POSIX case sensitivity", async () => {
  const environment = Object.freeze({ Path: "/operator/bin", GIT_AUTHOR_NAME: "Operator", KEEP: "operator" });
  const overrides = Object.freeze({ PATH: "/request/bin", Git_Author_Name: undefined });
  for (const platform of ["linux", "win32"] as const) {
    let observed: ManagedProcessRequest["environment"];
    const execute = createProcessExecution({ async run(request) {
      observed = request.environment;
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    } }, environment, platform);
    await execute("git", ["status"], { cwd: "/inert", environment: overrides });
    assert.deepEqual(observed, platform === "win32"
      ? { PATH: "/request/bin", KEEP: "operator" }
      : { Path: "/operator/bin", GIT_AUTHOR_NAME: "Operator", KEEP: "operator", PATH: "/request/bin" });
  }
});

test("Git snapshot forced variables override every Windows casing without duplicate names", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foundation-profile-git-windows-environment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceIndex = join(root, "source-index");
  await writeFile(sourceIndex, "source index bytes");
  const environment = Object.freeze({ Path: "/operator/bin", git_index_file: sourceIndex, git_optional_locks: "1" });
  const overrides = Object.freeze({
    GIT_INDEX_FILE: "/canonical/caller-index", git_index_file: "/lowercase/caller-index",
    GIT_OPTIONAL_LOCKS: "1", git_optional_locks: "1", PATH: "/request/bin"
  });
  const requests: ManagedProcessRequest[] = [];
  const executor = { async run(request: ManagedProcessRequest) {
    const names = Object.keys(request.environment ?? {}).map((name) => name.toUpperCase());
    assert.equal(new Set(names).size, names.length, "Windows rejects duplicate logical environment names");
    requests.push(request);
    return { exitCode: 0, signal: null, stdout: `${sourceIndex}\n`, stderr: "" };
  } };
  await assert.rejects(executor.run({
    command: "git", args: [], cwd: root, environment: { ...environment, ...overrides }
  }), /Windows rejects duplicate logical environment names/u);
  const execute = createProcessExecution(executor, environment, "win32");
  let ownedIndex = "";
  await withGitIndexSnapshot(execute, root, async (read) => {
    await read("git", ["diff"], { cwd: root, environment: overrides });
    const observed = requests[1]?.environment;
    ownedIndex = observed?.GIT_INDEX_FILE ?? "";
    assert.notEqual(ownedIndex, sourceIndex);
    assert.notEqual(ownedIndex, overrides.GIT_INDEX_FILE);
    assert.notEqual(ownedIndex, overrides.git_index_file);
    assert.deepEqual(observed, { PATH: "/request/bin", GIT_INDEX_FILE: ownedIndex, GIT_OPTIONAL_LOCKS: "0" });
    assert.equal(await readFile(ownedIndex, "utf8"), "source index bytes");
  });
  assert.deepEqual(environment, { Path: "/operator/bin", git_index_file: sourceIndex, git_optional_locks: "1" });
  assert.deepEqual(overrides, {
    GIT_INDEX_FILE: "/canonical/caller-index", git_index_file: "/lowercase/caller-index",
    GIT_OPTIONAL_LOCKS: "1", git_optional_locks: "1", PATH: "/request/bin"
  });
  await assert.rejects(readFile(ownedIndex), { code: "ENOENT" });
});

test("stat-only Git refresh preserves source index bytes and exact staged/unstaged groups", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foundation-profile-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]): void => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "--quiet", "--initial-branch=main");
  await mkdir(join(root, "src"));
  for (const name of ["stat-only.ts", "staged.ts", "unstaged.ts"]) {
    await writeFile(join(root, "src", name), "export const value = 0;\n");
  }
  git("add", "--all");
  git("-c", "user.name=Foundation TEST", "-c", "user.email=test@agent-teams.invalid", "commit", "-qm", "test: initialize");
  await writeFile(join(root, "src/staged.ts"), "export const value = 1;\n");
  git("add", "--", "src/staged.ts");
  await writeFile(join(root, "src/unstaged.ts"), "export const value = 2;\n");
  const changedStat = new Date(Date.now() + 5_000);
  await utimes(join(root, "src/stat-only.ts"), changedStat, changedStat);
  const indexPath = join(root, ".git/index");
  const before = await readFile(indexPath);
  const report = await new GitRepositoryChangesReader(createWorkflowProcess()).collect({ consumerRoot: root, baseRef: "HEAD" });
  assert.deepEqual(report.changeGroups.staged.paths, ["src/staged.ts"]);
  assert.deepEqual(report.changeGroups.unstaged.paths, ["src/unstaged.ts"]);
  assert.deepEqual(report.changedPaths, ["src/staged.ts", "src/unstaged.ts"]);
  assert.deepEqual(await readFile(indexPath), before,
    "Git stat refresh must affect only its disposable index and must not hide racy edits");
  const failure = new Error("stop after owning the index copy");
  let ownedIndex = "";
  await assert.rejects(withGitIndexSnapshot(createWorkflowProcess(), root, async (read) => {
    const result = await read("git", ["rev-parse", "--git-path", "index"], { cwd: root });
    assert.equal(result.exitCode, 0);
    ownedIndex = result.stdout.trim();
    assert.notEqual(ownedIndex, indexPath);
    throw failure;
  }), (error: unknown) => error === failure);
  await assert.rejects(readFile(ownedIndex), { code: "ENOENT" });
  assert.deepEqual(await readFile(indexPath), before);
});
