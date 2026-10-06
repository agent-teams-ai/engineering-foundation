import assert from "node:assert/strict";
import { ChildProcess, type spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ManagedPnpmInstallInput, RuntimeFileIdentity } from "../dist/consumer-integration/application/ports/managed-runtime.js";
import type { ManagedRuntimeAttempt } from "../dist/consumer-integration/adapters/node-managed-runtime-attempt.js";
import type { ManagedPnpmInstallation } from "../dist/consumer-integration/adapters/node-managed-runtime-install.js";
import type { RuntimeImage, TrustedRuntimeSelection } from "../dist/consumer-integration/adapters/node-managed-runtime-identity.js";

type SpawnCall = Parameters<typeof spawn>;
type ProbeRunner = typeof import("../dist/consumer-integration/adapters/node-managed-runtime-process.js").runManagedProbe;
type InstallerConstructor = typeof ManagedPnpmInstallation;

const trustedDigest = "a".repeat(64);
const selection: TrustedRuntimeSelection = {
  selectedNode: { path: "/managed-environment-test/node", expectedSha256: trustedDigest },
  pnpmPackage: {
    root: "/managed-environment-test/pnpm",
    expectedManifestSha256: trustedDigest,
    expectedEntrySha256: trustedDigest,
    expectedTreeDigest: trustedDigest,
    entryRelativePath: "bin/pnpm.mjs"
  },
  expected: { nodeVersion: "24.21.0", pnpmVersion: "11.20.0", platform: "linux", architecture: "x64" },
  launcher: "direct-node"
};

function fixtureIdentity(path: string): RuntimeFileIdentity {
  return { realpath: path, sha256: trustedDigest, byteLength: 0, mode: 0o100755,
    device: "1", inode: "1", birthtimeNs: "0", ctimeNs: "0", mtimeNs: "0" };
}

const image: RuntimeImage = {
  nodePath: selection.selectedNode.path,
  rootPath: selection.pnpmPackage.root,
  node: fixtureIdentity(selection.selectedNode.path),
  manifest: fixtureIdentity(join(selection.pnpmPackage.root, "package.json")),
  entry: fixtureIdentity(join(selection.pnpmPackage.root, "bin/pnpm.mjs")),
  treeDigest: trustedDigest,
  treeWitness: trustedDigest
};

function installationOwner(root: string, verify: () => Promise<boolean>): ConstructorParameters<InstallerConstructor>[0] {
  const attempt: ManagedRuntimeAttempt = {
    ["token"]: "b".repeat(64),
    evidencePath: join(root, "attempt.json"),
    ownedRoot: root,
    verifyOwnedRoot: verify,
    transition: async () => { throw new Error("unexpected-child-reservation"); },
    close: async () => ({ outcome: "closed" })
  };
  return { selection, image, attempt };
}

function installInput(): ManagedPnpmInstallInput {
  return {
    root: { kind: "managed-owned-installation-root" },
    runtime: { kind: "managed-runtime-handle" },
    mode: "prepare",
    expectedManifestDigest: trustedDigest,
    expectedWorkspaceDigest: trustedDigest,
    expectedLockDigest: null,
    signal: new AbortController().signal
  };
}

