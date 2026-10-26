import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import {
  prepareProfileProjection,
  projectPackageManager,
  sourceTreeDigest,
} from "../../tools/dev.mts";
import { resolveQualificationExecutables } from "../../tools/executable-policy.mts";
import { resolvePnpmInvocation } from "../../tools/pnpm-command.mts";
import { assertExplicitSourceGitAuthority } from "../../tools/profile-root.mts";
import {
  projectNodeAgentWorkflowPolicy,
  projectNodeDependencyDeclarationsPolicy,
} from "../../tools/runtime-policy.mts";
import { repositorySourceRoot } from "./repository-source.ts";

function sha256(source: Buffer | string): string {
  return createHash("sha256").update(source).digest("hex");
}

export async function prepareProfileQualificationFixture(
  actualSourceRoot: string,
  sourceRoot: string,
  profileRoot: string,
) {
  await mkdir(join(sourceRoot, "architecture/foundation"), { recursive: true });
  await mkdir(join(profileRoot, "architecture/foundation"), { recursive: true });
  const manifest = `${JSON.stringify(
    {
      name: "release-profile-TEST",
      private: true,
      packageManager: "bun@1.4.3",
      workspaces: { packages: ["packages/*"], catalog: {}, catalogs: {} },
      catalog: {},
      catalogs: {},
      overrides: {},
    },
    null,
    2,
  )}\n`;
  const policy = `${JSON.stringify(
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
  )}\n`;
  await writeFile(join(sourceRoot, "package.json"), manifest);
  await writeFile(
    join(sourceRoot, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\ncatalogMode: strict\ncatalog: {}\ncatalogs: {}\noverrides:\n',
  );
  await copyFile(
    join(sourceRoot, "pnpm-workspace.yaml"),
    join(profileRoot, "pnpm-workspace.yaml"),
  );
  await writeFile(join(sourceRoot, "architecture/foundation/repository-runtime.json"), policy);
  await writeFile(join(profileRoot, "architecture/foundation/repository-runtime.json"), policy);
  const workflowPath = "architecture/foundation/repository-agent-workflow.yaml";
  const workflow = await readFile(join(actualSourceRoot, workflowPath), "utf8");
  const projectedWorkflow = projectNodeAgentWorkflowPolicy(workflow);
  await writeFile(join(sourceRoot, workflowPath), workflow);
  await writeFile(join(profileRoot, workflowPath), projectedWorkflow);
  const dependencyPath = "architecture/foundation/dependency-declarations.yaml";
  const dependencies = await readFile(join(actualSourceRoot, dependencyPath), "utf8");
  const projectedDependencies = projectNodeDependencyDeclarationsPolicy(dependencies);
  await writeFile(join(sourceRoot, dependencyPath), dependencies);
  await writeFile(join(profileRoot, dependencyPath), projectedDependencies);
  const derived = projectPackageManager(manifest, "pnpm@11.20.0");
  await writeFile(join(profileRoot, "package.json"), derived);
  const evidence = {
    profile: "node",
    sourceSha: "a".repeat(40),
    sourceDigest: await sourceTreeDigest(sourceRoot),
    originalManifestSha256: sha256(manifest),
    derivedManifestSha256: sha256(derived),
    originalWorkflowPolicySha256: sha256(workflow),
    derivedWorkflowPolicySha256: sha256(projectedWorkflow),
    originalDependencyDeclarationsPolicySha256: sha256(dependencies),
    derivedDependencyDeclarationsPolicySha256: sha256(projectedDependencies),
  };
  await writeFile(
    join(profileRoot, ".agent-teams-runtime-profile.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  return { manifest, policy, dependencyPath, dependencies, projectedDependencies, evidence };
}

async function packagePhaseSource(root: string): Promise<void> {
  const sourceRoot = await repositorySourceRoot();
  await mkdir(join(root, "architecture/foundation"), { recursive: true });
  await mkdir(join(root, ".worker-tmp/profiles"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "TEST-package-phase",
        private: true,
        version: "1.0.0",
        packageManager: "bun@1.4.3",
        workspaces: { packages: ["packages/*"], catalog: {}, catalogs: {} },
        catalog: {},
        catalogs: {},
        overrides: {},
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\ncatalog: {}\ncatalogs: {}\noverrides: {}\n',
  );
  for (const path of [
    "repository-agent-workflow.yaml",
    "dependency-declarations.yaml",
    "repository-runtime.json",
  ]) {
    await copyFile(
      join(sourceRoot, "architecture/foundation", path),
      join(root, "architecture/foundation", path),
    );
  }
}

export async function packagePhaseFixture(repositoryRoot: string) {
  const profiles = join(repositoryRoot, ".worker-tmp/profiles");
  await mkdir(profiles, { recursive: true });
  const parent = await mkdtemp(join(profiles, "package-phase-"));
  const sourceRoot = join(parent, "source");
  await packagePhaseSource(sourceRoot);
  await cp(join(repositoryRoot, "tools"), join(sourceRoot, "tools"), { recursive: true });
  const verifier = "packages/engineering-foundation/src/process-execution/node-runtime-verifier.ts";
  await mkdir(dirname(join(sourceRoot, verifier)), { recursive: true });
  await copyFile(join(repositoryRoot, verifier), join(sourceRoot, verifier));
  const compilerMarker = join(parent, "compiler-ran");
  const observation = join(parent, "phase.json");
  const manifestPath = join(sourceRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  await writeFile(
    manifestPath,
    JSON.stringify(
      { ...manifest, scripts: { "package:check:built": "node observe.cjs" } },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(sourceRoot, "observe.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(observation)}, JSON.stringify({cwd:process.cwd(),node:process.versions.node,profile:process.env.AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE}));`,
  );
  const gitEnvironment = {
    ...process.env,
    GIT_AUTHOR_NAME: "iliya",
    GIT_AUTHOR_EMAIL: "iliyazelenkog@gmail.com",
    GIT_COMMITTER_NAME: "iliya",
    GIT_COMMITTER_EMAIL: "iliyazelenkog@gmail.com",
  };
  for (const args of [
    ["init", "--initial-branch=main"],
    ["add", "."],
    ["commit", "-m", "test: package phase fixture"],
  ]) {
    if (args[0] === "commit") {
      for (const name of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
        const identity = spawnSync("git", ["var", name], {
          cwd: sourceRoot,
          env: gitEnvironment,
          encoding: "utf8",
        });
        assert.equal(identity.status, 0, identity.stderr);
        assert.match(identity.stdout, /^iliya <iliyazelenkog@gmail\.com> /u);
      }
    }
    const result = spawnSync("git", args, {
      cwd: sourceRoot,
      env: gitEnvironment,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const authority = await assertExplicitSourceGitAuthority(sourceRoot);
  const targetRoot = join(sourceRoot, `.worker-tmp/profiles/node-${authority.sourceCommit}`);
  await prepareProfileProjection({
    profile: "node",
    sourceRoot,
    targetRoot,
    sourceSha: authority.sourceCommit,
  });
  await mkdir(join(targetRoot, "node_modules/typescript/bin"), { recursive: true });
  await writeFile(
    join(targetRoot, "node_modules/typescript/bin/tsc"),
    `require("node:fs").writeFileSync(${JSON.stringify(compilerMarker)}, "compiler");`,
  );
  await mkdir(join(targetRoot, "node_modules/.pnpm"), { recursive: true });
  await writeFile(join(targetRoot, "node_modules/.pnpm/lock.yaml"), "lockfileVersion: '9.0'\n");
  const runtime = await resolveQualificationExecutables("bun");
  const nodeVersion = spawnSync(runtime.node, ["--version"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(nodeVersion.status, 0, nodeVersion.stderr);
  assert.equal(nodeVersion.signal, null);
  assert.match(nodeVersion.stdout, /^v\d+\.\d+\.\d+\r?\n?$/u);
  const manager = await resolvePnpmInvocation(runtime.node, "11.20.0");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: runtime.node,
    AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: runtime.bun,
    AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "bun",
    AGENT_TEAMS_FOUNDATION_PROFILE_ROOT: targetRoot,
    AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: sourceRoot,
    AGENT_TEAMS_FOUNDATION_SOURCE_SHA: authority.sourceCommit,
    AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT:
      manager.kind === "javascript" ? manager.args[0] : manager.command,
    pnpm_config_verify_deps_before_run: "false",
    PATH: `${dirname(runtime.node)}${delimiter}${process.env["PATH"] ?? ""}`,
  };
  return {
    parent,
    sourceRoot,
    targetRoot,
    compilerMarker,
    observation,
    environment,
    node: runtime.node,
    nodeVersion: nodeVersion.stdout.trim().slice(1),
  };
}
