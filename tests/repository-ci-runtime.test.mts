import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { nativeMergeProfile } from "../scripts/merge-reviewed-pr.mts";
import {
  assertExplicitSourceGitAuthority,
  assertCompatibilityNodeExecutable,
  assertPnpmProfileQualificationRoot,
  prepareProfileProjection,
  projectPackageManager
} from "../tools/dev.mts";
import { pnpmPortableName, resolvePnpmInvocation } from "../tools/pnpm-command.mts";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceSha = "a".repeat(40);
const pnpmSetup = "pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b";

async function ownedTemporaryRoot(prefix: string): Promise<string> {
  const parent = join(repositoryRoot, ".worker-tmp/profiles");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}

interface Workflow {
  readonly jobs: Record<string, {
    readonly env?: Record<string, string>;
    readonly steps: readonly Record<string, unknown>[];
    readonly strategy?: { readonly matrix?: Record<string, readonly unknown[]> };
  }>;
}

async function workflow(name: string): Promise<Workflow> {
  return parseYaml(await readFile(join(repositoryRoot, ".github/workflows", name), "utf8")) as Workflow;
}

function runs(step: Record<string, unknown>, command: string): boolean {
  return step["run"] === command;
}

function stepWith(step: Record<string, unknown>): Record<string, unknown> {
  return (step["with"] ?? {}) as Record<string, unknown>;
}

function expandedJobIds(current: Workflow): readonly string[] {
  const result: string[] = [];
  for (const [id, job] of Object.entries(current.jobs)) {
    if (id === "shadow-classifier") {
      continue;
    }
    const matrix = job.strategy?.matrix;
    if (id === "node26-compatibility") {
      const lanes = matrix?.["include"] as readonly { lane: string }[] | undefined;
      assert.ok(lanes);
      result.push(...lanes.map(({ lane }) => `node-compatibility (${lane})`));
    } else if (id === "linux-tests") {
      const pairs = matrix?.["pair"] as readonly { first: string; second: string }[] | undefined;
      assert.ok(pairs);
      result.push(...pairs.map(({ first, second }) => `linux-tests-${first}-${second}`));
    } else if (id === "windows-package" || id === "windows-registry") {
      const groups = matrix?.["group"] as readonly string[] | undefined;
      assert.ok(groups);
      result.push(...groups.map(group => `${id} (${group})`));
    } else if (id === "macos-package") {
      const profiles = matrix?.["profile"] as readonly string[] | undefined;
      assert.ok(profiles);
      result.push(...profiles.map(profile => `${id} (${profile})`));
    } else {
      result.push(id);
    }
  }
  return result.toSorted();
}

test("the ordinary CI topology preserves the typed 34-job native authority", async () => {
  const current = await workflow("ci.yml");
  assert.deepEqual(expandedJobIds(current), [...nativeMergeProfile.jobs].toSorted());
  assert.equal(expandedJobIds(current).length, 34);
});

test("retained pnpm authority is explicitly provisioned beside isolated Bun graphs", async () => {
  const current = await workflow("ci.yml");
  const pnpmJobs = [
    "node26-compatibility", "linux-static", "linux-tests", "linux-coverage",
    "linux-package", "linux-registry", "linux-published", "windows-static",
    "windows-test-a", "windows-test-b", "windows-test-c", "windows-test-d",
    "windows-test-e", "windows-package", "windows-registry", "windows-published",
    "macos-native", "macos-package"
  ];
  for (const id of pnpmJobs) {
    const setup = current.jobs[id]?.steps.find(step =>
      typeof step["uses"] === "string" && step["uses"].startsWith("pnpm/setup@"));
    assert.equal(setup?.["uses"], pnpmSetup, id);
    assert.deepEqual(setup?.["with"], { version: "11.20.0", install: false }, id);
  }
  for (const id of ["linux-tests", "linux-coverage", "linux-static", "windows-static",
    "windows-test-a", "windows-test-b", "windows-test-c", "windows-test-d",
    "windows-test-e", "macos-native"]) {
    const steps = current.jobs[id]?.steps ?? [];
    assert.equal(steps.some(step => stepWith(step)["cache"] === "pnpm"), false, id);
  }
  assert.equal(Object.values(current.jobs).some(job =>
    job.steps.some(step => stepWith(step)["cache"] === "pnpm")), false);
});

