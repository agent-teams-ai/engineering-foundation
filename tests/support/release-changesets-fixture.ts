import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { refreshVersionLocks } from "../../tools/release-profile.mts";
import {
  checkWorkingReleaseCandidate,
  freezeReleaseCandidate,
} from "../../scripts/release-candidate-host.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const changesetsActionRevision = "a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d";
const packageRoot = "packages/engineering-foundation";
const packageName = "@agent-teams/engineering-foundation";
const standardRoot = "packages/feature-module-standard";
const standardName = "@agent-teams/feature-module-standard";
const standardManifest = {
  name: standardName,
  version: "0.1.0",
  devDependencies: { [packageName]: "workspace:*" },
  peerDependencies: { [packageName]: "workspace:^" },
  peerDependenciesMeta: { [packageName]: { optional: true } },
};

interface ReleaseFixture {
  readonly root: string;
  readonly sourceSha: string;
  readonly bunBefore: Buffer;
  readonly git: (args: readonly string[]) => string;
}

function sha256(source: Buffer | string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function readPinnedChangesetsActionSource(file: "run" | "git"): Promise<string> {
  const expectedSha256 = {
    run: "6b609dc089c32327bbce7d899f663baad0327d2f52c5bd60926bac07c213cd95",
    git: "374b56c160d141d011b7dbfbdd98548d7e6cfe1e769e581768e36e0371727f4b",
  }[file];
  const response = await fetch(
    `https://raw.githubusercontent.com/changesets/action/${changesetsActionRevision}/src/${file}.ts`,
    { signal: AbortSignal.timeout(30_000) },
  );
  assert.equal(response.status, 200, `Pinned Changesets action src/${file}.ts is unavailable.`);
  const source = Buffer.from(await response.arrayBuffer());
  assert.equal(
    sha256(source),
    expectedSha256,
    `Pinned Changesets action src/${file}.ts digest drifted.`,
  );
  return source.toString("utf8");
}

async function prepareReleaseFixture(
  temporary: string,
  bunCandidate: string,
  context: TestContext,
): Promise<ReleaseFixture> {
  const root = join(temporary, "source");
  const cache = join(temporary, "cache");
  await mkdir(join(root, packageRoot), { recursive: true });
  await mkdir(join(root, standardRoot), { recursive: true });
  await mkdir(join(root, ".changeset"), { recursive: true });
  await mkdir(join(root, "architecture/foundation"), { recursive: true });
  const workflowPolicyPath = "architecture/foundation/repository-agent-workflow.yaml";
  await copyFile(join(repositoryRoot, workflowPolicyPath), join(root, workflowPolicyPath));
  await copyFile(
    join(repositoryRoot, "architecture/foundation/dependency-declarations.yaml"),
    join(root, "architecture/foundation/dependency-declarations.yaml"),
  );
  await mkdir(join(cache, "pnpm-tool"), { recursive: true });
  process.env["BUN_INSTALL_CACHE_DIR"] = join(cache, "bun");
  process.env["XDG_CACHE_HOME"] = join(cache, "xdg");
  process.env["npm_config_cache"] = join(cache, "npm");
  process.env["npm_config_store_dir"] = join(cache, "pnpm-store");
  await writeFile(
    join(cache, "pnpm-tool/package.json"),
    `${JSON.stringify(
      {
        name: "pnpm-TEST-tool",
        private: true,
        packageManager: "bun@1.4.3",
        dependencies: { pnpm: "11.20.0" },
      },
      null,
      2,
    )}\n`,
  );
  const toolInstall = spawnSync(
    bunCandidate,
    ["install", "--ignore-scripts", "--linker=isolated"],
    {
      cwd: join(cache, "pnpm-tool"),
      encoding: "utf8",
      env: process.env,
    },
  );
  assert.equal(toolInstall.status, 0, `${toolInstall.stdout}${toolInstall.stderr}`);
  const pnpmToolLock = await readFile(join(cache, "pnpm-tool/bun.lock"), "utf8");
  const pnpmSri = /"pnpm": \["pnpm@11\.20\.0"[^\n]+(sha512-[A-Za-z0-9+/=]+)/u.exec(
    pnpmToolLock,
  )?.[1];
  assert.ok(pnpmSri !== undefined);
  context.diagnostic(`TEST pnpm 11.20.0 SRI: ${pnpmSri}`);
  const pnpm = join(cache, "pnpm-tool/node_modules/pnpm/bin/pnpm.mjs");
  process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"] = pnpm;
  const manifest = `${JSON.stringify(
    {
      name: "release-runtime-TEST",
      private: true,
      type: "module",
      packageManager: "bun@1.4.3",
      workspaces: { packages: ["packages/*"], catalog: {}, catalogs: {} },
      catalog: {},
      catalogs: {},
      overrides: {},
      devDependencies: { "@changesets/cli": "2.31.1" },
    },
    null,
    2,
  )}\n`;
  await writeFile(join(root, "package.json"), manifest);
  await writeFile(join(root, ".gitignore"), "node_modules/\n.worker-tmp/\n");
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\ncatalog:\ncatalogs:\noverrides:\n',
  );
  await writeFile(
    join(root, "architecture/foundation/repository-runtime.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        defaultProfile: "bun",
        profiles: {
          bun: { manager: "bun", runtime: "bun" },
          node: { manager: "pnpm", runtime: "node" },
        },
        toolchain: {
          bun: { version: "1.4.3", linuxX64ArchiveSha256: "a".repeat(64) },
          node: { version: "26.11.1" },
          pnpm: { version: "11.20.0" },
        },
        install: {
          dependencyScripts: false,
          nativeInitialization: [],
          disabledDependencyScripts: [],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(root, packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        version: "1.9.0",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, packageRoot, "CHANGELOG.md"), `# ${packageName}\n\n`);
  await writeFile(
    join(root, standardRoot, "package.json"),
    `${JSON.stringify(standardManifest, null, 2)}\n`,
  );
  await writeFile(join(root, standardRoot, "CHANGELOG.md"), `# ${standardName}\n\n`);
  await writeFile(
    join(root, ".changeset/config.json"),
    `${JSON.stringify(
      {
        changelog: "@changesets/cli/changelog",
        commit: false,
        fixed: [],
        access: "public",
        baseBranch: "main",
        updateInternalDependencies: "patch",
        ignore: [],
        ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH: {
          onlyUpdatePeerDependentsWhenOutOfRange: true,
        },
        privatePackages: { version: true, tag: false },
      },
      null,
      2,
    )}\n`,
  );
  const bunLockSeed = join(cache, "bun-lock-seed");
  const pnpmLockSeed = join(cache, "pnpm-lock-seed");
  await mkdir(join(bunLockSeed, packageRoot), { recursive: true });
  await mkdir(join(pnpmLockSeed, packageRoot), { recursive: true });
  for (const seed of [bunLockSeed, pnpmLockSeed]) {
    await copyFile(join(root, "package.json"), join(seed, "package.json"));
    await copyFile(join(root, "pnpm-workspace.yaml"), join(seed, "pnpm-workspace.yaml"));
    await copyFile(
      join(root, packageRoot, "package.json"),
      join(seed, packageRoot, "package.json"),
    );
    await mkdir(join(seed, standardRoot), { recursive: true });
    await copyFile(
      join(root, standardRoot, "package.json"),
      join(seed, standardRoot, "package.json"),
    );
  }
  const seedManifest = JSON.parse(await readFile(join(pnpmLockSeed, "package.json"), "utf8")) as {
    packageManager: string;
  };
  seedManifest.packageManager = "pnpm@11.20.0";
  await writeFile(join(pnpmLockSeed, "package.json"), `${JSON.stringify(seedManifest, null, 2)}\n`);
  const seedPnpmLock = spawnSync(
    process.execPath,
    [
      join(repositoryRoot, "tools/pnpm-command.mts"),
      "install",
      "--lockfile-only",
      "--ignore-scripts",
      "--engine-strict",
    ],
    { cwd: pnpmLockSeed, encoding: "utf8", env: process.env },
  );
  assert.equal(seedPnpmLock.status, 0, `${seedPnpmLock.stdout}${seedPnpmLock.stderr}`);
  await copyFile(join(pnpmLockSeed, "pnpm-lock.yaml"), join(root, "pnpm-lock.yaml"));
  const seedBunLock = spawnSync(
    bunCandidate,
    ["install", "--lockfile-only", "--ignore-scripts", "--linker=isolated"],
    { cwd: bunLockSeed, encoding: "utf8", env: process.env },
  );
  assert.equal(seedBunLock.status, 0, `${seedBunLock.stdout}${seedBunLock.stderr}`);
  await copyFile(join(bunLockSeed, "bun.lock"), join(root, "bun.lock"));
  const bunBefore = await readFile(join(root, "bun.lock"));
  assert.match(
    bunBefore.toString("utf8"),
    /"peerDependencies": \{\s*"@agent-teams\/engineering-foundation": "workspace:\^"/u,
  );
  // Retain the authentic old lock while committing only the supported peer floor.
  await writeFile(
    join(root, standardRoot, "package.json"),
    `${JSON.stringify(
      {
        ...standardManifest,
        peerDependencies: { [packageName]: "workspace:^1.8.0" },
      },
      null,
      2,
    )}\n`,
  );
  const git = (args: readonly string[]): string => {
    const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    return result.stdout;
  };
  git(["init", "--quiet", "-b", "main"]);
  git(["config", "user.name", "iliya"]);
  git(["config", "user.email", "iliyazelenkog@gmail.com"]);
  await writeFile(
    join(root, ".changeset/version.md"),
    [
      "---",
      `"${packageName}": minor`,
      `"${standardName}": patch`,
      "---",
      "",
      "Actual pinned Changesets TEST version.",
      "",
    ].join("\n"),
  );
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "test: initial release runtime fixture"]);
  const sourceSha = git(["rev-parse", "HEAD"]).trim();
  return { root, sourceSha, bunBefore, git };
}

async function qualifyVersionedRelease(
  fixture: ReleaseFixture,
  bunCandidate: string,
  context: TestContext,
): Promise<void> {
  const { root, sourceSha, bunBefore, git } = fixture;
  const pnpmBefore = await readFile(join(root, "pnpm-lock.yaml"));
  const install = spawnSync(
    bunCandidate,
    ["install", "--frozen-lockfile", "--ignore-scripts", "--linker=isolated"],
    {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    },
  );
  assert.equal(install.status, 0, `${install.stdout}${install.stderr}`);
  assert.deepEqual(
    await readFile(join(root, "bun.lock")),
    bunBefore,
    "the frozen source install must preserve the authentic old peer lock precondition",
  );
  const candidate = await freezeReleaseCandidate(root, {
    nodeExecutable: process.execPath,
    cliEntrypoint: join(root, "node_modules/@changesets/cli/bin.js"),
  });
  const version = spawnSync(
    candidate.custody.installation.nodeExecutable,
    [candidate.custody.installation.entrypoint, "version"],
    {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    },
  );
  assert.equal(version.status, 0, `${version.stdout}${version.stderr}`);
  assert.equal((await checkWorkingReleaseCandidate(candidate)).report.outcome, "passed");
  const versionedStandard = JSON.parse(
    await readFile(join(root, standardRoot, "package.json"), "utf8"),
  ) as {
    readonly version: string;
    readonly peerDependencies: Readonly<Record<string, string>>;
  };
  context.diagnostic(`TEST versioned FMS peer: ${versionedStandard.peerDependencies[packageName]}`);
  const refreshed = await refreshVersionLocks({
    sourceRoot: root,
    sourceSha,
    node: process.execPath,
    bun: bunCandidate,
  }).finally(() => {
    context.diagnostic(`TEST versioned Bun lock diff:\n${git(["diff", "--", "bun.lock"])}`);
  });
  assert.equal(
    (await checkWorkingReleaseCandidate(candidate, { locksRefreshed: true })).report.outcome,
    "passed",
  );
  const versioned = JSON.parse(await readFile(join(root, packageRoot, "package.json"), "utf8")) as {
    readonly version: string;
  };
  assert.equal(versioned.version, "1.10.0");
  assert.equal(versionedStandard.version, "0.1.1");
  assert.equal(versionedStandard.peerDependencies[packageName], "workspace:^1.8.0");
  assert.notEqual(refreshed.bunLockSha256, sha256(bunBefore));
  assert.match(refreshed.bunLockSha256, /^[a-f0-9]{64}$/u);
  assert.match(refreshed.pnpmLockSha256, /^[a-f0-9]{64}$/u);
  const bunLock = await readFile(join(root, "bun.lock"), "utf8");
  assert.match(
    bunLock,
    /"packages\/engineering-foundation": \{\s*"name": "@agent-teams\/engineering-foundation",\s*"version": "1\.10\.0"/u,
  );
  assert.match(
    bunLock,
    /"packages\/feature-module-standard": \{\s*"name": "@agent-teams\/feature-module-standard",\s*"version": "0\.1\.1"/u,
  );
  assert.deepEqual(
    await readFile(join(root, "pnpm-lock.yaml")),
    pnpmBefore,
    "version-only workspace changes must not alter the pnpm graph or bytes",
  );
  assert.equal(refreshed.pnpmLockChanged, false);
  const pnpmLock = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  const changesetsSri =
    /['"]@changesets\/cli@2\.31\.1['"]:\s*\n\s+resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)/u.exec(
      pnpmLock,
    )?.[1];
  assert.ok(changesetsSri !== undefined);
  context.diagnostic(`TEST Changesets CLI 2.31.1 SRI: ${changesetsSri}`);
  const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    readonly packageManager: string;
  };
  assert.equal(rootManifest.packageManager, "bun@1.4.3");
  git(["add", "--all"]);
  git(["commit", "--quiet", "-m", "test: actual generated release"]);
  const headSha = git(["rev-parse", "HEAD"]).trim();
  const admit = (head: string) => {
    const changed = git(["diff", "--name-status", "--no-renames", sourceSha, head])
      .trim()
      .split("\n");
    const statuses: Readonly<Partial<Record<string, string>>> = {
      A: "added",
      D: "removed",
      M: "modified",
    };
    const files = changed.map((row) => {
      const [status = "", filename = ""] = row.split("\t");
      const mappedStatus = statuses[status];
      assert.ok(mappedStatus !== undefined && filename !== "");
      return { filename, status: mappedStatus };
    });
    return spawnSync(
      process.execPath,
      [
        join(repositoryRoot, "scripts/check-release-pr-files.mjs"),
        "--base",
        sourceSha,
        "--head",
        head,
      ],
      {
        cwd: root,
        input: JSON.stringify(files),
        encoding: "utf8",
        env: process.env,
      },
    );
  };
  const admitted = admit(headSha);
  assert.equal(admitted.status, 0, `${admitted.stdout}${admitted.stderr}`);
  assert.equal(admitted.stderr, "");
  const tampered = bunLock.replace(
    changesetsSri,
    `sha512-${"A".repeat(changesetsSri.length - "sha512-".length)}`,
  );
  assert.notEqual(
    tampered,
    bunLock,
    "the installed Changesets SRI must be present in the Bun graph",
  );
  await writeFile(join(root, "bun.lock"), tampered);
  git(["add", "bun.lock"]);
  git(["commit", "--quiet", "-m", "test: reject lock graph tampering"]);
  const refused = admit(git(["rev-parse", "HEAD"]).trim());
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /bun\.lock/u);
  context.diagnostic(
    "TEST final Git guard accepted the actual release and rejected forged Bun graph SRI.",
  );
}

export async function qualifyActualChangesetsRelease(
  bunCandidate: string,
  context: TestContext,
): Promise<void> {
  const releaseWorkflow = parseYaml(
    await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8"),
  ) as {
    readonly jobs?: Readonly<
      Record<string, { readonly steps?: readonly { readonly uses?: string }[] } | undefined>
    >;
  };
  const action = Object.values(releaseWorkflow.jobs ?? {})
    .flatMap((job) => job?.steps ?? [])
    .find((step) => step.uses?.startsWith("changesets/action@") === true);
  assert.equal(action?.uses, `changesets/action@${changesetsActionRevision}`);
  const [runSource, gitSource] = await Promise.all([
    readPinnedChangesetsActionSource("run"),
    readPinnedChangesetsActionSource("git"),
  ]);
  await mkdir(join(repositoryRoot, ".worker-tmp"), { recursive: true });
  const temporary = await mkdtemp(join(repositoryRoot, ".worker-tmp/changesets-TEST-"));
  const originalEnvironment = {
    BUN_INSTALL_CACHE_DIR: process.env["BUN_INSTALL_CACHE_DIR"],
    XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"],
    npm_config_cache: process.env["npm_config_cache"],
    npm_config_store_dir: process.env["npm_config_store_dir"],
    AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT: process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"],
    GIT_AUTHOR_NAME: process.env["GIT_AUTHOR_NAME"],
    GIT_AUTHOR_EMAIL: process.env["GIT_AUTHOR_EMAIL"],
    GIT_COMMITTER_NAME: process.env["GIT_COMMITTER_NAME"],
    GIT_COMMITTER_EMAIL: process.env["GIT_COMMITTER_EMAIL"],
  };
  try {
    process.env["GIT_AUTHOR_NAME"] = "iliya";
    process.env["GIT_AUTHOR_EMAIL"] = "iliyazelenkog@gmail.com";
    process.env["GIT_COMMITTER_NAME"] = "iliya";
    process.env["GIT_COMMITTER_EMAIL"] = "iliyazelenkog@gmail.com";
    const fixture = await prepareReleaseFixture(temporary, bunCandidate, context);
    await qualifyVersionedRelease(fixture, bunCandidate, context);
    const versionScript = runSource.indexOf("await exec(script, undefined, { cwd, env });");
    const changedPackages = runSource.indexOf("let changedPackages = await getChangedPackages");
    assert.ok(versionScript >= 0 && changedPackages > versionScript);
    assert.match(gitSource, /await exec\("git", \["add", "\."\]/u);
  } finally {
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(temporary, { recursive: true, force: true });
  }
}
