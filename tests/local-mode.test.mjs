import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  FOUNDATION_PACKAGE_NAME,
  FoundationLocalModeService,
  NodeProcessRunner,
  inspectFoundationMode
} from "../packages/engineering-foundation/dist/local-mode/index.js";
import { FOUNDATION_REQUIRED_ARTIFACT_PATHS } from "../packages/engineering-foundation/dist/package-self-check.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const REGISTRY_INTEGRITY =
  "sha512-bIIjRzA6EHhga2N0sRQ1R5zZSnP3YJ9q8JcD1QmQf3uVn3f2r6q1aXJf0Hb2U5QG6QH0xBvM1nHqN9vQ9w==";
const HOLDER_PATH = fileURLToPath(
  new URL("./fixtures/operation-lock-holder.mjs", import.meta.url)
);
const SERVICE_MODULE_PATH = fileURLToPath(
  new URL(
    "../packages/engineering-foundation/dist/local-mode/service.js",
    import.meta.url
  )
);

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createPackage(path, version) {
  await writeJson(join(path, "package.json"), {
    name: FOUNDATION_PACKAGE_NAME,
    version,
    type: "module"
  });
}

async function writeRegistryLock(
  consumerRoot,
  version,
  {
    lockedSpecifier = version,
    lockedVersion = version,
    integrity = REGISTRY_INTEGRITY,
    override = false,
    patch = false,
    writeVirtualStore = true
  } = {}
) {
  const packageKey = `${FOUNDATION_PACKAGE_NAME}@${version}`;
  const snapshotKey = `${FOUNDATION_PACKAGE_NAME}@${lockedVersion}`;
  const lines = [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    ""
  ];
  if (override) {
    lines.push(
      "overrides:",
      `  ${JSON.stringify(FOUNDATION_PACKAGE_NAME)}: ${JSON.stringify(version)}`,
      ""
    );
  }
  if (patch) {
    lines.push(
      "patchedDependencies:",
      `  ${JSON.stringify(packageKey)}:`,
      '    path: "patches/foundation.patch"',
      '    hash: "test-patch-hash"',
      ""
    );
  }
  lines.push(
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    `      ${JSON.stringify(FOUNDATION_PACKAGE_NAME)}:`,
    `        specifier: ${JSON.stringify(lockedSpecifier)}`,
    `        version: ${JSON.stringify(lockedVersion)}`,
    "",
    "packages:",
    "",
    `  ${JSON.stringify(packageKey)}:`,
    `    resolution: {integrity: ${JSON.stringify(integrity)}}`,
    "",
    "snapshots:",
    "",
    `  ${JSON.stringify(snapshotKey)}: {}`,
    ""
  );
  const source = `${lines.join("\n")}\n`;
  await writeFile(join(consumerRoot, "pnpm-lock.yaml"), source, "utf8");
  if (writeVirtualStore) {
    const virtualStoreRoot = join(consumerRoot, "node_modules", ".pnpm");
    await mkdir(virtualStoreRoot, { recursive: true });
    await writeFile(join(virtualStoreRoot, "lock.yaml"), source, "utf8");
  }
}

async function createTargetPackage(path, version) {
  const selfCheck = {
    ok: true,
    metadataSchemaVersion: 1,
    packageName: FOUNDATION_PACKAGE_NAME,
    packageVersion: version,
    localModeProtocolVersion: 1,
    compatibleLocalModeProtocolVersions: [1],
    exportPaths: [
      ".",
      "./local-mode",
      "./package.json",
      "./presets/*",
      "./schemas/*",
    ],
    runtimeDependencies: {}
  };
  await writeJson(join(path, "package.json"), {
    name: FOUNDATION_PACKAGE_NAME,
    version,
    type: "module",
    bin: {
      "agent-teams-foundation": "./dist/cli.js"
    },
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js"
      },
      "./local-mode": {
        types: "./dist/local-mode/index.d.ts",
        import: "./dist/local-mode/index.js"
      },
      "./schemas/*": "./schemas/*",
      "./presets/*": "./presets/*",
      "./package.json": "./package.json"
    },
    agentTeamsFoundation: {
      metadataSchemaVersion: 1,
      localModeProtocolVersion: 1,
      compatibleLocalModeProtocolVersions: [1]
    },
    dependencies: {}
  });
  for (const artifactPath of FOUNDATION_REQUIRED_ARTIFACT_PATHS) {
    const targetPath = join(path, artifactPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(
      targetPath,
      artifactPath.endsWith(".json")
        ? "{}\n"
        : artifactPath.endsWith(".d.ts")
          ? ""
          : "export {};\n",
      "utf8",
    );
  }
  await writeFile(
    join(path, "dist", "cli.js"),
    `process.stdout.write(${JSON.stringify(`${JSON.stringify(selfCheck)}\n`)});\n`,
    "utf8"
  );
  await writeFile(
    join(path, "dist", "index.js"),
    "export class FoundationError extends Error {}\n",
    "utf8"
  );
  await writeFile(
    join(path, "dist", "local-mode", "index.js"),
    "export class FoundationLocalModeService {}\nexport function inspectFoundationMode() {}\n",
    "utf8"
  );
}