test("native pnpm setup output is consumed through exact portable manager paths", async () => {
  const current = await workflow("ci.yml");
  const projectedJobs = [
    "node26-compatibility", "linux-package", "linux-registry", "linux-published",
    "linux-bootstrap-evidence", "windows-package", "windows-registry",
    "windows-published", "macos-package"
  ];
  const expectedEntry = "${{ steps.setup-pnpm.outputs.bin-dest }}/pnpm${{ runner.os == 'Windows' && '.exe' || '' }}";
  const source = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  assert.doesNotMatch(source, /\$\{\{[^}\n]*runner\.os == "Windows"[^}\n]*\}\}/u);
  for (const id of projectedJobs) {
    const steps = current.jobs[id]?.steps ?? [];
    const setup = steps.find(step => step["id"] === "setup-pnpm");
    assert.equal(setup?.["uses"], pnpmSetup, id);
    assert.deepEqual(setup?.["with"], { version: "11.20.0", install: false }, id);
    const install = steps.find(step =>
      typeof step["run"] === "string" && step["run"].includes("tools/dev.mts --profile node install"));
    assert.equal((install?.["env"] as Record<string, string> | undefined)?.[
      "AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"], expectedEntry, id);
  }
  assert.equal(pnpmPortableName("linux"), "pnpm");
  assert.equal(pnpmPortableName("win32"), "pnpm.exe");
});

test("portable native manager fixtures reject wrong versions before operations", async () => {
  if (process.platform === "win32") {
    return;
  }
  const parent = await ownedTemporaryRoot("pnpm-native-");
  const bin = join(parent, "bin");
  const wrongBin = join(parent, "wrong-bin");
  try {
    await Promise.all([mkdir(bin), mkdir(wrongBin)]);
    const fixture = (version: string): string =>
      `#!${process.execPath}\n` +
      "const args = process.argv.slice(2);\n" +
      `if (args.includes("--version")) process.stdout.write("${version}" + String.fromCharCode(10));\n`;
    const path = join(bin, pnpmPortableName());
    await writeFile(path, fixture("11.20.0"), "utf8");
    await chmod(path, 0o755);
    process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"] = path;
    const invocation = await resolvePnpmInvocation(process.execPath, "11.20.0");
    assert.equal(invocation.kind, "native");
    assert.equal(invocation.command, await realpath(path));
    const wrong = join(wrongBin, "pnpm");
    await writeFile(wrong, fixture("99.0.0"), "utf8");
    await chmod(wrong, 0o755);
    process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"] = wrong;
    await assert.rejects(resolvePnpmInvocation(process.execPath, "11.20.0"), /not pnpm 11\.20\.0/u);
  } finally {
    delete process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"];
    await rm(parent, { recursive: true, force: true });
  }
});

