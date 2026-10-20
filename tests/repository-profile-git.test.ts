import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { GitRepositoryChangesReader } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/git/git-repository-changes-reader.js";
import { withGitIndexSnapshot } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/git/git-index-snapshot.js";
import { createProcessExecution } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/process/process-execution.js";
import type { ManagedProcessRequest } from "../packages/engineering-foundation/dist/process-execution/api.js";
import { createWorkflowProcess } from "./support/capability-adapters.mjs";
import { withoutGitRepositorySelectors } from "../tools/git-environment.ts";

interface ProfileObservation {
  readonly operation: string;
  readonly profileRoot: string;
  readonly sourceRoot: string;
  readonly sourceSha: string;
  readonly runtime: string;
  readonly node: string;
  readonly cwd: string;
  readonly selectors: readonly string[];
  readonly preserved: string;
}

async function changedProfileFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foundation-changed-profile-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("..", import.meta.url));
  for (const path of ["tools/check-changed-repository.ts", "tools/executable-policy.mts",
    "tools/git-environment.ts", "tools/profile-root.mts", "tools/runtime-policy.mts",
    "packages/engineering-foundation/src/process-execution/node-runtime-verifier.ts"]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(join(source, path), join(root, path));
  }
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(join(root, ".gitignore"), ".worker-tmp/\nobservations.jsonl\n");
  // The boundary probe observes the real wrapper's child requests. Actual projection
  // receipts and package installation remain covered by the existing profile-owner tests.
  await writeFile(join(root, "tools/dev.mts"), [
    'import assert from "node:assert/strict";',
    'import { appendFile, readFile, rm, mkdir, writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    'const operation = process.argv[4], profileRoot = process.env["AGENT_TEAMS_FOUNDATION_PROFILE_ROOT"];',
    'assert.deepEqual(process.argv.slice(2), ["--profile", "node", operation]);',
    'await appendFile("observations.jsonl", JSON.stringify({ operation, profileRoot,',
    'sourceRoot: process.env["AGENT_TEAMS_FOUNDATION_SOURCE_ROOT"], sourceSha: process.env["AGENT_TEAMS_FOUNDATION_SOURCE_SHA"],',
    'runtime: process.env["AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE"], node: process.env["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"],',
    'cwd: process.cwd(), selectors: Object.keys(process.env).filter(key => /^(?:GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_CONFIG_(?:COUNT|KEY_0|VALUE_0))$/u.test(key)),',
    'preserved: process.env["C1_TEST_PRESERVED"] }) + "\\n");',
    'if (operation === "install") {',
    'await rm(profileRoot, { recursive: true, force: true }); await mkdir(profileRoot);',
    'await writeFile(join(profileRoot, "installed.marker"), "installed by boundary probe");',
    'if (process.env["C1_TEST_WAIT_FOR_SIGNAL"] === "1") {',
    'await new Promise(fulfill => { process.once("SIGTERM", fulfill); process.stdout.write("ready\\n"); });',
    '} else if (process.env["C1_TEST_INSTALL_SIGNAL"] === "1") { process.kill(process.pid, "SIGTERM"); }',
    'process.exitCode = Number(process.env["C1_TEST_INSTALL_STATUS"] ?? 0);',
    '} else {',
    'assert.equal(await readFile(join(profileRoot, "installed.marker"), "utf8"), "installed by boundary probe");',
    'process.exitCode = Number(process.env["C1_TEST_CHECK_STATUS"] ?? 0);',
    '}'
  ].join("\n"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: withoutGitRepositorySelectors() });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  git("add", "--all");
  git("-c", "user.name=Foundation TEST", "-c", "user.email=test@agent-teams.invalid", "commit", "-qm", "test: initialize");
  const sourceSha = git("rev-parse", "HEAD");
  const existing = join(root, ".worker-tmp/profiles/operator-profile");
  await mkdir(existing, { recursive: true });
  await writeFile(join(existing, "operator.marker"), "do not replace");
  const environment = {
    ...withoutGitRepositorySelectors(), AGENT_TEAMS_FOUNDATION_PROFILE_ROOT: existing,
    AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: join(root, "foreign-source"),
    AGENT_TEAMS_FOUNDATION_SOURCE_SHA: "0".repeat(40), AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "bun",
    AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath,
    GIT_DIR: join(root, "foreign.git"), GIT_WORK_TREE: join(root, "foreign-source"),
    GIT_INDEX_FILE: join(root, "foreign-index"), GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: join(root, "foreign-source"), C1_TEST_PRESERVED: "keep"
  };
  const entry = join(root, "tools/check-changed-repository.ts");
  const observations = async (): Promise<ProfileObservation[]> =>
    (await readFile(join(root, "observations.jsonl"), "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as ProfileObservation);
  return { root, entry, sourceSha, existing, environment, observations };
}

function runChangedProfile(fixture: Awaited<ReturnType<typeof changedProfileFixture>>,
  overrides: NodeJS.ProcessEnv = {}): Promise<number | null> {
  return new Promise((_resolve, reject) => {
    const child = spawn(process.execPath, [fixture.entry], {
      cwd: fixture.root, env: { ...fixture.environment, ...overrides }, stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      assert.equal(signal, null, stderr);
      _resolve(code);
    });
  });
}

void test("changed repository composition owns concurrent profiles and overrides inherited source authority", async (t) => {
  const fixture = await changedProfileFixture(t);
  assert.deepEqual(await Promise.all([runChangedProfile(fixture), runChangedProfile(fixture)]), [0, 0]);
  const observations = await fixture.observations();
  assert.equal(observations.length, 4);
  const targets = [...new Set(observations.map((entry) => entry.profileRoot))];
  assert.equal(targets.length, 2);
  for (const target of targets) {
    assert.equal(dirname(target), join(fixture.root, ".worker-tmp/profiles"));
    assert.notEqual(target, fixture.existing);
    assert.deepEqual(observations.filter((entry) => entry.profileRoot === target), ["install", "check"].map((operation) => ({
      operation, profileRoot: target, sourceRoot: fixture.root, sourceSha: fixture.sourceSha,
      runtime: "node", node: process.execPath, cwd: fixture.root, selectors: [], preserved: "keep"
    })));
  }
  assert.equal(await readFile(join(fixture.existing, "operator.marker"), "utf8"), "do not replace");
});

void test("changed repository composition preserves install/check failures and rejects an unverified Node", async (t) => {
  const fixture = await changedProfileFixture(t);
  assert.equal(await runChangedProfile(fixture, { C1_TEST_INSTALL_STATUS: "23" }), 23);
  assert.deepEqual((await fixture.observations()).map((entry) => entry.operation), ["install"]);
  await rm(join(fixture.root, "observations.jsonl"));
  assert.equal(await runChangedProfile(fixture, { C1_TEST_CHECK_STATUS: "29" }), 29);
  assert.deepEqual((await fixture.observations()).map((entry) => entry.operation), ["install", "check"]);
  await rm(join(fixture.root, "observations.jsonl"));
  const profiles = await readdir(join(fixture.root, ".worker-tmp/profiles"));
  assert.equal(await runChangedProfile(fixture, { AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: resolve(fixture.root, "missing-node") }), 1);
  assert.deepEqual(await readdir(join(fixture.root, ".worker-tmp/profiles")), profiles);
  await assert.rejects(readFile(join(fixture.root, "observations.jsonl")), { code: "ENOENT" });
});

void test("changed repository composition stops after an installation child is terminated", async (t) => {
  const fixture = await changedProfileFixture(t);
  assert.equal(await runChangedProfile(fixture, { C1_TEST_INSTALL_SIGNAL: "1" }), 143);
  assert.deepEqual((await fixture.observations()).map((entry) => entry.operation), ["install"]);
});

void test("changed repository composition refuses a linked profile parent before creating a target", async (t) => {
  const fixture = await changedProfileFixture(t);
  const foreign = join(fixture.root, "foreign-profiles");
  await mkdir(foreign);
  const profiles = join(fixture.root, ".worker-tmp/profiles");
  await rm(profiles, { recursive: true, force: true });
  await symlink(foreign, profiles, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await runChangedProfile(fixture), 1);
  assert.deepEqual(await readdir(foreign), []);
  await assert.rejects(readFile(join(fixture.root, "observations.jsonl")), { code: "ENOENT" });
});

void test("changed repository composition forwards cancellation and never starts check", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const fixture = await changedProfileFixture(t);
  const child = spawn(process.execPath, [fixture.entry], {
    cwd: fixture.root, env: { ...fixture.environment, C1_TEST_WAIT_FOR_SIGNAL: "1" }, stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => { child.kill("SIGKILL"); });
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    if (text.includes("ready")) { child.kill("SIGTERM"); }
  });
  const code = await new Promise<number | null>((_resolve, reject) => {
    child.once("error", reject);
    child.once("exit", _resolve);
  });
  assert.equal(code, 143);
  assert.deepEqual((await fixture.observations()).map((entry) => entry.operation), ["install"]);
});

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
