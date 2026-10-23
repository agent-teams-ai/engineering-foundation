import { repositorySourceRoot } from "./repository-source.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertExplicitSourceGitAuthority } from "../../tools/profile-root.mts";
import { withoutGitRepositorySelectors } from "../../tools/git-environment.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function realLinkedGitFixture(t: TestContext) {
  const sourceRoot = await repositorySourceRoot();
  const parent = join(repositoryRoot, ".worker-tmp/profiles");
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, "TEST-git-authority-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "source");
  const cloned = spawnSync(
    "git",
    [
      "clone",
      "--quiet",
      "--no-checkout",
      "--depth=1",
      "--no-hardlinks",
      pathToFileURL(sourceRoot).href,
      root,
    ],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_COMMON_DIR: undefined,
      },
    },
  );
  assert.equal(cloned.status, 0, `${cloned.stdout}${cloned.stderr}`);
  const normal = await assertExplicitSourceGitAuthority(root);
  const gitDir = join(temporary, "git-directory");
  const marker = join(root, ".git");
  await rename(marker, gitDir);
  const markerSource = "gitdir: ../git-directory\n";
  await writeFile(marker, markerSource);
  return { root, marker, markerSource, gitDir, normal };
}

void test("Git source authority accepts physical directories and linked marker files but rejects aliases and oversized markers", async (t) => {
  const fixture = await realLinkedGitFixture(t);
  const linked = await assertExplicitSourceGitAuthority(fixture.root);
  assert.equal(linked.sourceCommit, fixture.normal.sourceCommit);
  assert.equal(linked.sourceRoot, fixture.normal.sourceRoot);
  assert.equal(linked.environment["GIT_OPTIONAL_LOCKS"], "0");
  await rm(fixture.marker);
  await symlink(fixture.gitDir, fixture.marker, "junction");
  await assert.rejects(
    assertExplicitSourceGitAuthority(fixture.root),
    /actual directory or regular file/u,
  );
  await rm(fixture.marker);
  await writeFile(fixture.marker, `${fixture.markerSource}${" ".repeat(8 * 1024)}`);
  await assert.rejects(assertExplicitSourceGitAuthority(fixture.root), /bounded size/u);
  if (process.platform !== "win32") {
    const aliasTarget = join(fixture.root, "retained-linked-marker");
    await writeFile(aliasTarget, fixture.markerSource);
    await rm(fixture.marker);
    await symlink(aliasTarget, fixture.marker, "file");
    await assert.rejects(
      assertExplicitSourceGitAuthority(fixture.root),
      /actual directory or regular file/u,
    );
    await rm(fixture.marker);
    const special = spawnSync("mkfifo", [fixture.marker], { encoding: "utf8", timeout: 10_000 });
    assert.equal(special.status, 0, `${special.stdout}${special.stderr}`);
    await assert.rejects(
      assertExplicitSourceGitAuthority(fixture.root),
      /actual directory or regular file/u,
    );
  }
});

