import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve } from "node:path";
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
import { inspectInstalledDependencies } from "../tools/dependencies-installed-check.mts";
import { resolveQualificationExecutables } from "../tools/executable-policy.mts";
import { projectNodeAgentWorkflowPolicy } from "../tools/runtime-policy.mts";
import { pnpmPortableName, resolvePnpmInvocation } from "../tools/pnpm-command.mts";
import { repositorySourceRoot } from "./support/repository-source.ts";
import { TOOL_COMMANDS } from "../tools/repository-tool-catalog.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceSha = "a".repeat(40);
const pnpmSetup = "pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b";

async function ownedTemporaryRoot(prefix: string): Promise<string> {
  const parent = join(repositoryRoot, ".worker-tmp/profiles");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}

interface Workflow {
  readonly env?: Record<string, string>;
  readonly jobs: Record<string, {
    readonly env?: Record<string, string>;
    readonly steps: readonly Record<string, unknown>[];
    readonly strategy?: { readonly matrix?: Record<string, readonly unknown[]> };
  }>;
}

async function workflow(name: string): Promise<Workflow> {
  return parseYaml(await readFile(join(repositoryRoot, ".github/workflows", name), "utf8")) as Workflow;
}

test("job TMPDIR uses valid runtime placement with finite named paths", async () => {
  const ci = await workflow("ci.yml");
  for (const id of [
    "node26-compatibility", "linux-package", "linux-registry", "linux-published",
    "windows-package", "windows-registry", "windows-published", "macos-package"
  ]) {
    assert.equal(ci.jobs[id]?.env?.["TMPDIR"], undefined, id);
    const temporarySetup = ci.jobs[id]?.steps.find((step) =>
      typeof step["run"] === "string" &&
      (step["run"].includes("tmpdir=\"${RUNNER_TEMP}/") || step["run"].includes("$tmpdir = Join-Path $env:RUNNER_TEMP"))
    );
    assert.ok(temporarySetup, id);
    assert.ok(temporarySetup["shell"] === "bash" || temporarySetup["shell"] === "pwsh", id);
  }
  const source = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  assert.doesNotMatch(source, /^\s+TMPDIR: \$\{\{ runner\.temp \}\}\s*$/mu);
  assert.match(source, /TMPDIR: \$\{\{ runner\.temp \}\}\/producer-4/u);
});

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

test("pnpm setup scopes its Bun-manifest exception to the preparation step", async () => {
  const files = (await readdir(join(repositoryRoot, ".github/workflows")))
    .filter(name => name.endsWith(".yml"));
  let setupCount = 0;
  for (const name of files) {
    const current = await workflow(name);
    assert.equal(current.env?.["pnpm_config_pm_on_fail"], undefined, name);
    for (const [id, job] of Object.entries(current.jobs)) {
      assert.equal(job.env?.["pnpm_config_pm_on_fail"], undefined, `${name}/${id}`);
      for (const step of job.steps ?? []) {
        const environment = step["env"] as Record<string, string> | undefined;
        if (typeof step["uses"] === "string" && step["uses"].startsWith("pnpm/setup@")) {
          setupCount += 1;
          assert.equal(step["uses"], pnpmSetup, `${name}/${id}`);
          assert.deepEqual(stepWith(step), { version: "11.20.0", install: false }, `${name}/${id}`);
          assert.deepEqual(environment, { pnpm_config_pm_on_fail: "ignore" }, `${name}/${id}`);
        } else {
          assert.equal(environment?.["pnpm_config_pm_on_fail"], undefined, `${name}/${id}`);
        }
      }
    }
  }
  assert.ok(setupCount > 0);
});

