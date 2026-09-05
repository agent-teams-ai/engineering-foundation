import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstat,
  realpath,
  symlink,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LocalPackageLifecycle } from "../packages/engineering-foundation/dist/local-mode/application/service.js";
import { createNodeLocalPackageLifecyclePorts } from "../packages/engineering-foundation/dist/composition/local-mode-ports.js";
import { inspectConsumerManifest, inspectLockfile } from "../packages/engineering-foundation/dist/local-mode/application/consumer-policy.js";
import { parseDocument } from "yaml";


import {
  FOUNDATION_PACKAGE_NAME,
  FoundationLocalModeService,
  NodeProcessRunner as PublicNodeProcessRunner,
  inspectFoundationMode
} from "../packages/engineering-foundation/dist/local-mode/index.js";
import {
  FOUNDATION_PACKAGE_FILE_ALLOWLIST,
  FOUNDATION_REQUIRED_ARTIFACT_PATHS,
} from "../packages/engineering-foundation/dist/composition/local-package-artifacts.js";
import {
  compileKnownFileTransactionPlan,
} from "../packages/repository-mutation/dist/index.js";
import { applyKnownFileTransaction } from "../packages/repository-mutation/dist/qualification/index.js";
import { createNodeProcessRunner } from "../packages/engineering-foundation/dist/local-mode/composition/process-runner.js";

