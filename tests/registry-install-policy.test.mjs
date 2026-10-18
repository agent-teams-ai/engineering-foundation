import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

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

function bunCli() {
  return process.env.AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE ??
    fileURLToPath(new URL("../node_modules/.job-scratch/toolchains/bun/bun-linux-x64/bun", import.meta.url));
}

function pnpmCli() {
  const directories = (process.env.PATH ?? "").split(delimiter);
  const candidates = [
    ...directories.flatMap((directory) => [
      ...(process.platform === "win32"
        ? [join(directory, "pnpm.exe"), join(directory, "pnpm.cmd"), join(directory, "pnpm")]
        : [join(directory, "pnpm")]),
      join(directory, "pnpm.mjs"), join(directory, "pnpm.cjs"),
    ]), process.env.npm_execpath].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) { continue; }
    const resolved = realpathSync(candidate);
    if ([".mjs", ".cjs", ".js"].includes(extname(resolved))) {
      return { command: process.execPath, prefix: [resolved] };
    }
    // A Windows command shim is not executable by Node without a shell. Resolve
    // only the pnpm package installed beside that selected shim.
    if (process.platform === "win32" && extname(resolved).toLowerCase() === ".cmd") {
      for (const packageDir of [
        join(dirname(candidate), "..", "pnpm", "bin"),
        join(dirname(candidate), "node_modules", "pnpm", "bin"),
      ]) {
        for (const entry of ["pnpm.mjs", "pnpm.cjs"]) {
          const adjacent = join(packageDir, entry);
          if (existsSync(adjacent)) {
            return { command: process.execPath, prefix: [realpathSync(adjacent)] };
          }
        }
      }
      throw new Error(`The selected pnpm command shim has no adjacent JavaScript CLI: ${resolved}`);
    }
    return { command: resolved, prefix: [] };
  }
  throw new Error("The selected pnpm executable was not found on PATH.");
}

function runPnpm(cli, root, args) {
  return spawnSync(cli.command, [...cli.prefix, ...args], { cwd: root, encoding: "utf8" });
}

function runBun(root, args) {
  return spawnSync(bunCli(), args, { cwd: root, encoding: "utf8" });
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

test("compatibility and release installs check the frozen peer graph before qualification", async () => {
  const ci = YAML.parse(await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const release = YAML.parse(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
  const compatibility = ci.jobs["node26-compatibility"].steps.map(({ run }) => run).filter(Boolean);
  const frozenIndex = compatibility.indexOf("pnpm install --frozen-lockfile --ignore-scripts --engine-strict");
  assert.ok(frozenIndex >= 0);
  assert.equal(compatibility[frozenIndex + 1], "pnpm dependencies:peers:check");
  let releaseInstalls = 0;
  for (const job of Object.values(release.jobs)) {
    const commands = job.steps?.map(({ run }) => run).filter(Boolean) ?? [];
    for (const [index, command] of commands.entries()) {
      if (command === "pnpm install --frozen-lockfile --ignore-scripts") {
        releaseInstalls += 1;
        assert.equal(commands[index + 1], "pnpm dependencies:peers:check");
      }
    }
  }
  assert.equal(releaseInstalls, 2);
});

test("pnpm 11 rejects incompatible engines and peers under the repository install policy", async () => {
  const rootManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(rootManifest.packageManager, "bun@1.4.3");
  assert.equal(packageManager, "pnpm@11.20.0");
  const cli = pnpmCli();
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
  const root = await mkdtemp(join(tmpdir(), "foundation-bun-strict-"));
  try {
    const engineRoot = join(root, "engine");
    await mkdir(join(engineRoot, "engine-dep"), { recursive: true });
    await writeFile(join(engineRoot, "package.json"), manifest("engine-reject-fixture", {
      private: true, packageManager: "bun@1.4.3", dependencies: { "engine-dep": "file:./engine-dep" }
    }));
    await writeFile(join(engineRoot, "engine-dep", "package.json"), manifest("engine-dep", {
      engines: { node: ">=27" }
    }));
    assert.equal(runBun(engineRoot, ["install", "--lockfile-only", "--ignore-scripts"]).status, 0);
    assert.equal(runBun(engineRoot, ["install", "--frozen-lockfile", "--ignore-scripts", "--linker=isolated"]).status, 0);
    const engineGuard = runInstalledGuard(engineRoot);
    assert.equal(engineGuard.status, 1, engineGuard.stdout + engineGuard.stderr);
    assert.match(`${engineGuard.stdout}\n${engineGuard.stderr}`, /engine mismatch/iu);

    for (const [name, optional] of [["required-peer", false], ["bad-locked-optional-peer", true]]) {
      const peerRoot = join(root, name);
      await mkdir(join(peerRoot, "peer-host"), { recursive: true });
      await mkdir(join(peerRoot, "peer-client"), { recursive: true });
      await writeFile(join(peerRoot, "package.json"), manifest(`${name}-fixture`, {
        private: true, packageManager: "bun@1.4.3", dependencies: {
          "peer-host": "file:./peer-host", "peer-client": "file:./peer-client"
        }
      }));
      await writeFile(join(peerRoot, "peer-host", "package.json"), manifest("peer-host"));
      await writeFile(join(peerRoot, "peer-client", "package.json"), manifest("peer-client", {
        peerDependencies: { "peer-host": ">=2" },
        ...(optional ? { peerDependenciesMeta: { "peer-host": { optional: true } } } : {})
      }));
      assert.equal(runBun(peerRoot, ["install", "--lockfile-only", "--ignore-scripts"]).status, 0);
      const frozen = runBun(peerRoot, ["install", "--frozen-lockfile", "--ignore-scripts", "--linker=isolated"]);
      assert.equal(frozen.status, 0, frozen.stdout + frozen.stderr);
      const guard = runInstalledGuard(peerRoot);
      assert.equal(guard.status, 1, guard.stdout + guard.stderr);
      assert.match(`${guard.stdout}\n${guard.stderr}`, /peer-host/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