test("projected qualification binds Git source authority instead of repository ascent", async () => {
  const authority = await assertExplicitSourceGitAuthority(repositoryRoot);
  assert.match(authority.sourceCommit, /^[0-9a-f]{40}$/u);
  const parent = await ownedTemporaryRoot("source-authority-");
  const projection = join(parent, "projection");
  try {
    await mkdir(projection);
    const observed = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: projection,
      encoding: "utf8",
      env: { ...process.env, ...authority.environment }
    });
    assert.equal(observed.status, 0, `${observed.stdout}${observed.stderr}`);
    assert.equal(await realpath(observed.stdout.trim()), authority.sourceRoot);
    await assert.rejects(
      assertExplicitSourceGitAuthority(projection),
      /explicit repository \.git marker/u
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Node compatibility and package qualification execute in the private pnpm projection", async () => {
  const current = await workflow("ci.yml");
  const compatibility = current.jobs["node26-compatibility"]!;
  assert.equal(compatibility.env?.["AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE"], "node");
  const qualification = compatibility.steps.find(step =>
    runs(step, "pnpm node-compatibility:qualification"));
  assert.equal(qualification?.["working-directory"], ".worker-tmp/profiles/node-${{ github.sha }}");
  const capture = compatibility.steps.find(step =>
    typeof step["run"] === "string" && step["run"].includes("COMPAT_NODE_EXECUTABLE="));
  assert.ok(capture);
  for (const id of ["linux-package", "linux-registry", "linux-published",
    "windows-package", "windows-registry", "windows-published", "macos-package"]) {
    const job = current.jobs[id]!;
    assert.equal(job.env?.["AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE"], "node", id);
    assert.ok(job.steps.some(step => runs(step, "node tools/dev.mts --profile node install")), id);
    assert.ok(job.steps.some(step => runs(step, "node tools/dev.mts --profile node build")), id);
    assert.equal(job.steps.some(step =>
      runs(step, "node scripts/pack-test.mjs") && step["working-directory"] === undefined), false, id);
    assert.ok(job.steps.every(step => step["working-directory"] !== ".worker-tmp/profiles/node-${{ github.sha }}" ||
      typeof step["run"] !== "string" || !step["run"].includes("bun ")), id);
  }
  const bootstrap = current.jobs["linux-bootstrap-evidence"]!;
  const bootstrapInstall = bootstrap.steps.find(step =>
    runs(step, "node tools/dev.mts --profile node install"));
  assert.equal(bootstrapInstall?.["working-directory"], undefined);
  const candidate = bootstrap.steps.find(step =>
    typeof step["run"] === "string" &&
    step["run"].includes("tool npm-package-bootstrap:candidate-evidence"));
  assert.equal(candidate?.["working-directory"], ".worker-tmp/profiles/node-${{ github.sha }}");
  assert.deepEqual(candidate?.["env"], {
    AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: "${{ github.workspace }}",
    AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT:
      "${{ steps.setup-pnpm.outputs.bin-dest }}/pnpm${{ runner.os == 'Windows' && '.exe' || '' }}"
  });
});

async function minimalSource(root: string): Promise<void> {
  await mkdir(join(root, ".worker-tmp/profiles"), { recursive: true });
  await mkdir(join(root, "architecture/foundation"), { recursive: true });
  const manifest = {
    name: "TEST-node-profile-source",
    version: "1.0.0",
    private: true,
    packageManager: "bun@1.4.3",
    workspaces: { packages: ["packages/*"], catalog: {}, catalogs: {} },
    catalog: {},
    catalogs: {},
    overrides: {}
  };
  await writeFile(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(root, "pnpm-workspace.yaml"),
    "packages:\n  - \"packages/*\"\ncatalog: {}\ncatalogs: {}\noverrides: {}\n", "utf8");
  await copyFile(
    join(repositoryRoot, "architecture/foundation/repository-runtime.json"),
    join(root, "architecture/foundation/repository-runtime.json")
  );
}