async function replaceWithDirectory(path, version) {
  await rm(path, { force: true, recursive: true });
  await createPackage(path, version);
}

class FakeProcessRunner {
  constructor({ failAttachedStatus = false }) {
    this.failAttachedStatus = failAttachedStatus;
    this.gitCommitRequests = 0;
    this.requests = [];
    this.nodeRunner = new NodeProcessRunner();
  }

  async run(request) {
    this.requests.push(request);
    if (request.command === "git" && request.args.includes("--git-path")) {
      return { stdout: ".git/info/exclude\n", stderr: "" };
    }
    if (request.command === "git" && request.args.includes("rev-parse")) {
      this.gitCommitRequests += 1;
      if (this.failAttachedStatus && this.gitCommitRequests > 1) {
        throw new Error("Simulated post-attach status failure.");
      }
      return { stdout: `${COMMIT}\n`, stderr: "" };
    }
    if (request.command === "git" && request.args.includes("status")) {
      return { stdout: "", stderr: "" };
    }
    if (request.command === process.execPath) {
      return await this.nodeRunner.run(request);
    }
    throw new Error(`Unexpected process request: ${JSON.stringify(request)}`);
  }
}

async function createFixture({ failAttachedStatus = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "foundation-local-mode-"));
  const consumerRoot = join(root, "consumer");
  const targetRepositoryRoot = join(root, "foundation");
  const targetPackageRoot = join(
    targetRepositoryRoot,
    "packages",
    "engineering-foundation"
  );
  const registryVersion = "1.2.3";

  await writeJson(join(consumerRoot, "package.json"), {
    name: "consumer",
    version: "0.0.0",
    private: true,
    packageManager: "pnpm@11.18.0",
    devDependencies: {
      [FOUNDATION_PACKAGE_NAME]: registryVersion
    }
  });
  await writeRegistryLock(consumerRoot, registryVersion);
  await mkdir(join(consumerRoot, ".git", "info"), { recursive: true });
  await writeFile(join(consumerRoot, ".git", "info", "exclude"), "", "utf8");
  await replaceWithDirectory(
    join(
      consumerRoot,
      "node_modules",
      "@agent-teams",
      "engineering-foundation"
    ),
    registryVersion
  );

  await createTargetPackage(targetPackageRoot, "1.3.0-dev.1");

  const runner = new FakeProcessRunner({
    failAttachedStatus
  });
  const service = new FoundationLocalModeService({
    runner,
    now: () => new Date("2026-07-29T12:00:00.000Z")
  });

  return {
    consumerRoot,
    root,
    runner,
    service,
    targetPackageRoot,
    targetRepositoryRoot
  };
}

async function startOperationLockHolder(consumerRoot) {
  const child = spawn(
    process.execPath,
    [HOLDER_PATH, SERVICE_MODULE_PATH, consumerRoot],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  await new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (chunk.includes("READY")) {
        resolve();
      }
    });
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `Lock holder exited before ready: code=${String(code)} signal=${String(signal)} ${stderr}`
        )
      );
    });
  });
  return child;
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    child.once("exit", resolve);
  });
}

