import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { resolveQualificationExecutables } from "../tools/executable-policy.mts";
import { resolvePnpmInvocation } from "../tools/pnpm-command.mts";
import { assertPnpmProfileQualificationRoot } from "../tools/dev.mts";

import {
  exactPublicCoordinateDecision,
  registryFoundationQualificationProfile,
  registryInstallMatrix,
} from "../scripts/registry-install-policy.mjs";

const coordinates = [
  { name: "@example/docs", version: "1.2.3" },
  { name: "@example/docs-mcp", version: "2.3.4" },
];
const manifest = (name, fields = {}) => JSON.stringify({ name, version: "1.0.0", ...fields });
const packageManager = "pnpm@11.20.0";

async function pnpmCli() {
  const invocation = await resolvePnpmInvocation(process.execPath, packageManager.split("@")[1]);
  return { command: invocation.command, prefix: [...invocation.args, "--pm-on-fail=ignore"] };
}

function runPnpm(cli, root, args) {
  return spawnSync(cli.command, [...cli.prefix, ...args], { cwd: root, encoding: "utf8" });
}

function runBun(cli, root, args) {
  const result = spawnSync(cli, args, { cwd: root, encoding: "utf8" });
  assert.equal(result.error, undefined, `The admitted Bun command could not start: ${result.error?.code}`);
  return result;
}

function runInstalledGuard(root) {
  const guard = fileURLToPath(new URL("../tools/dependencies-installed-check.mts", import.meta.url));
  return spawnSync(process.execPath, [guard], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_TEAMS_FOUNDATION_INSTALLED_INVENTORY: join(root, "installed-inventory.json")
    }
  });
}

test("registry qualification covers npm and pnpm with docs-only and MCP profiles", () => {
  assert.deepEqual(registryInstallMatrix({
    docsPackageName: coordinates[0].name,
    mcpPackageName: coordinates[1].name,
  }), [
    { id: "npm-docs-only", manager: "npm", packageNames: [coordinates[0].name], profile: "docs-only" },
    { id: "npm-docs-mcp", manager: "npm", packageNames: coordinates.map(({ name }) => name), profile: "docs-mcp" },
    { id: "pnpm-docs-only", manager: "pnpm", packageNames: [coordinates[0].name], profile: "docs-only" },
    { id: "pnpm-docs-mcp", manager: "pnpm", packageNames: coordinates.map(({ name }) => name), profile: "docs-mcp" },
  ]);
});

test("Foundation registry qualification installs the managed Skill authority", () => {
  assert.deepEqual(registryFoundationQualificationProfile({
    adapterPackageName: "@example/docs-adapter",
    authoringPackageName: "@example/document-authoring",
    docsPackageName: "@example/docs",
    foundationPackageName: "@example/foundation",
    mcpPackageName: "@example/docs-mcp",
  }), {
    id: "npm-foundation",
    manager: "npm",
    packageNames: [
      "@example/foundation",
      "@example/document-authoring",
      "@example/docs",
      "@example/docs-adapter",
      "@example/docs-mcp",
    ],
    profile: "foundation-full",
  });
});

test("public exact-coordinate policy stays pending until every exact version exists", () => {
  assert.deepEqual(exactPublicCoordinateDecision({
    coordinates,
    publishedVersions: {
      [coordinates[0].name]: [coordinates[0].version],
      [coordinates[1].name]: ["0.0.0"],
    },
  }), {
    coordinates,
    missing: [coordinates[1]],
    status: "pending",
  });
});

test("public exact-coordinate policy becomes ready only for both exact versions", () => {
  assert.equal(exactPublicCoordinateDecision({
    coordinates,
    publishedVersions: Object.fromEntries(coordinates.map(({ name, version }) => [name, [version]])),
  }).status, "ready");
});