test("a clean owned Node projection preserves source and manifest digest truth", async () => {
  const parent = await ownedTemporaryRoot("repository-ci-runtime-");
  const sourceRoot = join(parent, "source");
  const targetRoot = join(parent, "source/.worker-tmp/profiles/node-profile");
  try {
    await minimalSource(sourceRoot);
    const evidence = await prepareProfileProjection({
      profile: "node", sourceRoot, targetRoot, sourceSha
    });
    const derived = JSON.parse(await readFile(join(targetRoot, "package.json"), "utf8")) as
      { packageManager: string };
    assert.equal(derived.packageManager, "pnpm@11.20.0");
    assert.equal(evidence.profile, "node");
    await mkdir(join(targetRoot, "node_modules/.pnpm"), { recursive: true });
    await writeFile(join(targetRoot, "node_modules/.pnpm/lock.yaml"), "lockfileVersion: \n", "utf8");
    await assertPnpmProfileQualificationRoot(targetRoot, sourceRoot);

    await writeFile(join(sourceRoot, "changed.txt"), "source drift\n", "utf8");
    await assert.rejects(
      assertPnpmProfileQualificationRoot(targetRoot, sourceRoot),
      /source digest evidence is stale/u
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("packageManager projection and pnpm qualification reject Bun-root relabeling", async () => {
  const source = JSON.stringify({ packageManager: "bun@1.4.3", name: "fixture" });
  assert.equal(
    JSON.parse(projectPackageManager(source, "pnpm@11.20.0")).packageManager,
    "pnpm@11.20.0"
  );
  const parent = await ownedTemporaryRoot("package-manager-guard-");
  const sourceRoot = join(parent, "source");
  const targetRoot = join(parent, "source/.worker-tmp/profiles/node-profile");
  try {
    await minimalSource(sourceRoot);
    await prepareProfileProjection({ profile: "node", sourceRoot, targetRoot, sourceSha });
    await mkdir(join(targetRoot, "node_modules/.pnpm"), { recursive: true });
    await writeFile(join(targetRoot, "node_modules/.pnpm/lock.yaml"), "lockfileVersion: \n", "utf8");
    const manifestPath = join(targetRoot, "package.json");
    const projected = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    projected["packageManager"] = "bun@1.4.3";
    await writeFile(manifestPath, `${JSON.stringify(projected, null, 2)}\n`, "utf8");
    await assert.rejects(
      assertPnpmProfileQualificationRoot(targetRoot, sourceRoot),
      /exact private pnpm profile projection/u
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("compatibility qualification consumes and verifies its captured Node role", async () => {
  const previous = process.env["COMPAT_NODE_EXECUTABLE"];
  try {
    delete process.env["COMPAT_NODE_EXECUTABLE"];
    await assert.rejects(assertCompatibilityNodeExecutable(), /explicit compatibility executable/u);
    process.env["COMPAT_NODE_EXECUTABLE"] = process.execPath;
    assert.equal(await assertCompatibilityNodeExecutable(), process.execPath);
  } finally {
    if (previous === undefined) {
      delete process.env["COMPAT_NODE_EXECUTABLE"];
    } else {
      process.env["COMPAT_NODE_EXECUTABLE"] = previous;
    }
  }
});

test("selected Node command execution works without any Bun executable", async () => {
  const parent = await ownedTemporaryRoot("node-fallback-");
  const bin = join(parent, "bin");
  const fixture = join(parent, "fixture");
  const observation = join(parent, "observation.jsonl");
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  try {
    await Promise.all([mkdir(bin), mkdir(fixture)]);
    const linkedNode = join(bin, nodeName);
    await link(process.execPath, linkedNode).catch(async error => {
      if (error?.code !== "EXDEV" && error?.code !== "EPERM") {
        throw error;
      }
      await copyFile(process.execPath, linkedNode);
      await chmod(linkedNode, 0o755);
    });
    await writeFile(join(fixture, "package.json"), `${JSON.stringify({
      name: "TEST-node-command-profile",
      version: "1.0.0",
      private: true,
      packageManager: "pnpm@11.20.0"
    }, null, 2)}\n`, "utf8");
    const commonEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: bin,
      TMPDIR: parent,
      TEMP: parent,
      TMP: parent,
      pnpm_config_ignore_workspace: "true",
      pnpm_config_verify_deps_before_run: "false",
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath,
      AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT:
        resolve(repositoryRoot, ".cache/admitted-tools/pnpm/pnpm.mjs"),
      AGENT_TEAMS_FOUNDATION_RUNTIME_OBSERVATION: observation
    };
    delete commonEnvironment["AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE"];

    const defaultProfile = spawnSync(process.execPath, [
      resolve(repositoryRoot, "tools/repository-command.mts"), "tool", "runtime-observe"
    ], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...commonEnvironment, AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: undefined },
      timeout: 10_000
    });
    assert.notEqual(defaultProfile.status, 0, `${defaultProfile.stdout}${defaultProfile.stderr}`);

    const pnpmVersion = spawnSync(process.execPath, [
      resolve(repositoryRoot, "tools/pnpm-command.mts"), "--version"
    ], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...commonEnvironment, AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "node" },
      timeout: 20_000
    });
    assert.equal(pnpmVersion.status, 0, `${pnpmVersion.stdout}${pnpmVersion.stderr}`);
    assert.equal(pnpmVersion.stdout.trim(), "11.20.0");

    const selectedProfile = spawnSync(process.execPath, [
      resolve(repositoryRoot, "tools/repository-command.mts"), "tool", "runtime-observe"
    ], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...commonEnvironment, AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "node" },
      timeout: 20_000
    });
    assert.equal(selectedProfile.status, 0, `${selectedProfile.stdout}${selectedProfile.stderr}`);
    const observed = JSON.parse((await readFile(observation, "utf8")).trim()) as {
      readonly profile: string | null;
      readonly leafNodeVersion: string | null;
      readonly leafBunVersion: string | null;
    };
    assert.equal(observed.profile, "node");
    assert.equal(observed.leafNodeVersion, process.versions["node"]);
    assert.equal(observed.leafBunVersion, null);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