test("attaches, reports local evidence, and restores registry mode", async () => {
  const fixture = await createFixture();
  try {
    const unrelatedStatePath = join(
      fixture.consumerRoot,
      ".agent-teams-local",
      "unrelated-capability.json"
    );
    await writeJson(unrelatedStatePath, { ownedBy: "another-capability" });
    assert.equal((await fixture.service.status(fixture.consumerRoot)).mode, "REGISTRY");

    const attached = await fixture.service.attach(
      fixture.consumerRoot,
      fixture.targetRepositoryRoot
    );
    assert.equal(attached.status.mode, "LOCAL");
    assert.equal(attached.status.linkState?.gitCommit, COMMIT);
    assert.equal(attached.status.linkState?.gitDirty, false);
    assert.equal(attached.status.sourceGitCommit, COMMIT);
    assert.equal(attached.status.sourceGitDirty, false);

    const exclude = await readFile(
      join(fixture.consumerRoot, ".git", "info", "exclude"),
      "utf8"
    );
    assert.match(exclude, /^\.agent-teams-local\/$/mu);

    const restored = await fixture.service.detach(fixture.consumerRoot);
    assert.equal(restored.mode, "REGISTRY");
    assert.equal(restored.installedVersion, "1.2.3");
    assert.deepEqual(
      JSON.parse(await readFile(unrelatedStatePath, "utf8")),
      { ownedBy: "another-capability" }
    );
    assert.equal(
      fixture.runner.requests.some((request) => request.command === "pnpm"),
      false
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("detects a tampered local marker instead of guessing", async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.attach(
      fixture.consumerRoot,
      fixture.targetRepositoryRoot
    );
    const markerPath = join(
      fixture.consumerRoot,
      ".agent-teams-local",
      "foundation-link.json"
    );
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    marker.targetPackageRoot = join(fixture.root, "different-package");
    await writeJson(markerPath, marker);

    const status = await inspectFoundationMode(fixture.consumerRoot);
    assert.equal(status.mode, "INVALID");
    assert.ok(
      status.issues.includes(
        "Installed foundation path does not match local state."
      )
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects floating consumer dependency specifications", async () => {
  const fixture = await createFixture();
  try {
    const manifestPath = join(fixture.consumerRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.devDependencies[FOUNDATION_PACKAGE_NAME] = "^1.2.3";
    await writeJson(manifestPath, manifest);

    await assert.rejects(
      fixture.service.attach(
        fixture.consumerRoot,
        fixture.targetRepositoryRoot
      ),
      /must be in valid registry mode/u
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("enforces an exact development-only consumer dependency", async () => {
  const fixture = await createFixture();
  try {
    const manifestPath = join(fixture.consumerRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.dependencies = {
      [FOUNDATION_PACKAGE_NAME]: manifest.devDependencies[FOUNDATION_PACKAGE_NAME]
    };
    await writeJson(manifestPath, manifest);

    await assert.rejects(
      fixture.service.assertDevOnly(fixture.consumerRoot),
      /must not be declared in dependencies/u
    );
    assert.equal(
      (await inspectFoundationMode(fixture.consumerRoot)).mode,
      "INVALID"
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects non-registry lockfile sources", async (context) => {
  for (const lockedVersion of [
    "file:../engineering-foundation.tgz",
    "link:../engineering-foundation",
    "workspace:../engineering-foundation",
    "git+https://github.com/agent-teams-ai/engineering-foundation.git#main",
    "https://example.test/engineering-foundation.tgz"
  ]) {
    await context.test(lockedVersion, async () => {
      const fixture = await createFixture();
      try {
        await writeRegistryLock(fixture.consumerRoot, "1.2.3", {
          lockedVersion
        });
        const status = await inspectFoundationMode(fixture.consumerRoot);
        assert.equal(status.mode, "INVALID");
        assert.ok(
          status.issues.some((issue) =>
            issue.includes("specifier must equal the exact manifest version")
          )
        );
      } finally {
        await rm(fixture.root, { force: true, recursive: true });
      }
    });
  }
});

test("accepts exact registry versions with pnpm peer contexts", async (context) => {
  for (const lockedVersion of [
    "1.2.3(@types/node@24.13.3)",
    "1.2.3(@scope/peer@2.0.0(transitive-peer@3.0.0))"
  ]) {
    await context.test(lockedVersion, async () => {
      const fixture = await createFixture();
      try {
        await writeRegistryLock(fixture.consumerRoot, "1.2.3", {
          lockedVersion
        });
        const status = await inspectFoundationMode(fixture.consumerRoot);
        assert.equal(status.mode, "REGISTRY");
      } finally {
        await rm(fixture.root, { force: true, recursive: true });
      }
    });
  }
});

test("rejects malformed pnpm peer contexts", async (context) => {
  for (const lockedVersion of [
    "1.2.30(@types/node@24.13.3)",
    "1.2.3()",
    "1.2.3(peer@2.0.0",
    "1.2.3(peer @2.0.0)"
  ]) {
    await context.test(lockedVersion, async () => {
      const fixture = await createFixture();
      try {
        await writeRegistryLock(fixture.consumerRoot, "1.2.3", {
          lockedVersion
        });
        const status = await inspectFoundationMode(fixture.consumerRoot);
        assert.equal(status.mode, "INVALID");
        assert.ok(
          status.issues.some((issue) =>
            issue.includes("specifier must equal the exact manifest version")
          )
        );
      } finally {
        await rm(fixture.root, { force: true, recursive: true });
      }
    });
  }
});

test("rejects peer-context drift in the installed lockfile", async () => {
  const fixture = await createFixture();
  try {
    const rootVersion = "1.2.3(@types/node@24.13.3)";
    await writeRegistryLock(fixture.consumerRoot, "1.2.3", {
      lockedVersion: rootVersion
    });
    const virtualStoreLockPath = join(
      fixture.consumerRoot,
      "node_modules",
      ".pnpm",
      "lock.yaml"
    );
    await writeFile(
      virtualStoreLockPath,
      (await readFile(virtualStoreLockPath, "utf8")).replaceAll(
        rootVersion,
        "1.2.3(@types/node@24.14.0)"
      ),
      "utf8"
    );

    const status = await inspectFoundationMode(fixture.consumerRoot);
    assert.equal(status.mode, "INVALID");
    assert.ok(
      status.issues.some((issue) =>
        issue.includes("root and installed pnpm lockfile provenance")
      )
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects foundation lockfile overrides and patches", async (context) => {
  for (const option of [{ override: true }, { patch: true }]) {
    await context.test(JSON.stringify(option), async () => {
      const fixture = await createFixture();
      try {
        await writeRegistryLock(fixture.consumerRoot, "1.2.3", option);
        const status = await inspectFoundationMode(fixture.consumerRoot);
        assert.equal(status.mode, "INVALID");
        assert.ok(
          status.issues.some(
            (issue) =>
              issue.includes("lockfile overrides") ||
              issue.includes("lockfile patches")
          )
        );
      } finally {
        await rm(fixture.root, { force: true, recursive: true });
      }
    });
  }
});

test("rejects registry lock entries without sha512 integrity", async () => {
  const fixture = await createFixture();
  try {
    await writeRegistryLock(fixture.consumerRoot, "1.2.3", {
      integrity: "sha256-not-accepted"
    });
    const status = await inspectFoundationMode(fixture.consumerRoot);
    assert.equal(status.mode, "INVALID");
    assert.ok(
      status.issues.some((issue) => issue.includes("sha512 registry integrity"))
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects a stale local install hidden by only rewriting the root lockfile", async () => {
  const fixture = await createFixture();
  try {
    await writeRegistryLock(fixture.consumerRoot, "1.2.3", {
      writeVirtualStore: false
    });
    const virtualStoreLockPath = join(
      fixture.consumerRoot,
      "node_modules",
      ".pnpm",
      "lock.yaml"
    );
    await writeFile(
      virtualStoreLockPath,
      (await readFile(virtualStoreLockPath, "utf8")).replace(
        /version: "1\.2\.3"/u,
        'version: "file:../engineering-foundation.tgz"'
      ),
      "utf8"
    );

    const status = await inspectFoundationMode(fixture.consumerRoot);
    assert.equal(status.mode, "INVALID");
    assert.ok(
      status.issues.some((issue) =>
        issue.includes("installed pnpm virtual-store lockfile")
      )
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects a target whose real CLI self-check does not run", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(
      join(fixture.targetPackageRoot, "dist", "cli.js"),
      "",
      "utf8"
    );
    await assert.rejects(
      fixture.service.attach(
        fixture.consumerRoot,
        fixture.targetRepositoryRoot
      ),
      /self-check did not return a valid result/u
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects a target with broken runtime exports", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(
      join(fixture.targetPackageRoot, "dist", "index.js"),
      "",
      "utf8"
    );
    await assert.rejects(
      fixture.service.attach(
        fixture.consumerRoot,
        fixture.targetRepositoryRoot
      ),
      /runtime export is unavailable/u
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects incompatible target protocol metadata", async () => {
  const fixture = await createFixture();
  try {
    const manifestPath = join(fixture.targetPackageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.agentTeamsFoundation.compatibleLocalModeProtocolVersions = [2];
    await writeJson(manifestPath, manifest);

    await assert.rejects(
      fixture.service.attach(
        fixture.consumerRoot,
        fixture.targetRepositoryRoot
      ),
      /does not support local-mode protocol 1/u
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects unresolved target runtime dependencies", async () => {
  const fixture = await createFixture();
  try {
    const manifestPath = join(fixture.targetPackageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.dependencies = {
      "@agent-teams/definitely-missing": "1.0.0"
    };
    await writeJson(manifestPath, manifest);

    await assert.rejects(
      fixture.service.attach(
        fixture.consumerRoot,
        fixture.targetRepositoryRoot
      ),
      /runtime dependency cannot be resolved/u
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("restores registry mode when final attach verification fails", async () => {
  const fixture = await createFixture({ failAttachedStatus: true });
  try {
    await assert.rejects(
      fixture.service.attach(
        fixture.consumerRoot,
        fixture.targetRepositoryRoot
      ),
      /registry installation was restored/u
    );

    const status = await inspectFoundationMode(fixture.consumerRoot);
    assert.equal(status.mode, "REGISTRY");
    assert.equal(status.installedVersion, "1.2.3");
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("finishes detach after a crash restored the registry entry", async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.attach(
      fixture.consumerRoot,
      fixture.targetRepositoryRoot
    );
    const statePath = join(
      fixture.consumerRoot,
      ".agent-teams-local",
      "foundation-link.json"
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.phase = "DETACHING";
    await writeJson(statePath, state);

    const installedPackagePath = join(
      fixture.consumerRoot,
      "node_modules",
      "@agent-teams",
      "engineering-foundation"
    );
    await rm(installedPackagePath, { force: true, recursive: true });
    await rename(
      join(
        fixture.consumerRoot,
        ".agent-teams-local",
        "foundation-registry-backup"
      ),
      installedPackagePath
    );

    const restored = await fixture.service.detach(fixture.consumerRoot);
    assert.equal(restored.mode, "REGISTRY");
    assert.equal(restored.installedVersion, "1.2.3");
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("reclaims an operation lock after its owner process is killed", async () => {
  const fixture = await createFixture();
  let holder;
  try {
    holder = await startOperationLockHolder(fixture.consumerRoot);
    holder.kill("SIGKILL");
    await waitForExit(holder);
    const lockRoot = join(
      fixture.consumerRoot,
      ".agent-teams-local",
      "foundation-operation.lock"
    );
    await utimes(lockRoot, new Date(0), new Date(0));

    const attached = await fixture.service.attach(
      fixture.consumerRoot,
      fixture.targetRepositoryRoot
    );
    assert.equal(attached.status.mode, "LOCAL");
  } finally {
    if (holder !== undefined && holder.exitCode === null) {
      holder.kill("SIGKILL");
      await waitForExit(holder);
    }
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects a concurrent operation owned by a live process", async () => {
  const fixture = await createFixture();
  let holder;
  try {
    holder = await startOperationLockHolder(fixture.consumerRoot);

    await assert.rejects(
      fixture.service.attach(
        fixture.consumerRoot,
        fixture.targetRepositoryRoot
      ),
      /operation is active or its lock is not safely recoverable/u
    );
    assert.equal((await inspectFoundationMode(fixture.consumerRoot)).mode, "INVALID");
  } finally {
    if (holder !== undefined && holder.exitCode === null) {
      holder.kill("SIGTERM");
      await waitForExit(holder);
    }
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects a local state directory redirected outside the consumer", async () => {
  const fixture = await createFixture();
  try {
    const externalStateRoot = join(fixture.root, "external-state");
    await mkdir(externalStateRoot, { recursive: true });
    await symlink(
      externalStateRoot,
      join(fixture.consumerRoot, ".agent-teams-local"),
      process.platform === "win32" ? "junction" : "dir"
    );

    await assert.rejects(
      fixture.service.attach(
        fixture.consumerRoot,
        fixture.targetRepositoryRoot
      ),
      /real consumer-owned directory/u
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("restores from backup when the local checkout disappears", async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.attach(
      fixture.consumerRoot,
      fixture.targetRepositoryRoot
    );
    await rm(fixture.targetRepositoryRoot, { force: true, recursive: true });

    const restored = await fixture.service.detach(fixture.consumerRoot);
    assert.equal(restored.mode, "REGISTRY");
    assert.equal(restored.installedVersion, "1.2.3");
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("recovers an orphan backup without trusting an absent marker", async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.attach(
      fixture.consumerRoot,
      fixture.targetRepositoryRoot
    );
    await rm(
      join(
        fixture.consumerRoot,
        ".agent-teams-local",
        "foundation-link.json"
      ),
      { force: true }
    );

    const interrupted = await inspectFoundationMode(fixture.consumerRoot);
    assert.equal(interrupted.mode, "INVALID");
    assert.ok(
      interrupted.issues.includes(
        "An orphan registry backup requires detach recovery."
      )
    );

    const restored = await fixture.service.detach(fixture.consumerRoot);
    assert.equal(restored.mode, "REGISTRY");
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects recovery paths outside the consumer boundary", async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.attach(
      fixture.consumerRoot,
      fixture.targetRepositoryRoot
    );
    const statePath = join(
      fixture.consumerRoot,
      ".agent-teams-local",
      "foundation-link.json"
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.registryPackageRoot = fixture.targetPackageRoot;
    await writeJson(statePath, state);

    await assert.rejects(
      fixture.service.detach(fixture.consumerRoot),
      /paths outside its consumer-owned boundary/u
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});