async function withConflictingParentEnvironment(action: () => Promise<void>): Promise<void> {
  const conflicting: Readonly<Record<string, string>> = {
    NODE_OPTIONS: "--require=/unsupported/injected.cjs",
    NODE_PATH: "/unsupported/modules",
    npm_config_node_options: "--require=/unsupported/npm-injected.cjs",
    pnpm_config_node_options: "--require=/unsupported/pnpm-injected.cjs",
    npm_config_use_node_version: "99.0.0",
    pnpm_config_use_node_version: "99.0.0",
    npm_config_engine_strict: "false",
    pnpm_config_engine_strict: "0",
    npm_config_strict_peer_dependencies: "false",
    pnpm_config_strict_peer_dependencies: "off",
    npm_config_verify_store_integrity: "false",
    pnpm_config_verify_store_integrity: "no",
    npm_config_manage_package_manager_versions: "true",
    pnpm_config_manage_package_manager_versions: "yes",
    PATH: "/unsupported/launchers",
    MANAGED_BOUNDARY_TEST_PARENT_ONLY: "do-not-forward"
  };
  const previous = new Map<string, string | undefined>();
  for (const name of Object.keys(conflicting)) {
    previous.set(name, process.env[name]);
  }
  try {
    for (const [name, value] of Object.entries(conflicting)) {
      process.env[name] = value;
    }
    await action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

async function assertEffectiveChildEnvironment(run: ProbeRunner, launches: SpawnCall[]): Promise<void> {
  const cwd = "/managed-environment-test/owned";
  for (const kind of ["pnpm-install-prepare", "pnpm-install-frozen-offline", "pnpm-peers-check"] as const) {
    const before = launches.length;
    const result = await run({ image, expected: selection.expected, cwd, kind,
      signal: new AbortController().signal });
    assert.equal(result.code, "spawn-failed");
    assert.equal(result.facts.spawned, false);
    assert.equal(launches.length, before + 1);
    const launch = launches[before];
    assert.ok(launch);
    const [command, argv, options] = launch;
    assert.equal(command, image.nodePath);
    assert.ok(argv[0]?.endsWith("managed-runtime-probe.js"));
    assert.deepEqual(argv.slice(1), [kind, join(image.rootPath, "bin/pnpm.mjs")]);
    assert.equal(options.cwd, cwd);
    assert.equal(options.shell, false);
    assert.equal(options.detached, true);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe", "pipe", "pipe"]);
    assert.deepEqual(options.env, {
      CI: "true", LANG: "C", LC_ALL: "C", TZ: "UTC",
      TMPDIR: cwd, XDG_CACHE_HOME: cwd, XDG_CONFIG_HOME: cwd, XDG_DATA_HOME: cwd,
      NODE_COMPILE_CACHE: join(cwd, "node-compile-cache"),
      npm_config_userconfig: join(cwd, "user.npmrc"),
      npm_config_globalconfig: join(cwd, "global.npmrc"),
      npm_config_manage_package_manager_versions: "false",
      npm_config_engine_strict: "true", npm_config_strict_peer_dependencies: "true",
      COREPACK_ENABLE_NETWORK: "0"
    });
  }
}

async function assertUnownedRootRefusal(Installer: InstallerConstructor, launches: SpawnCall[]): Promise<void> {
  let verified = 0;
  const before = launches.length;
  const installer = new Installer(installationOwner("/managed-environment-test/unowned", async () => {
    verified += 1;
    return false;
  }));
  const result = await installer.install(installInput());
  assert.ok(result.outcome === "refused");
  assert.equal(result.code, "identity-changed");
  assert.equal(result.facts.spawned, false);
  assert.equal(result.debt, null);
  assert.equal(verified, 1);
  assert.equal(launches.length, before);
}

async function assertEffectiveConfigurationRefusals(Installer: InstallerConstructor, launches: SpawnCall[]): Promise<void> {
  for (const name of [".npmrc", "user.npmrc", "global.npmrc", ".pnpmfile.cjs", "pnpmfile.cjs", ".pnpmfile.mjs"]) {
    const root = await mkdtemp(join(tmpdir(), "managed-effective-environment-"));
    try {
      const configuration = name.endsWith(".npmrc")
        ? "engine-strict=false\nstrict-peer-dependencies=false\nverify-store-integrity=false\nnode-options=--require=/unsupported/injected.cjs\n"
        : "throw new Error('unexpected hook execution');\n";
      await writeFile(join(root, name), configuration, { flag: "wx" });
      let verified = 0;
      const before = launches.length;
      const installer = new Installer(installationOwner(root, async () => {
        verified += 1;
        return true;
      }));
      const result = await installer.install(installInput());
      assert.ok(result.outcome === "refused");
      assert.equal(result.code, "invalid-selection", name);
      assert.equal(result.facts.spawned, false, name);
      assert.equal(result.debt, null, name);
      assert.equal(verified, 1, name);
      assert.equal(launches.length, before, name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

void test("managed effective environment boundary", async (t) => {
  const launches: SpawnCall[] = [];
  const interceptedSpawn = (...parameters: SpawnCall): ReturnType<typeof spawn> => {
    launches.push(parameters);
    return new ChildProcess();
  };
  t.mock.module("node:child_process", { namedExports: { spawn: interceptedSpawn } });
  const { runManagedProbe } = await import("../dist/consumer-integration/adapters/node-managed-runtime-process.js");
  const { ManagedPnpmInstallation: Installer } = await import("../dist/consumer-integration/adapters/node-managed-runtime-install.js");
  await withConflictingParentEnvironment(async () => {
    await t.test("parent settings cannot alter the fixed effective child environment or launcher", async () => {
      await assertEffectiveChildEnvironment(runManagedProbe, launches);
    });
    await t.test("irrelevant parent settings still reach the owned-root refusal", async () => {
      await assertUnownedRootRefusal(Installer, launches);
    });
    await t.test("effective configuration and injected hooks refuse before child reservation", async () => {
      await assertEffectiveConfigurationRefusals(Installer, launches);
    });
  });
});