test("pinned pnpm setup version probe accepts Bun only with its scoped preparation environment", async () => {
  const runtime = await resolveQualificationExecutables("node");
  const pnpm = await resolvePnpmInvocation(runtime.node, "11.20.0");
  const root = await ownedTemporaryRoot("pnpm-setup-probe-");
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "TEST-pnpm-setup-probe", private: true, packageManager: "bun@1.4.3"
    }));
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    const environment = { ...process.env, pnpm_config_pm_on_fail: "error" };
    const probe = (env: NodeJS.ProcessEnv) => spawnSync(pnpm.command, [...pnpm.args, "--version"], {
      cwd: root, env, encoding: "utf8", timeout: 10_000
    });
    const rejected = probe(environment);
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /This project is configured to use bun/u);
    const ci = await workflow("ci.yml");
    const setup = ci.jobs["linux-static"]?.steps.find(step => step["uses"] === pnpmSetup);
    const accepted = probe({ ...environment, ...(setup?.["env"] as NodeJS.ProcessEnv) });
    assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
    assert.equal(accepted.stdout.trim(), "11.20.0");
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { readonly packageManager: string };
    assert.equal(manifest.packageManager, "bun@1.4.3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("signed RC preparation retains clean source custody and its owned pnpm projection", async () => {
  const current = await workflow("ci-input-proof-rc.yml");
  const steps = current.jobs["prepare"]?.steps ?? [];
  const bun = steps.find(step => typeof step["uses"] === "string" &&
    step["uses"].startsWith("oven-sh/setup-bun@"));
  assert.deepEqual(stepWith(bun ?? {}), { "bun-version": "1.4.3" });
  assert.ok(steps.some(step => step["run"] === "node tools/dev.mts install"));
  assert.equal(steps.some(step => stepWith(step)["cache"] === "pnpm"), false);
  assert.equal(steps.some(step => typeof step["run"] === "string" &&
    /^pnpm\s+install/u.test(step["run"])), false);
  const prepare = steps.find(step => step["id"] === "artifact");
  assert.equal(prepare?.["run"],
    'node scripts/prepare-ci-input-proof-rc.mts "${RUNNER_TEMP}/ci-input-proof-rc" "${EXPECTED_COMMIT}"');
  assert.equal(prepare?.["working-directory"], undefined);
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

function portableManagerFixture(version: string): string {
  return `#!${process.execPath}\n` +
      "const args = process.argv.slice(2);\n" +
      `if (args.includes("--version")) process.stdout.write("${version}" + String.fromCharCode(10));\n`;
}

test("portable native manager fixtures reject wrong versions before operations", async () => {
  if (process.platform === "win32") {
    return;
  }
  const parent = await ownedTemporaryRoot("pnpm-native-");
  const bin = join(parent, "bin");
  const wrongBin = join(parent, "wrong-bin");
  const previousEntrypoint = process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"];
  try {
    await Promise.all([mkdir(bin), mkdir(wrongBin)]);
    const path = join(bin, pnpmPortableName());
    await writeFile(path, portableManagerFixture("11.20.0"), "utf8");
    await chmod(path, 0o755);
    process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"] = path;
    const invocation = await resolvePnpmInvocation(process.execPath, "11.20.0");
    assert.equal(invocation.kind, "native");
    assert.equal(invocation.command, await realpath(path));
    const wrong = join(wrongBin, "pnpm");
    await writeFile(wrong, portableManagerFixture("99.0.0"), "utf8");
    await chmod(wrong, 0o755);
    process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"] = wrong;
    await assert.rejects(resolvePnpmInvocation(process.execPath, "11.20.0"), /not pnpm 11\.20\.0/u);
  } finally {
    if (previousEntrypoint === undefined) {
      delete process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"];
    } else {
      process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"] = previousEntrypoint;
    }
    await rm(parent, { recursive: true, force: true });
  }
});

test("projected qualification binds Git source authority instead of repository ascent", async () => {
  const authority = await assertExplicitSourceGitAuthority(await repositorySourceRoot());
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
  const sourceRoot = await repositorySourceRoot();
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
    join(sourceRoot, "architecture/foundation/repository-agent-workflow.yaml"),
    join(root, "architecture/foundation/repository-agent-workflow.yaml")
  );
  await copyFile(join(sourceRoot, "architecture/foundation/dependency-declarations.yaml"), join(root, "architecture/foundation/dependency-declarations.yaml"));
  await copyFile(
    join(sourceRoot, "architecture/foundation/repository-runtime.json"),
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
    const workflowPath = "architecture/foundation/repository-agent-workflow.yaml";
    const sourceWorkflow = await readFile(join(sourceRoot, workflowPath), "utf8");
    const derivedWorkflow = await readFile(join(targetRoot, workflowPath), "utf8");
    assert.equal((parseYaml(sourceWorkflow) as { packageManager: string }).packageManager, "bun");
    assert.equal((parseYaml(derivedWorkflow) as { packageManager: string }).packageManager, "pnpm");
    assert.notEqual(evidence.originalWorkflowPolicySha256, evidence.derivedWorkflowPolicySha256);
    await mkdir(join(targetRoot, "node_modules/.pnpm"), { recursive: true });
    await writeFile(join(targetRoot, "node_modules/.pnpm/lock.yaml"), "lockfileVersion: \n", "utf8");
    await assertPnpmProfileQualificationRoot(targetRoot, sourceRoot);
    await writeFile(join(targetRoot, workflowPath), sourceWorkflow);
    await assert.rejects(assertPnpmProfileQualificationRoot(targetRoot, sourceRoot), /workflow policy projection/u);
    await writeFile(join(targetRoot, workflowPath), derivedWorkflow);

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
    const manager = await resolvePnpmInvocation(process.execPath, "11.20.0");
    const managerEntrypoint = manager.kind === "javascript" ? manager.args[0] : manager.command;
    assert.ok(managerEntrypoint);
    const commonEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: bin,
      TMPDIR: parent,
      TEMP: parent,
      TMP: parent,
      pnpm_config_ignore_workspace: "true",
      pnpm_config_verify_deps_before_run: "false",
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath,
      AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT: managerEntrypoint,
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

test("existing native jobs execute the Bun transport fixture with a physical admitted Node", async () => {
  const ci = await workflow("ci.yml");
  for (const id of ["linux-tests", "windows-test-b", "macos-native"]) {
    const steps = ci.jobs[id]?.steps;
    assert.ok(steps, id);
    const setup = steps.find(step => String(step["uses"]).startsWith("oven-sh/setup-bun@"));
    assert.equal(stepWith(setup ?? {})["bun-version"], "1.4.3", id);
    const witness = steps.find(step => typeof step["run"] === "string" &&
      step["run"].includes("tests/process-runtime-delegation-under-bun.mts"));
    assert.ok(witness, id);
    const command = String(witness["run"]);
    assert.match(command, /node -p 'process\.execPath'/u, id);
    assert.match(command, /bun -p 'process\.execPath'/u, id);
    assert.match(command, /PROCESS_RUNTIME_DELEGATION_NODE/u, id);
    assert.match(command, /AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE/u, id);
    assert.match(command, /AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE.*tests\/process-runtime-delegation-under-bun\.mts/u, id);
    const build = steps.findIndex(step => step["run"] === "bun tools/dev.mts build" ||
      String(step["run"]).includes("run-ci-test-pair.mts build"));
    assert.ok(build >= 0 && steps.indexOf(witness) > build, id);
    assert.equal(witness["continue-on-error"], undefined, id);
  }
});

test("full diagnostics require an explicit isolated Node profile before effects", () => {
  const result = spawnSync(process.execPath, [resolve(repositoryRoot, "tools/dev.mts"), "verify"], {
    cwd: repositoryRoot, encoding: "utf8", timeout: 5_000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Full repository diagnostics require the explicit --profile node projection/u);
  const packagePhase = spawnSync(process.execPath,
    [resolve(repositoryRoot, "tools/dev.mts"), "package:check:built"], {
      cwd: repositoryRoot, encoding: "utf8", timeout: 5_000
    });
  assert.notEqual(packagePhase.status, 0);
  assert.match(packagePhase.stderr, /Package qualification requires the explicit --profile node projection/u);
});

// Manager selection belongs to recorded profile policy, never an ambient override.
test("Node workflow policy projection rejects drift and preserves all other bytes", () => {
  const source = "schemaVersion: 2\r\npackageManager: bun\r\nscripts: {}\r\n";
  assert.equal(projectNodeAgentWorkflowPolicy(source), source.replace("packageManager: bun", "packageManager: pnpm"));
  for (const invalid of [
    source.replace("schemaVersion: 2", "schemaVersion: 1"),
    source.replace("packageManager: bun", "packageManager: pnpm"),
    source.replace("packageManager: bun", "packageManager: npm"),
    source + "packageManager: bun\r\n"
  ]) {
    assert.throws(() => projectNodeAgentWorkflowPolicy(invalid), /exact repository v2 Bun workflow policy/u);
  }
});

// The runtime port must preserve the current capability-owned production selection.
test("typed lint retains the production quality capability route", () => {
  assert.deepEqual(TOOL_COMMANDS["lint:typed"], {
    entry: "packages/engineering-foundation/dist/cli.js",
    args: ["quality", "check", "--consumer", "."], role: "runtime",
  });
});

test("typecheck rejects errors in every strict project outside the production build", {
  timeout: 120_000
}, async () => {
  const runtime = await resolveQualificationExecutables("bun");
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  const toolchain = JSON.parse(await readFile(join(repositoryRoot, "toolchain.config.json"), "utf8")) as {
    readonly typecheck: { readonly projects: readonly string[] };
  };
  const projects = [
    ["typecheck:ci-tooling", "tsconfig.ci-tooling.json", "ci-tooling.mts"],
    ["typecheck:restoration-lock-inputs", "tsconfig.restoration-lock-inputs-tests.json", "restoration-inputs.mts"],
    ["typecheck:restoration-lock", "tsconfig.restoration-lock-tests.json", "restoration-lock.mts"],
    ["typecheck:managed-runtime-tests", "tsconfig.managed-runtime-tests.json", "managed-runtime.mts"],
    ["typecheck:local-mode-oracles", "tsconfig.local-mode-oracles.json", "local-mode-oracles.ts"],
    ["typecheck:native-api-tests", "tsconfig.native-api-tests.json", "native-api-tests.ts"],
    ["typecheck:native-release-tooling", "tsconfig.native-release-tooling.json", "native-release-tooling.ts"],
    ["typecheck:agent-workflow", "tsconfig.agent-workflow-tests.json", "agent-workflow.ts"],
    // This required project is invoked as a dispatcher tool, not a package script.
    [null, "spikes/source-dependency-parser/tsconfig.json", "spikes/source-dependency-parser/parser-spike.ts"]
  ] as const;
  const valid = "export const value: number = 1;\n";
  const invalid = "export const value: number = \"strict-project-error\";\n";
  const compilerOptions = { strict: true, noEmit: true, types: [], target: "ES2024" };
  const root = await ownedTemporaryRoot("strict-project-admission-");
  const dispatcherCommand = [runtime.node, join(repositoryRoot, "tools/repository-command.mts")]
    .map(path => `'${path.replaceAll("'", "'\\''")}'`).join(" ");
  const run = (id: string) => spawnSync(runtime.node, [
    join(repositoryRoot, "tools/repository-command.mts"), "script", id
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: runtime.node,
      AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: runtime.bun,
      AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "bun",
      PATH: `${dirname(runtime.node)}${delimiter}${process.env["PATH"] ?? ""}`
    }
  });
  try {
    const ids = ["build", "typecheck", ...projects.flatMap(([id]) => id === null ? [] : [id])];
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "TEST-strict-project-admission", private: true, packageManager: "bun@1.4.3",
      scripts: Object.fromEntries(ids.map(id => [id,
        manifest.scripts[id]?.replaceAll("node tools/repository-command.mts", dispatcherCommand)
      ]))
    }));
    await writeFile(join(root, "production.mts"), valid);
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions, files: ["production.mts"]
    }));
    assert.deepEqual(TOOL_COMMANDS["typecheck"], {
      entry: "node_modules/stack-toolchain/dist/cli.js", args: ["typecheck"], role: "node-tool",
    });
    await writeFile(join(root, "lint.json"), "{}");
    await writeFile(join(root, "toolchain.config.json"), JSON.stringify({
      schemaVersion: 1, profile: "typescript-node",
      typecheck: toolchain.typecheck,
      lint: { config: "lint.json", paths: ["."] }, format: { paths: ["."] },
    }));
    await writeFile(join(root, "tsconfig.quality.json"), JSON.stringify({
      compilerOptions, files: ["production.mts"]
    }));
    for (const [, config, input] of projects) {
      await mkdir(dirname(join(root, config)), { recursive: true });
      await writeFile(join(root, input), valid);
      await writeFile(join(root, config), JSON.stringify({
        compilerOptions, files: [relative(dirname(config), input)]
      }));
    }
    const baseline = run("typecheck");
    assert.equal(baseline.status, 0, `${baseline.stdout}${baseline.stderr}`);
    // A single build with every strict-only input invalid proves their joint exclusion.
    for (const [, , input] of projects) {
      await writeFile(join(root, input), invalid);
    }
    const production = run("build");
    assert.equal(production.status, 0, `${production.stdout}${production.stderr}`);
    for (const [, , input] of projects) {
      await writeFile(join(root, input), valid);
    }
    for (const [, , input] of projects) {
      await writeFile(join(root, input), invalid);
      const rejected = run("typecheck");
      assert.notEqual(rejected.status, 0,
        `typecheck omitted strict project input ${input}: ${rejected.stdout}${rejected.stderr}`);
      assert.match(`${rejected.stdout}${rejected.stderr}`, /error TS2322/u);
      assert.ok(`${rejected.stdout}${rejected.stderr}`.replaceAll("\\", "/").includes(input));
      await writeFile(join(root, input), valid);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function installedManifest(root: string, manifest: unknown): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify(manifest)}\n`);
}

test("installed guard rejects normal dependency identity and version substitution", async () => {
  const root = await ownedTemporaryRoot("normal-dependency-rejection-");
  try {
    await installedManifest(root, { name: "TEST-root", dependencies: { example: "1.0.0" } });
    await writeFile(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    for (const [name, version, expected] of [
      ["wrong-package", "99.0.0", /dependency identity mismatch/u],
      ["example", "99.0.0", /dependency version mismatch/u]
    ] as const) {
      await installedManifest(join(root, "node_modules/example"), { name, version });
      await assert.rejects(inspectInstalledDependencies(root), expected);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed guard admits explicit alias, catalog and global override coordinates", async () => {
  for (const [spec, policy, name, version] of [
    ["^1.0.0", "", "example", "1.2.0"],
    ["npm:actual@^2.0.0", "", "actual", "2.1.0"],
    ["catalog:", "catalog:\n  example: 1.2.0\n", "example", "1.2.0"],
    ["catalog:tools", "catalogs:\n  tools:\n    example: npm:actual@2.1.0\n", "actual", "2.1.0"],
    ["^1.0.0", "overrides:\n  example: 2.3.0\n", "example", "2.3.0"],
    ["^1.0.0", "overrides:\n  example: npm:actual@2.1.0\n", "actual", "2.1.0"]
  ] as const) {
    const root = await ownedTemporaryRoot("normal-dependency-admission-");
    try {
      await installedManifest(root, { name: "TEST-root", dependencies: { example: spec } });
      await writeFile(join(root, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n${policy}`);
      await installedManifest(join(root, "node_modules/example"), { name, version });
      const result = await inspectInstalledDependencies(root);
      assert.deepEqual(result.packages, [`${name}@${version}`]);
      await installedManifest(join(root, "node_modules/example"), { name, version: "99.0.0" });
      await assert.rejects(inspectInstalledDependencies(root), /dependency version mismatch/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("installed workspace dependencies require their declared physical workspace", async () => {
  const root = await ownedTemporaryRoot("normal-workspace-admission-");
  const provider = join(root, "packages/example");
  const installed = join(root, "node_modules/example");
  try {
    await installedManifest(root, { name: "TEST-root", dependencies: { example: "workspace:^" } });
    await writeFile(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    await installedManifest(provider, { name: "example", version: "1.2.0" });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(provider, installed, "junction");
    assert.deepEqual((await inspectInstalledDependencies(root)).packages, ["example@1.2.0"]);
    await rm(installed);
    await installedManifest(installed, { name: "example", version: "1.2.0" });
    await assert.rejects(inspectInstalledDependencies(root), /outside its declared workspace package/u);
    await rm(installed, { recursive: true });
    await symlink(provider, installed, "junction");
    await installedManifest(root, { name: "TEST-root", dependencies: { example: "workspace:^2.0.0" } });
    await assert.rejects(inspectInstalledDependencies(root), /dependency version mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed guard rejects unsupported and unresolved dependency admission formats", async () => {
  const root = await ownedTemporaryRoot("normal-dependency-formats-");
  try {
    await writeFile(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    await installedManifest(join(root, "node_modules/example"), { name: "example", version: "1.0.0" });
    for (const spec of ["catalog:", "catalog:missing", "npm:actual", "file:../example", "workspace:*"]) {
      await installedManifest(root, { name: "TEST-root", dependencies: { example: spec } });
      await assert.rejects(inspectInstalledDependencies(root), /catalog|alias|SemVer|declared workspace/u);
    }
    await installedManifest(root, { name: "TEST-root", optionalDependencies: { absent: "file:../absent" } });
    await assert.rejects(inspectInstalledDependencies(root), /SemVer/u);
    await installedManifest(root, { name: "TEST-root", dependencies: { example: "1.0.0" } });
    await writeFile(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\noverrides:\n  "example@^1": 2.0.0\n');
    await assert.rejects(inspectInstalledDependencies(root), /Unsupported dependency override selector/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A tag is admitted only through the exact issuer edge in the retained frozen lock.
test("installed dependency tags require unambiguous frozen coordinates", async () => {
  const root = await ownedTemporaryRoot("normal-tag-admission-");
  try {
    await installedManifest(root, { name: "TEST-root", dependencies: { host: "1.0.0" } });
    await writeFile(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    await installedManifest(join(root, "node_modules/host"), {
      name: "host", version: "1.0.0", dependencies: { example: "cjs" }
    });
    await installedManifest(join(root, "node_modules/example"), { name: "example", version: "2.0.0" });
    await assert.rejects(inspectInstalledDependencies(root), /unambiguous frozen lock coordinate/u);
    await writeFile(join(root, "pnpm-lock.yaml"), `lockfileVersion: '9.0'
snapshots:
  host@1.0.0:
    dependencies: { example: 2.0.0 }
`);
    assert.ok((await inspectInstalledDependencies(root)).packages.includes("example@2.0.0"));
    await installedManifest(join(root, "node_modules/example"), { name: "example", version: "99.0.0" });
    await assert.rejects(inspectInstalledDependencies(root), /dependency version mismatch/u);
    await installedManifest(join(root, "node_modules/example"), { name: "example", version: "2.0.0" });
    await writeFile(join(root, "pnpm-lock.yaml"), `lockfileVersion: '9.0'
snapshots:
  host@1.0.0:
    dependencies: { example: 2.0.0 }
  host@1.0.0(peer@1.0.0):
    dependencies: { example: 3.0.0 }
`);
    await assert.rejects(inspectInstalledDependencies(root), /unambiguous frozen lock coordinate/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("read-only pnpm pack port preserves Bun authority and rejects effects before manager admission", async t => {
  const root = await ownedTemporaryRoot("readonly-pack-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await resolveQualificationExecutables("node");
  const cli = join(repositoryRoot, "tools/pnpm-command.mts");
  const archive = join(root, "actual.tgz");
  const marker = join(root, "manager-called");
  const sentinel = join(root, "sentinel.cjs");
  await writeFile(sentinel, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "called");`);
  const manifest = { name: "readonly-pack-test", version: "1.0.0", packageManager: "bun@1.4.3", files: ["payload.txt"] };
  await writeFile(join(root, "payload.txt"), "actual packed payload\n");
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  const invoke = (args: string[], entrypoint?: string) => spawnSync(runtime.node, [cli, ...args], {
    cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env,
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: runtime.node,
      ...(entrypoint === undefined ? {} : { AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT: entrypoint }) },
  });
  const packed = invoke(["pack", "--out", archive]);
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const contents = spawnSync("tar", ["-xOf", archive, "package/payload.txt"], { encoding: "utf8" });
  assert.equal(contents.status, 0, contents.stderr);
  assert.equal(contents.stdout, "actual packed payload\n");
  assert.deepEqual(JSON.parse(await readFile(join(root, "package.json"), "utf8")), manifest);
  for (const args of [["pack"], ["pack", "--out", "relative.tgz"], ["pack", "--out", join(root, "wrong.zip")],
    ["pack", "--out", archive, "--ignore-scripts"], ["pack", "--out", archive, "--pm-on-fail=ignore"]]) {
    const rejected = invoke(args, sentinel);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /closed pinned pnpm operations/u);
  }
  for (const hook of ["prepack", "prepare", "postpack", "prepublish", "prepublishOnly"]) {
    await writeFile(join(root, "package.json"), JSON.stringify({ ...manifest, scripts: { [hook]: "node sentinel.cjs" } }));
    const rejected = invoke(["pack", "--out", join(root, "rejected.tgz")], sentinel);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Read-only pack refuses lifecycle hook/u);
  }
  for (const invalid of ['{"secret-malformed-manifest":', 'null', '[]',
    ...[null, [], "secret-invalid-scripts", 42].map(scripts => JSON.stringify({ ...manifest, scripts }))]) {
    await writeFile(join(root, "package.json"), invalid);
    const rejected = invoke(["pack", "--out", join(root, "rejected.tgz")], sentinel);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Read-only pack requires/u);
    assert.doesNotMatch(rejected.stderr, /secret-malformed-manifest|secret-invalid-scripts/u);
  }
  assert.equal((await readdir(root)).includes("manager-called"), false);
  assert.equal((await readdir(root)).includes("rejected.tgz"), false);
});
