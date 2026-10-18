import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  assertPnpmProfileQualificationRoot,
  projectPackageManager,
  sourceTreeDigest
} from "../tools/dev.mts";
import { projectNodeAgentWorkflowPolicy } from "../tools/runtime-policy.mts";
import { refreshVersionLocks } from "../tools/release-profile.mts";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  ".github/workflows/npm-package-bootstrap.yml",
  ".github/workflows/public-managed-registry-canary.yml"
] as const;
const changesetsActionRevision = "a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d";
const pnpmSetupRevision = "pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b";

type WorkflowStep = {
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly name?: string;
  readonly env?: Record<string, unknown>;
  readonly run?: string;
  readonly "working-directory"?: string;
};
type WorkflowJob = { readonly if?: string; readonly steps?: WorkflowStep[] };
type Workflow = { readonly jobs?: Record<string, WorkflowJob> };
type BootstrapAdmission = {
  readonly enabled: boolean;
  readonly operation: "bootstrap" | "quarantine";
  readonly ref: string;
  readonly sourceSha: string;
  readonly expectedCommit: string;
};

function sha256(source: Buffer | string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function readPinnedChangesetsActionSource(file: "run" | "git"): Promise<string> {
  const expectedSha256 = {
    run: "6b609dc089c32327bbce7d899f663baad0327d2f52c5bd60926bac07c213cd95",
    git: "374b56c160d141d011b7dbfbdd98548d7e6cfe1e769e581768e36e0371727f4b"
  }[file];
  const response = await fetch(
    `https://raw.githubusercontent.com/changesets/action/${changesetsActionRevision}/src/${file}.ts`,
    { signal: AbortSignal.timeout(30_000) }
  );
  assert.equal(response.status, 200, `Pinned Changesets action src/${file}.ts is unavailable.`);
  const source = Buffer.from(await response.arrayBuffer());
  assert.equal(sha256(source), expectedSha256, `Pinned Changesets action src/${file}.ts digest drifted.`);
  return source.toString("utf8");
}

function allSteps(workflow: Workflow): WorkflowStep[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function bootstrapAdmission(
  job: "bootstrap" | "reconcile-github",
  admission: BootstrapAdmission
): boolean {
  const admitted =
    admission.enabled &&
    admission.ref === "refs/heads/main" &&
    admission.sourceSha === admission.expectedCommit;
  return admitted && (job === "bootstrap" || admission.operation === "bootstrap");
}

test("all four workflows provision every native pnpm setup at exact 11.20.0", async () => {
  let total = 0;
  for (const path of workflowPaths) {
    const workflow = parseYaml(await readFile(join(repositoryRoot, path), "utf8")) as Workflow;
    const setups = allSteps(workflow).filter((step) => step.uses?.startsWith("pnpm/setup@"));
    assert.ok(setups.length > 0, `${path} must retain its pinned native pnpm setup`);
    for (const setup of setups) {
      total += 1;
      assert.equal(setup.uses, pnpmSetupRevision);
      assert.equal(setup.with?.version, "11.20.0");
      assert.equal(setup.with?.install, false);
    }
  }
  assert.equal(total, 22);
});

test("bootstrap and reconciliation reject a source SHA mismatch before effects", async () => {
  const source = await readFile(
    join(repositoryRoot, ".github/workflows/npm-package-bootstrap.yml"),
    "utf8"
  );
  const workflow = parseYaml(source) as Workflow & {
    readonly jobs: Record<string, WorkflowJob & { readonly if?: string; readonly steps: WorkflowStep[] }>;
  };
  const bootstrap = workflow.jobs["bootstrap"];
  const reconcile = workflow.jobs["reconcile-github"];
  assert.ok(bootstrap);
  assert.ok(reconcile);
  const bootstrapIf =
    "${{ vars.NPM_PACKAGE_BOOTSTRAP_ENABLED == \x27true\x27 && github.ref == \x27refs/heads/main\x27 && github.sha == inputs.expected_commit }}";
  const reconcileIf =
    "${{ vars.NPM_PACKAGE_BOOTSTRAP_ENABLED == \x27true\x27 && inputs.operation == \x27bootstrap\x27 && github.ref == \x27refs/heads/main\x27 && github.sha == inputs.expected_commit }}";
  assert.equal(bootstrap.if, bootstrapIf);
  assert.equal(reconcile.if, reconcileIf);
  const checkout = bootstrap.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout?.with?.ref, "${{ inputs.expected_commit }}");
  const sourceAuthority = bootstrap.steps.find((step) =>
    "name" in step && step.name === "Bind explicit source Git authority"
  );
  assert.ok(sourceAuthority);
  assert.match(String(sourceAuthority.run), /GIT_DIR=.*GIT_WORK_TREE=.*GIT_CEILING_DIRECTORIES=/su);
  const profileInstall = bootstrap.steps.find((step) =>
    "name" in step && step.name === "Install the clean Node/pnpm package-operation projection"
  );
  assert.equal(
    profileInstall?.env?.["AGENT_TEAMS_FOUNDATION_SOURCE_SHA"],
    "${{ inputs.expected_commit }}"
  );
  for (const step of bootstrap.steps) {
    const profileRoot = step["working-directory"];
    if (typeof profileRoot !== "string" && profileRoot !== undefined) {
      throw new Error("Bootstrap working-directory must be a string.");
    }
    if (profileRoot?.includes(".worker-tmp/profiles/node-") === true) {
      assert.equal(profileRoot, ".worker-tmp/profiles/node-${{ inputs.expected_commit }}");
    }
  }
  assert.match(source, /test "\$\(git rev-parse HEAD\)" = "\$\{EXPECTED_COMMIT\}"/u);
  assert.match(source, /test "\$\(git rev-parse origin\/main\)" = "\$\{EXPECTED_COMMIT\}"/u);
  assert.doesNotMatch(source, /profiles\/node-\$\{\{ github\.sha \}\}/u);

  const expectedCommit = "a".repeat(40);
  const matching: BootstrapAdmission = {
    enabled: true,
    operation: "bootstrap",
    ref: "refs/heads/main",
    sourceSha: expectedCommit,
    expectedCommit
  };
  assert.equal(bootstrapAdmission("bootstrap", matching), true);
  assert.equal(bootstrapAdmission("reconcile-github", matching), true);
  assert.equal(
    bootstrapAdmission("bootstrap", {
      ...matching,
      operation: "quarantine"
    }),
    true
  );
  assert.equal(
    bootstrapAdmission("reconcile-github", {
      ...matching,
      operation: "quarantine"
    }),
    false
  );
  for (const mismatch of [
    { enabled: false },
    { ref: "refs/heads/feature/test" },
    { sourceSha: "b".repeat(40) }
  ] as const) {
    const admission = { ...matching, ...mismatch };
    assert.equal(bootstrapAdmission("bootstrap", admission), false);
    assert.equal(bootstrapAdmission("reconcile-github", admission), false);
  }
});

test("public canary keeps builder Node 26 separate from selected public cohort Node", async () => {
  const source = await readFile(
    join(repositoryRoot, ".github/workflows/public-managed-registry-canary.yml"),
    "utf8"
  );
  const builderNode = source.indexOf("node-version: \"26.11.1\"");
  const profileInstall = source.indexOf("node tools/dev.mts --profile node install");
  const profileBuild = source.indexOf("node tools/dev.mts --profile node build");
  const selectedNode = source.indexOf("node-version: ${{ steps.select-cohort-runtime.outputs.node }}");
  const selectedCapture = source.indexOf("PUBLIC_CANARY_NODE_EXECUTABLE=");
  const canaryRun = source.indexOf("\"${PUBLIC_CANARY_NODE_EXECUTABLE}\" scripts/public-managed-registry-canary.mjs");
  assert.ok(builderNode >= 0 && profileInstall > builderNode && profileBuild > profileInstall);
  assert.ok(selectedNode > profileBuild && selectedCapture > selectedNode && canaryRun > selectedCapture);
  assert.doesNotMatch(source, /(?:bun|node) scripts\/public-managed-registry-canary\.mjs/u);
  assert.doesNotMatch(source, /cache: pnpm/u);
  assert.doesNotMatch(source, /npm\s+(?:publish|unpublish|deprecate|dist-tag)|pnpm\s+publish/u);
});

test("Node profile qualification requires a real virtual store outside lock refresh", async () => {
  await mkdir(join(repositoryRoot, ".worker-tmp"), { recursive: true });
  const temporary = await mkdtemp(join(repositoryRoot, ".worker-tmp/profile-qualification-"));
  const sourceRoot = join(temporary, "source");
  const profileRoot = join(temporary, "profile");
  try {
    await mkdir(join(sourceRoot, "architecture/foundation"), { recursive: true });
    await mkdir(join(profileRoot, "architecture/foundation"), { recursive: true });
    const manifest = `${JSON.stringify({
      name: "release-profile-TEST",
      private: true,
      packageManager: "bun@1.4.3",
      workspaces: { packages: ["packages/*"], catalog: {}, catalogs: {} },
      catalog: {},
      catalogs: {},
      overrides: {}
    }, null, 2)}\n`;
    const policy = `${JSON.stringify({
      schemaVersion: 1,
      defaultProfile: "bun",
      profiles: {
        bun: { manager: "bun", runtime: "bun" },
        node: { manager: "pnpm", runtime: "node" }
      },
      toolchain: {
        bun: { version: "1.4.3", linuxX64ArchiveSha256: "a".repeat(64) },
        node: { version: "26.11.1" },
        pnpm: { version: "11.20.0" }
      },
      install: { dependencyScripts: false, nativeInitialization: [], disabledDependencyScripts: [] }
    }, null, 2)}\n`;
    await writeFile(join(sourceRoot, "package.json"), manifest);
    await writeFile(join(sourceRoot, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\ncatalog:\ncatalogs:\noverrides:\n");
    await writeFile(join(sourceRoot, "architecture/foundation/repository-runtime.json"), policy);
    await writeFile(join(profileRoot, "architecture/foundation/repository-runtime.json"), policy);
    const workflowPath = "architecture/foundation/repository-agent-workflow.yaml";
    const workflow = await readFile(join(repositoryRoot, workflowPath), "utf8");
    const projectedWorkflow = projectNodeAgentWorkflowPolicy(workflow);
    await writeFile(join(sourceRoot, workflowPath), workflow);
    await writeFile(join(profileRoot, workflowPath), projectedWorkflow);
    const derived = projectPackageManager(manifest, "pnpm@11.20.0");
    await writeFile(join(profileRoot, "package.json"), derived);
    const evidence = {
      profile: "node",
      sourceSha: "a".repeat(40),
      sourceDigest: await sourceTreeDigest(sourceRoot),
      originalManifestSha256: sha256(manifest),
      derivedManifestSha256: sha256(derived),
      originalWorkflowPolicySha256: sha256(workflow),
      derivedWorkflowPolicySha256: sha256(projectedWorkflow)
    };
    await writeFile(join(profileRoot, ".agent-teams-runtime-profile.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    await assert.rejects(
      assertPnpmProfileQualificationRoot(profileRoot, sourceRoot),
      /actual pnpm virtual store/u
    );
    await assertPnpmProfileQualificationRoot(profileRoot, sourceRoot, false);
    await mkdir(join(profileRoot, "node_modules/.pnpm"), { recursive: true });
    await writeFile(join(profileRoot, "node_modules/.pnpm/lock.yaml"), "lockfileVersion: '9.0'\n");
    await assertPnpmProfileQualificationRoot(profileRoot, sourceRoot);
    await writeFile(join(sourceRoot, "source-marker"), "stale source evidence must fail\n");
    await assert.rejects(
      assertPnpmProfileQualificationRoot(profileRoot, sourceRoot, false),
      /source digest evidence is stale/u
    );
    await writeFile(join(sourceRoot, "source-marker"), "");
    await rm(join(sourceRoot, "source-marker"));
    await writeFile(join(profileRoot, "package.json"), manifest);
    await assert.rejects(
      assertPnpmProfileQualificationRoot(profileRoot, sourceRoot),
      /exact private pnpm profile projection/u
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const releaseHelper = await readFile(join(repositoryRoot, "tools/release-profile.mts"), "utf8");
  const devHelper = await readFile(join(repositoryRoot, "tools/dev.mts"), "utf8");
  assert.match(devHelper, /requireVirtualStore: boolean = true/u);
  assert.equal((releaseHelper.match(/assertPnpmProfileQualificationRoot\([^;]+false\)/gu) ?? []).length, 1);
  assert.match(releaseHelper, /async function refreshVersionLocks[\s\S]*assertPnpmProfileQualificationRoot\([^;]+false\)/u);
});

test("actual pinned Changesets TEST versioning refreshes both authoritative locks", async (context) => {
  if (process.env["AGENT_TEAMS_FOUNDATION_RUN_CHANGESETS_TEST"] !== "1") {
    context.skip("set AGENT_TEAMS_FOUNDATION_RUN_CHANGESETS_TEST=1 for the finite external TEST");
    return;
  }
  const bunCandidate = process.env["AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE"] ?? "bun";
  const bunVersion = spawnSync(bunCandidate, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (bunVersion.error !== undefined || bunVersion.status !== 0 || bunVersion.stdout.trim() !== "1.4.3") {
    context.skip("admitted Bun 1.4.3 is unavailable");
    return;
  }
  const releaseWorkflow = parseYaml(await readFile(
    join(repositoryRoot, ".github/workflows/release.yml"), "utf8"
  )) as Workflow;
  assert.equal(
    allSteps(releaseWorkflow).find((step) => step.uses?.startsWith("changesets/action@"))?.uses,
    `changesets/action@${changesetsActionRevision}`
  );
  const [runSource, gitSource] = await Promise.all([
    readPinnedChangesetsActionSource("run"),
    readPinnedChangesetsActionSource("git")
  ]);
  await mkdir(join(repositoryRoot, ".worker-tmp"), { recursive: true });
  const temporary = await mkdtemp(join(repositoryRoot, ".worker-tmp/changesets-TEST-"));
  const root = join(temporary, "source");
  const cache = join(temporary, "cache");
  const originalEnvironment = {
    BUN_INSTALL_CACHE_DIR: process.env["BUN_INSTALL_CACHE_DIR"],
    XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"],
    npm_config_cache: process.env["npm_config_cache"],
    npm_config_store_dir: process.env["npm_config_store_dir"],
    AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT: process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"]
  };
  try {
    await mkdir(join(root, "packages/pkg-a"), { recursive: true });
    await mkdir(join(root, ".changeset"), { recursive: true });
    await mkdir(join(root, "architecture/foundation"), { recursive: true });
    const workflowPolicyPath = "architecture/foundation/repository-agent-workflow.yaml";
    await copyFile(join(repositoryRoot, workflowPolicyPath), join(root, workflowPolicyPath));
    await mkdir(join(cache, "pnpm-tool"), { recursive: true });
    process.env["BUN_INSTALL_CACHE_DIR"] = join(cache, "bun");
    process.env["XDG_CACHE_HOME"] = join(cache, "xdg");
    process.env["npm_config_cache"] = join(cache, "npm");
    process.env["npm_config_store_dir"] = join(cache, "pnpm-store");
    await writeFile(join(cache, "pnpm-tool/package.json"), `${JSON.stringify({
      name: "pnpm-TEST-tool",
      private: true,
      packageManager: "bun@1.4.3",
      dependencies: { pnpm: "11.20.0" }
    }, null, 2)}\n`);
    const toolInstall = spawnSync(bunCandidate, ["install", "--ignore-scripts", "--linker=isolated"], {
      cwd: join(cache, "pnpm-tool"), encoding: "utf8", env: process.env
    });
    assert.equal(toolInstall.status, 0, `${toolInstall.stdout}${toolInstall.stderr}`);
    const pnpmToolLock = await readFile(join(cache, "pnpm-tool/bun.lock"), "utf8");
    const pnpmSri = /"pnpm": \["pnpm@11\.20\.0"[^\n]+(sha512-[A-Za-z0-9+/=]+)/u.exec(pnpmToolLock)?.[1];
    assert.ok(pnpmSri);
    context.diagnostic(`TEST pnpm 11.20.0 SRI: ${pnpmSri}`);
    const pnpm = join(cache, "pnpm-tool/node_modules/pnpm/bin/pnpm.mjs");
    process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"] = pnpm;
    const manifest = `${JSON.stringify({
      name: "release-runtime-TEST",
      private: true,
      type: "module",
      packageManager: "bun@1.4.3",
      workspaces: { packages: ["packages/*"], catalog: {}, catalogs: {} },
      catalog: {},
      catalogs: {},
      overrides: {},
      devDependencies: { "@changesets/cli": "2.31.1" }
    }, null, 2)}\n`;
    await writeFile(join(root, "package.json"), manifest);
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\ncatalog:\ncatalogs:\noverrides:\n");
    await writeFile(join(root, "architecture/foundation/repository-runtime.json"), `${JSON.stringify({
      schemaVersion: 1,
      defaultProfile: "bun",
      profiles: {
        bun: { manager: "bun", runtime: "bun" },
        node: { manager: "pnpm", runtime: "node" }
      },
      toolchain: {
        bun: { version: "1.4.3", linuxX64ArchiveSha256: "a".repeat(64) },
        node: { version: "26.11.1" },
        pnpm: { version: "11.20.0" }
      },
      install: { dependencyScripts: false, nativeInitialization: [], disabledDependencyScripts: [] }
    }, null, 2)}\n`);
    await writeFile(join(root, "packages/pkg-a/package.json"), `${JSON.stringify({
      name: "pkg-a", version: "1.0.0"
    }, null, 2)}\n`);
    await writeFile(join(root, "packages/pkg-a/CHANGELOG.md"), "# pkg-a\n");
    await writeFile(join(root, ".changeset/config.json"), `${JSON.stringify({
      changelog: false,
      commit: false,
      fixed: [],
      access: "public",
      baseBranch: "main",
      updateInternalDependencies: "patch",
      ignore: [],
      privatePackages: { version: true, tag: false }
    }, null, 2)}\n`);
    const bunLockSeed = join(cache, "bun-lock-seed");
    const pnpmLockSeed = join(cache, "pnpm-lock-seed");
    await mkdir(join(bunLockSeed, "packages/pkg-a"), { recursive: true });
    await mkdir(join(pnpmLockSeed, "packages/pkg-a"), { recursive: true });
    for (const seed of [bunLockSeed, pnpmLockSeed]) {
      await copyFile(join(root, "package.json"), join(seed, "package.json"));
      await copyFile(join(root, "pnpm-workspace.yaml"), join(seed, "pnpm-workspace.yaml"));
      await copyFile(join(root, "packages/pkg-a/package.json"), join(seed, "packages/pkg-a/package.json"));
    }
    const seedManifest = JSON.parse(await readFile(join(pnpmLockSeed, "package.json"), "utf8")) as {
      packageManager: string;
    };
    seedManifest.packageManager = "pnpm@11.20.0";
    await writeFile(join(pnpmLockSeed, "package.json"), `${JSON.stringify(seedManifest, null, 2)}\n`);
    const seedPnpmLock = spawnSync(process.execPath, [
      join(repositoryRoot, "tools/pnpm-command.mts"),
      "install", "--lockfile-only", "--ignore-scripts", "--engine-strict"
    ], { cwd: pnpmLockSeed, encoding: "utf8", env: process.env });
    assert.equal(seedPnpmLock.status, 0, `${seedPnpmLock.stdout}${seedPnpmLock.stderr}`);
    await copyFile(join(pnpmLockSeed, "pnpm-lock.yaml"), join(root, "pnpm-lock.yaml"));
    const seedBunLock = spawnSync(bunCandidate, [
      "install", "--lockfile-only", "--ignore-scripts", "--linker=isolated"
    ], { cwd: bunLockSeed, encoding: "utf8", env: process.env });
    assert.equal(seedBunLock.status, 0, `${seedBunLock.stdout}${seedBunLock.stderr}`);
    await copyFile(join(bunLockSeed, "bun.lock"), join(root, "bun.lock"));
    const git = (args: readonly string[]): string => {
      const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      return result.stdout;
    };
    git(["init", "--quiet"]);
    git(["config", "user.name", "iliya"]);
    git(["config", "user.email", "iliyazelenkog@gmail.com"]);
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "test: initial release runtime fixture"]);
    const sourceSha = git(["rev-parse", "HEAD"]).trim();
    const initial = await refreshVersionLocks({
      sourceRoot: root,
      sourceSha,
      node: process.execPath,
      bun: bunCandidate
    });
    const install = spawnSync(bunCandidate, ["install", "--ignore-scripts", "--linker=isolated"], {
      cwd: root, encoding: "utf8", env: process.env
    });
    assert.equal(install.status, 0, `${install.stdout}${install.stderr}`);
    await writeFile(join(root, ".changeset/version.md"), [
      "---", "\"pkg-a\": minor", "---", "", "Actual pinned Changesets TEST version.", ""
    ].join("\n"));
    const version = spawnSync(process.execPath, ["node_modules/@changesets/cli/bin.js", "version"], {
      cwd: root, encoding: "utf8", env: process.env
    });
    assert.equal(version.status, 0, `${version.stdout}${version.stderr}`);
    const refreshed = await refreshVersionLocks({
      sourceRoot: root,
      sourceSha,
      node: process.execPath,
      bun: bunCandidate
    });
    const versioned = JSON.parse(await readFile(join(root, "packages/pkg-a/package.json"), "utf8")) as {
      readonly version: string;
    };
    assert.equal(versioned.version, "1.1.0");
    assert.notEqual(refreshed.bunLockSha256, initial.bunLockSha256);
    assert.match(refreshed.bunLockSha256, /^[a-f0-9]{64}$/u);
    assert.match(refreshed.pnpmLockSha256, /^[a-f0-9]{64}$/u);
    const bunLock = await readFile(join(root, "bun.lock"), "utf8");
    assert.match(bunLock, /"packages\/pkg-a": \{\s*"name": "pkg-a",\s*"version": "1\.1\.0"/u);
    const pnpmLock = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
    const changesetsSri = /['"]@changesets\/cli@2\.31\.1['"]:\s*\n\s+resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)/u
      .exec(pnpmLock)?.[1];
    assert.ok(changesetsSri);
    context.diagnostic(`TEST Changesets CLI 2.31.1 SRI: ${changesetsSri}`);
    const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      readonly packageManager: string;
    };
    assert.equal(rootManifest.packageManager, "bun@1.4.3");
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
});