void test("source Git authority ignores inherited repository/index/object/config selectors and preserves operator context", async (t) => {
  const fixture = await realLinkedGitFixture(t);
  const foreign = await realLinkedGitFixture(t);
  const index = join(foreign.root, "foreign-index");
  const global = join(foreign.root, "global-config");
  await writeFile(index, "foreign index must remain unchanged\n");
  await writeFile(global, "[foundation]\n\tcontext = retained\n");
  const subject = pathToFileURL(join(repositoryRoot, "tools/profile-root.mts")).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import { execFileSync } from "node:child_process";',
        `const { assertExplicitSourceGitAuthority } = await import(${JSON.stringify(subject)});`,
        `const a = await assertExplicitSourceGitAuthority(${JSON.stringify(fixture.root)});`,
        'const config = execFileSync("git", ["config", "--global", "foundation.context"], {cwd:a.sourceRoot,env:a.environment,encoding:"utf8"}).trim();',
        'process.stdout.write(JSON.stringify({root:a.sourceRoot,commit:a.sourceCommit,config,env:Object.fromEntries(["GIT_AUTHOR_NAME","GIT_COMMITTER_NAME","GIT_SSH_COMMAND","GIT_ASKPASS","GIT_CONFIG_GLOBAL","GIT_INDEX_FILE","GIT_CONFIG_COUNT"].map(k=>[k,a.environment[k]]))}));',
      ].join("\n"),
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        GIT_DIR: foreign.gitDir,
        GIT_COMMON_DIR: foreign.gitDir,
        GIT_WORK_TREE: foreign.root,
        GIT_INDEX_FILE: index,
        GIT_OBJECT_DIRECTORY: join(foreign.root, "missing-objects"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(foreign.root, "missing-alternates"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.worktree",
        GIT_CONFIG_VALUE_0: foreign.root,
        GIT_CONFIG_PARAMETERS: "'core.worktree=invalid'",
        GIT_CONFIG: global,
        GIT_CONFIG_GLOBAL: global,
        GIT_AUTHOR_NAME: "Retained author",
        GIT_COMMITTER_NAME: "Retained committer",
        GIT_SSH_COMMAND: "retained-transport",
        GIT_ASKPASS: "retained-askpass",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout) as {
    root: string;
    commit: string;
    config: string;
    env: NodeJS.ProcessEnv;
  };
  assert.equal(observed.root, fixture.root);
  assert.equal(observed.commit, fixture.normal.sourceCommit);
  assert.equal(observed.config, "retained");
  assert.equal(observed.env["GIT_AUTHOR_NAME"], "Retained author");
  assert.equal(observed.env["GIT_COMMITTER_NAME"], "Retained committer");
  assert.equal(observed.env["GIT_SSH_COMMAND"], "retained-transport");
  assert.equal(observed.env["GIT_ASKPASS"], "retained-askpass");
  assert.equal(observed.env["GIT_CONFIG_GLOBAL"], global);
  assert.equal(observed.env["GIT_INDEX_FILE"], undefined);
  assert.equal(observed.env["GIT_CONFIG_COUNT"], undefined);
  assert.equal(await readFile(index, "utf8"), "foreign index must remain unchanged\n");
  assert.deepEqual(
    withoutGitRepositorySelectors({
      GIT_CONFIG_KEY_93: "bad",
      GIT_CONFIG_VALUE_93: "bad",
      GIT_CONFIG_SYSTEM: "system",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_EXEC_PATH: "exec",
      GIT_TRACE: "trace",
    }),
    {
      GIT_CONFIG_SYSTEM: "system",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_EXEC_PATH: "exec",
      GIT_TRACE: "trace",
    },
  );
  const local = spawnSync("git", ["rev-parse", "--local-env-vars"], {
    cwd: fixture.root,
    encoding: "utf8",
  });
  assert.equal(local.status, 0, local.stderr);
  const localNames = local.stdout.trim().split(/\r?\n/u);
  const scrubbed = withoutGitRepositorySelectors(
    Object.fromEntries(localNames.map((key) => [key, "foreign"])),
  );
  for (const key of localNames) {
    assert.equal(scrubbed[key], undefined, key);
  }
  const lowerCase = withoutGitRepositorySelectors({
    git_dir: "foreign",
    git_author_name: "retained",
  });
  assert.equal(lowerCase["git_dir"], process.platform === "win32" ? undefined : "foreign");
  assert.equal(lowerCase["git_author_name"], "retained");
});