function NodeProcessRunner() {
  return process.platform === "win32"
    ? createNodeProcessRunner(process.env)
    : new PublicNodeProcessRunner();
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const strictDirectoryDurabilityTest = process.platform === "win32" ? test.skip : test;
const REGISTRY_INTEGRITY =
  "sha512-bIIjRzA6EHhga2N0sRQ1R5zZSnP3YJ9q8JcD1QmQf3uVn3f2r6q1aXJf0Hb2U5QG6QH0xBvM1nHqN9vQ9w==";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
  "cli.js"
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
      "./scaffolding",
      "./schemas/*",
    ],
    runtimeDependencies: {}
  };
  await writeJson(join(path, "package.json"), {
    name: FOUNDATION_PACKAGE_NAME,
    version,
    type: "module",
    files: FOUNDATION_PACKAGE_FILE_ALLOWLIST,
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
      "./scaffolding": {
        types: "./dist/scaffolding/index.d.ts",
        import: "./dist/scaffolding/index.js"
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
  await writeFile(
    join(path, "dist", "scaffolding", "index.js"),
    "export function planScaffoldFromFile() {}\nexport function applyFilesystemScaffold() {}\n",
    "utf8"
  );
}

async function replaceWithDirectory(path, version) {
  await rm(path, { force: true, recursive: true });
  await createPackage(path, version);
}

class FakeProcessRunner {
  constructor({ failAttachedStatus = false, blockExcludeLookup = false }) {
    this.failAttachedStatus = failAttachedStatus;
    this.blockExcludeLookup = blockExcludeLookup;
    this.gitCommitRequests = 0;
    this.requests = [];
    this.nodeRunner = new NodeProcessRunner();
    this.excludeLookupStarted = new Promise((resolve) => {
      this.resolveExcludeLookupStarted = resolve;
    });
    this.excludeLookupRelease = new Promise((resolve) => {
      this.resolveExcludeLookupRelease = resolve;
    });
  }

  async waitForExcludeLookup() {
    await this.excludeLookupStarted;
  }

  releaseExcludeLookup() {
    this.resolveExcludeLookupRelease();
  }

  async run(request) {
    this.requests.push(request);
    if (request.command === "git" && request.args.includes("--git-path")) {
      this.resolveExcludeLookupStarted();
      if (this.blockExcludeLookup) {
        await this.excludeLookupRelease;
      }
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

async function createFixture(
  { failAttachedStatus = false, blockExcludeLookup = false } = {}
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foundation-local-mode-")));
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
    failAttachedStatus,
    blockExcludeLookup
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

test("blocks attach and detach while a foreign Foundation transaction is pending", async () => {
  const fixture = await createFixture();
  try {
    const transactionPath = join(
      fixture.consumerRoot,
      ".agent-teams-local",
      "scaffolding-transaction.json"
    );
    await writeJson(transactionPath, {
      schemaVersion: 99,
      operationKind: "future-mutation"
    });
    const original = await readFile(transactionPath);
    await assert.rejects(
      fixture.service.attach(
        fixture.consumerRoot,
        fixture.targetRepositoryRoot
      ),
      (error) => {
        assert.equal(
          error?.code,
          "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED"
        );
        return true;
      }
    );
    await assert.rejects(
      fixture.service.detach(fixture.consumerRoot),
      (error) => {
        assert.equal(
          error?.code,
          "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED"
        );
        return true;
      }
    );
    assert.deepEqual(await readFile(transactionPath), original);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("status JSON remains one parseable object when transaction recovery is required", async () => {
  const fixture = await createFixture();
  try {
    await writeJson(
      join(
        fixture.consumerRoot,
        ".agent-teams-local",
        "scaffolding-transaction.json"
      ),
      { schemaVersion: 99, operationKind: "future-mutation" }
    );
    const result = spawnSync(
      process.execPath,
      [cliPath, "status", "--consumer", fixture.consumerRoot, "--json"],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const status = JSON.parse(result.stdout);
    assert.equal(status.mode, "INVALID");
    assert.equal(status.transaction.state, "manual-recovery-required");
    assert.doesNotMatch(result.stdout, /\nTransaction:/u);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

strictDirectoryDurabilityTest("Foundation status preserves leaf known-file evidence for explicit recovery", async () => {
  const fixture = await createFixture();
  try {
    const plan = compileKnownFileTransactionPlan({
      operations: [{
        path: "known-file-status-probe.txt",
        precondition: { state: "absent" },
        postimage: { bytes: Buffer.from("probe\n"), mode: 0o644 },
      }],
    });
    await assert.rejects(
      applyKnownFileTransaction({
        consumerRoot: fixture.consumerRoot,
        plan,
        faultInjector(point) {
          if (point.phase === "after-journal-created") {
            throw new Error("status projection probe");
          }
        },
      }),
      /status projection probe/u,
    );

    const status = await inspectFoundationMode(fixture.consumerRoot);
    assert.equal(status.mode, "INVALID");
    assert.equal(status.transaction?.state, "pending");
    assert.equal(status.transaction?.operationKind, "known-file-transaction");
    assert.equal(status.transaction?.format, "known-file-transaction-envelope-v1");
    assert.equal(status.transaction?.recovery.commandId, "replace-known-file-recover");
    await readFile(join(fixture.consumerRoot, ".agent-teams-local", "scaffolding-transaction.json"));
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("serializes concurrent attaches before writing the local ignore rule", async () => {
  const fixture = await createFixture({ blockExcludeLookup: true });
  try {
    const firstAttach = fixture.service.attach(
      fixture.consumerRoot,
      fixture.targetRepositoryRoot
    );
    await fixture.runner.waitForExcludeLookup();

    const secondAttach = fixture.service.attach(
      fixture.consumerRoot,
      fixture.targetRepositoryRoot
    );
    await assert.rejects(
      secondAttach,
      /operation is active or its lock is not safely recoverable/u
    );

    fixture.runner.releaseExcludeLookup();
    const attached = await firstAttach;
    assert.equal(attached.status.mode, "LOCAL");

    const exclude = await readFile(
      join(fixture.consumerRoot, ".git", "info", "exclude"),
      "utf8"
    );
    assert.equal(
      exclude
        .split(/\r?\n/u)
        .filter((line) => line === ".agent-teams-local/").length,
      1
    );
    const status = await inspectFoundationMode(fixture.consumerRoot);
    assert.equal(status.mode, "LOCAL");
    assert.equal(status.linkState?.phase, "LOCAL");
  } finally {
    fixture.runner.releaseExcludeLookup();
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



test("pure manifest and lockfile admission matches the Node reader diagnostics", async () => {
  const fixture = await createFixture();
  try {
    const { inspectFoundationDevOnly, inspectFoundationRegistryProvenance } = await import("../packages/engineering-foundation/dist/local-mode/index.js");
    for (const spec of ["1.2.3", "^1.2.3", "link:../target"]) {
      const path = join(fixture.consumerRoot, "package.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.devDependencies[FOUNDATION_PACKAGE_NAME] = spec;
      await writeJson(path, manifest);
      assert.deepEqual(await inspectFoundationDevOnly(fixture.consumerRoot), inspectConsumerManifest(fixture.consumerRoot, manifest));
      const lock = parseDocument(await readFile(join(fixture.consumerRoot, "pnpm-lock.yaml"), "utf8")).toJS();
      const root = inspectLockfile(lock, "consumer pnpm-lock.yaml", spec);
      const installed = inspectLockfile(lock, "installed pnpm virtual-store lockfile", spec);
      const actual = await inspectFoundationRegistryProvenance(fixture.consumerRoot, spec);
      assert.deepEqual(actual.issues, [...root.issues, ...installed.issues]);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});



test("alternate inspection port preserves real directory and pnpm-link lifecycle bytes", async (context) => {
  for (const kind of ["directory", "symbolic-link"]) {
    await context.test(kind, async () => {
      const fixture = await createFixture();
      try {
        const installedPath = join(fixture.consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME);
        if (kind === "symbolic-link") {
          const packageRoot = join(fixture.consumerRoot, "node_modules/.pnpm/foundation/node_modules", FOUNDATION_PACKAGE_NAME);
          await createPackage(packageRoot, "1.2.3");
          await rm(installedPath, { recursive: true, force: true });
          await symlink(packageRoot, installedPath, process.platform === "win32" ? "junction" : "dir");
        }
        await writeFile(join(fixture.consumerRoot, "pnpm-workspace.yaml"), "# preserved workspace bytes\npackages: []\n", "utf8");
        const protectedPaths = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "node_modules/.pnpm/lock.yaml"];
        const before = await Promise.all(protectedPaths.map((path) => readFile(join(fixture.consumerRoot, path))));
        const registryRoot = await realpath(installedPath);
        const ports = createNodeLocalPackageLifecyclePorts(fixture.runner);
        const observations = [];
        const alternate = new LocalPackageLifecycle({
          ports: {
            ...ports,
            inspection: {
              ...ports.inspection,
              async mode(path, options) {
                const status = await ports.inspection.mode(path, options);
                observations.push({ mode: status.mode, ignoreLock: options?.ignoreOperationLock === true });
                return structuredClone(status);
              }
            }
          },
          now: () => new Date("2026-07-29T12:00:00.000Z")
        });
        const attached = await alternate.attach(fixture.consumerRoot, fixture.targetRepositoryRoot);
        assert.equal(attached.status.mode, "LOCAL");
        assert.equal(attached.status.linkState.registryEntryKind, kind);
        assert.equal(await realpath(installedPath), fixture.targetPackageRoot);
        assert.equal((await alternate.detach(fixture.consumerRoot)).mode, "REGISTRY");
        assert.equal(await realpath(installedPath), registryRoot);
        assert.equal((await lstat(installedPath)).isSymbolicLink(), kind === "symbolic-link");
        assert.deepEqual(await Promise.all(protectedPaths.map((path) => readFile(join(fixture.consumerRoot, path)))), before);
        assert.deepEqual(observations.map(({ mode }) => mode), ["REGISTRY", "REGISTRY", "LOCAL", "LOCAL", "LOCAL", "REGISTRY"]);
        assert.deepEqual(observations.map(({ ignoreLock }) => ignoreLock), [true, true, true, false, true, false]);
        assert.equal(fixture.runner.requests.some(({ command }) => /(?:pnpm|npm)(?:\.cmd)?$/u.test(command)), false);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});