test("compatibility and release installs use admitted runtime profiles before qualification", async () => {
  const ci = YAML.parse(await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const release = YAML.parse(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
  const nodeJob = ci.jobs["node26-compatibility"];
  assert.equal(nodeJob.env.AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE, "node");
  assert.equal(nodeJob.env.AGENT_TEAMS_FOUNDATION_SOURCE_ROOT, "${{ github.workspace }}");
  const compatibility = nodeJob.steps.map(({ run }) => run).filter(Boolean);
  const installIndex = compatibility.indexOf("node tools/dev.mts --profile node install");
  assert.ok(installIndex >= 0);
  assert.equal(compatibility[installIndex + 1], "pnpm dependencies:peers:check");
  const sourceInstall = "node tools/dev.mts install";
  const releaseCommands = Object.values(release.jobs).map(job => job.steps?.map(({ run }) => run).filter(Boolean) ?? []);
  assert.equal(releaseCommands.filter(commands => commands.includes(sourceInstall)).length, 2);
  const releaseSteps = release.jobs.release.steps;
  const changesets = releaseSteps.find((step) => step.id === "changesets");
  const releaseInstall = releaseSteps.findIndex((step) => step.run === sourceInstall);
  assert.ok(releaseInstall >= 0 && releaseInstall < releaseSteps.indexOf(changesets));
  assert.equal(releaseSteps.some((step) => step.run === "node tools/dev.mts --profile node install"), false);
  assert.equal(changesets.with.version, "node tools/release-profile.mts version");
  assert.equal(changesets.with.publish, "node tools/release-profile.mts publish");

  const helper = await readFile(new URL("../tools/release-profile.mts", import.meta.url), "utf8");
  const version = helper.slice(helper.indexOf("async function version()"), helper.indexOf("async function publish()"));
  const versionRun = version.indexOf('await run(command.bun, ["run", "release:version"]');
  const versionFailure = version.indexOf("if (status !== 0)");
  const refresh = version.indexOf("await refreshVersionLocks(command)");
  assert.ok(versionRun >= 0 && versionFailure > versionRun && refresh > versionFailure);
  assert.equal(version.includes("prepareProfileProjection("), false);

  const publish = helper.slice(helper.indexOf("async function publish()"), helper.indexOf("async function main()"));
  const install = publish.indexOf('[resolve(command.sourceRoot, "tools/dev.mts"), "--profile", "node", "install"]');
  const installFailure = publish.indexOf("if (installStatus !== 0)");
  const build = publish.indexOf('[resolve(command.sourceRoot, "tools/dev.mts"), "--profile", "node", "build"]');
  const buildFailure = publish.indexOf("if (buildStatus !== 0)");
  const publication = publish.indexOf('[resolve(targetRoot, "tools/repository-command.mts"), "script", "release:publish"]');
  assert.ok(install >= 0 && installFailure > install && build > installFailure &&
    buildFailure > build && publication > buildFailure);
});

test("pnpm 11 rejects incompatible engines and peers under the repository install policy", async () => {
  const rootManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  if (process.env.AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE === "node") {
    assert.equal(rootManifest.packageManager, packageManager);
    const sourceRoot = process.env.AGENT_TEAMS_FOUNDATION_SOURCE_ROOT;
    assert.equal(typeof sourceRoot, "string", "Node qualification must retain its original source authority.");
    await assertPnpmProfileQualificationRoot(fileURLToPath(new URL("..", import.meta.url)), sourceRoot);
    const sourceManifest = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
    assert.equal(sourceManifest.packageManager, "bun@1.4.3");
  } else {
    assert.equal(rootManifest.packageManager, "bun@1.4.3");
  }
  assert.equal(packageManager, "pnpm@11.20.0");
  const cli = await pnpmCli();
  const selected = runPnpm(cli, process.cwd(), ["--version"]);
  assert.equal(selected.status, 0, `${selected.stdout}\n${selected.stderr}`);
  assert.equal(selected.stdout.trim(), packageManager.split("@")[1]);
  const workspacePolicy = await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
  const root = await mkdtemp(join(tmpdir(), "foundation-pnpm-strict-"));
  try {
    const engineRoot = join(root, "engine");
    await mkdir(join(engineRoot, "engine-dep"), { recursive: true });
    await writeFile(join(engineRoot, "pnpm-workspace.yaml"), workspacePolicy);
    await writeFile(join(engineRoot, "package.json"), manifest("engine-reject-fixture", {
      private: true, packageManager, dependencies: { "engine-dep": "file:./engine-dep" },
    }));
    await writeFile(join(engineRoot, "engine-dep", "package.json"), manifest("engine-dep", {
      engines: { node: ">=27" },
    }));
    const engine = runPnpm(cli, engineRoot, ["install", "--offline"]);
    assert.equal(engine.status, 1, `${engine.stdout}\n${engine.stderr}`);
    assert.match(`${engine.stdout}\n${engine.stderr}`, /ERR_PNPM_UNSUPPORTED_ENGINE/u);

    const peerRoot = join(root, "peer");
    await mkdir(join(peerRoot, "peer-host"), { recursive: true });
    await mkdir(join(peerRoot, "peer-client"), { recursive: true });
    await writeFile(join(peerRoot, "pnpm-workspace.yaml"), workspacePolicy);
    await writeFile(join(peerRoot, "package.json"), manifest("peer-reject-fixture", {
      private: true, packageManager, dependencies: {
        "peer-host": "file:./peer-host-1.0.0.tgz",
        "peer-client": "file:./peer-client-1.0.0.tgz",
      },
    }));
    await writeFile(join(peerRoot, "peer-host", "package.json"), manifest("peer-host", { packageManager }));
    await writeFile(join(peerRoot, "peer-client", "package.json"), manifest("peer-client", {
      packageManager,
      peerDependencies: { "peer-host": ">=2" },
    }));
    for (const packageName of ["peer-host", "peer-client"]) {
      const packed = runPnpm(cli, join(peerRoot, packageName), ["pack", "--pack-destination", peerRoot]);
      assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
    }
    const peer = runPnpm(cli, peerRoot, ["install", "--offline"]);
    assert.equal(peer.status, 1, `${peer.stdout}\n${peer.stderr}`);
    assert.match(`${peer.stdout}\n${peer.stderr}`, /ERR_PNPM_PEER_DEP_ISSUES/u);

    // A lockfile generated with peer enforcement disabled can pass a frozen
    // install. The separate lock-graph check must reject those same bytes.
    const locked = runPnpm(cli, peerRoot, ["install", "--offline", "--ignore-scripts", "--strict-peer-dependencies=false"]);
    assert.equal(locked.status, 0, `${locked.stdout}\n${locked.stderr}`);
    const frozen = runPnpm(cli, peerRoot, ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"]);
    assert.equal(frozen.status, 0, `${frozen.stdout}\n${frozen.stderr}`);
    const peerGraph = runPnpm(cli, peerRoot, ["peers", "check", "--lockfile-only"]);
    assert.equal(peerGraph.status, 1, `${peerGraph.stdout}\n${peerGraph.stderr}`);
    assert.match(`${peerGraph.stdout}\n${peerGraph.stderr}`, /peer-host|peer-client/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Bun frozen installs reuse engine and peer fixtures through the connected installed guard", async () => {
  const { bun } = await resolveQualificationExecutables("bun");
  assert.equal(typeof bun, "string", "Real install fixtures require an admitted physical Bun executable.");
  const root = await mkdtemp(join(tmpdir(), "foundation-bun-strict-"));
  try {
    const engineRoot = join(root, "engine");
    await mkdir(join(engineRoot, "packages", "engine-dep"), { recursive: true });
    await writeFile(join(engineRoot, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    await writeFile(join(engineRoot, "package.json"), manifest("engine-reject-fixture", {
      private: true, packageManager: "bun@1.4.3", workspaces: ["packages/*"], dependencies: { "engine-dep": "workspace:*" }
    }));
    await writeFile(join(engineRoot, "packages", "engine-dep", "package.json"), manifest("engine-dep", {
      engines: { node: ">=27" }
    }));
    assert.equal(runBun(bun, engineRoot, ["install", "--lockfile-only", "--ignore-scripts"]).status, 0);
    assert.equal(runBun(bun, engineRoot, ["install", "--frozen-lockfile", "--ignore-scripts", "--linker=isolated"]).status, 0);
    const engineGuard = runInstalledGuard(engineRoot);
    assert.equal(engineGuard.status, 1, engineGuard.stdout + engineGuard.stderr);
    assert.match(`${engineGuard.stdout}\n${engineGuard.stderr}`, /engine mismatch/iu);

    for (const [name, optional] of [["required-peer", false], ["bad-locked-optional-peer", true]]) {
      const peerRoot = join(root, name);
      await mkdir(join(peerRoot, "packages", "peer-host"), { recursive: true });
      await mkdir(join(peerRoot, "packages", "peer-client"), { recursive: true });
      await writeFile(join(peerRoot, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
      await writeFile(join(peerRoot, "package.json"), manifest(`${name}-fixture`, {
        private: true, packageManager: "bun@1.4.3", workspaces: ["packages/*"], dependencies: {
          "peer-host": "workspace:*", "peer-client": "workspace:*"
        }
      }));
      await writeFile(join(peerRoot, "packages", "peer-host", "package.json"), manifest("peer-host"));
      await writeFile(join(peerRoot, "packages", "peer-client", "package.json"), manifest("peer-client", {
        peerDependencies: { "peer-host": ">=2" },
        ...(optional ? { peerDependenciesMeta: { "peer-host": { optional: true } } } : {})
      }));
      assert.equal(runBun(bun, peerRoot, ["install", "--lockfile-only", "--ignore-scripts"]).status, 0);
      const frozen = runBun(bun, peerRoot, ["install", "--frozen-lockfile", "--ignore-scripts", "--linker=isolated"]);
      assert.equal(frozen.status, 0, frozen.stdout + frozen.stderr);
      const guard = runInstalledGuard(peerRoot);
      assert.equal(guard.status, 1, guard.stdout + guard.stderr);
      assert.match(`${guard.stdout}\n${guard.stderr}`, /peer-host/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