void test("dispatcher tool and script children own their cwd instead of inherited source Git selectors", async (t) => {
  const fixture = await realLinkedGitFixture(t);
  const foreign = await realLinkedGitFixture(t);
  const expectedRoot = await realpath(fixture.root);
  assert.notEqual(expectedRoot, await realpath(foreign.root));
  const observed = join(fixture.root, "child-git.json");
  const preload = join(fixture.root, "observe-child.mjs");
  const observer = [
    'import { writeFileSync } from "node:fs";',
    'import { execFileSync } from "node:child_process";',
    `writeFileSync(${JSON.stringify(observed)}, JSON.stringify({`,
    'root:execFileSync("git",["rev-parse","--show-toplevel"],{encoding:"utf8"}).trim(),',
    "index:process.env.GIT_INDEX_FILE,config:process.env.GIT_CONFIG_COUNT,",
    "author:process.env.GIT_AUTHOR_NAME,transport:process.env.GIT_SSH_COMMAND}));",
  ].join("\n");
  await writeFile(
    preload,
    `if (process.argv[1]?.endsWith("record-repository-runtime.mts")) { await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(observer)}`)}); }`,
  );
  await writeFile(join(fixture.root, "observe.mjs"), observer);
  await writeFile(
    join(fixture.root, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      packageManager: "pnpm@11.20.0",
      scripts: { check: "node observe.mjs" },
    }),
  );
  await writeFile(join(fixture.root, "pnpm-workspace.yaml"), "packages: []\n");
  const environment = {
    ...process.env,
    AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "node",
    AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath,
    AGENT_TEAMS_FOUNDATION_RUNTIME_OBSERVATION: join(fixture.root, "runtime.jsonl"),
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    GIT_DIR: foreign.gitDir,
    GIT_WORK_TREE: foreign.root,
    GIT_INDEX_FILE: join(foreign.root, "not-an-index"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.worktree",
    GIT_CONFIG_VALUE_0: foreign.root,
    GIT_AUTHOR_NAME: "Retained author",
    GIT_SSH_COMMAND: "retained-transport",
  };
  for (const args of [
    ["tool", "runtime-observe"],
    ["script", "check"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, "tools/repository-command.mts"), ...args],
      {
        cwd: fixture.root,
        env: environment,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const child = JSON.parse(await readFile(observed, "utf8")) as { readonly root: string };
    assert.deepEqual(
      { ...child, root: await realpath(child.root) },
      {
        root: expectedRoot,
        author: "Retained author",
        transport: "retained-transport",
      },
    );
    await rm(observed);
  }
});

void test("Node dispatcher routes changed checks to source Bun policy and source dependencies", async (t) => {
  const sourceRoot = await repositorySourceRoot();
  const fixture = await realLinkedGitFixture(t);
  const expectedRoot = await realpath(fixture.root);
  assert.notEqual(expectedRoot, await realpath(repositoryRoot));
  for (const file of ["package.json", "pnpm-workspace.yaml"]) {
    await copyFile(join(sourceRoot, file), join(fixture.root, file));
  }
  await symlink(join(sourceRoot, "node_modules"), join(fixture.root, "node_modules"), "junction");
  const entry = join(fixture.root, "packages/engineering-foundation/dist/cli.js");
  await mkdir(join(fixture.root, "packages/engineering-foundation/dist"), { recursive: true });
  await writeFile(
    entry,
    [
      'import { readFileSync } from "node:fs";',
      'import { execFileSync } from "node:child_process";',
      "process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),",
      "profile:process.env.AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE,bun:process.versions.bun,",
      'manager:JSON.parse(readFileSync("package.json","utf8")).packageManager,',
      'git:execFileSync("git",["rev-parse","--show-toplevel"],{encoding:"utf8"}).trim()}));',
    ].join("\n"),
  );
  for (const operation of ["tool", "script"]) {
    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, "tools/repository-command.mts"), operation, "check:changed"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "node",
          AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: fixture.root,
          AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath,
          GIT_DIR: join(repositoryRoot, ".git"),
          GIT_WORK_TREE: repositoryRoot,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const child = JSON.parse(result.stdout) as { readonly cwd: string; readonly git: string };
    assert.deepEqual(
      { ...child, cwd: await realpath(child.cwd), git: await realpath(child.git) },
      {
        cwd: expectedRoot,
        args: ["agent-workflow", "check-changed", "--consumer", "."],
        profile: "bun",
        bun: "1.4.3",
        manager: "bun@1.4.3",
        git: expectedRoot,
      },
    );
  }
  const rejected = spawnSync(
    process.execPath,
    [
      join(repositoryRoot, "tools/repository-command.mts"),
      "tool",
      "check:changed",
      "--paths",
      "unowned",
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /does not accept extra arguments/u);
  assert.equal(rejected.stdout, "");
});

void test("Git source authority rejects a real marker inode replacement between metadata and read", async (t) => {
  const fixture = await realLinkedGitFixture(t);
  const helper = pathToFileURL(
    join(repositoryRoot, "tests/support/swap-git-marker-before-open.mts"),
  ).href;
  const subject = pathToFileURL(join(repositoryRoot, "tools/profile-root.mts")).href;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      helper,
      "--input-type=module",
      "--eval",
      `const { assertExplicitSourceGitAuthority } = await import(${JSON.stringify(subject)}); ` +
        `await assertExplicitSourceGitAuthority(${JSON.stringify(fixture.root)});`,
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        TEST_GIT_MARKER_TO_SWAP: fixture.marker,
        TEST_GIT_MARKER_SOURCE: fixture.markerSource,
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(
    result.status,
    1,
    "The replaced marker must not qualify as stable Git source authority",
  );
  assert.match(result.stderr, /Source authority \.git marker changed/u);
  assert.equal(
    await readFile(`${fixture.marker}.retained-before-race`, "utf8"),
    fixture.markerSource,
  );
  assert.equal(await readFile(fixture.marker, "utf8"), fixture.markerSource);
});
