import assert from "node:assert/strict";
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
import test from "node:test";

import {
  FOUNDATION_PACKAGE_NAME,
  FoundationLocalModeService,
  inspectFoundationMode
} from "../packages/engineering-foundation/dist/local-mode/index.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

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

async function replaceWithDirectory(path, version) {
  await rm(path, { force: true, recursive: true });
  await createPackage(path, version);
}

class FakeProcessRunner {
  constructor({ failAttachedStatus = false }) {
    this.failAttachedStatus = failAttachedStatus;
    this.gitCommitRequests = 0;
    this.requests = [];
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

  await createPackage(targetPackageRoot, "1.3.0-dev.1");
  await mkdir(join(targetPackageRoot, "dist"), { recursive: true });
  await writeFile(join(targetPackageRoot, "dist", "cli.js"), "", "utf8");
  await writeFile(join(targetPackageRoot, "dist", "index.js"), "", "utf8");

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

test("reclaims a dead operation lock", async () => {
  const fixture = await createFixture();
  try {
    const lockRoot = join(
      fixture.consumerRoot,
      ".agent-teams-local",
      "foundation-operation.lock"
    );
    await mkdir(lockRoot, { recursive: true });
    await utimes(lockRoot, new Date(0), new Date(0));

    const attached = await fixture.service.attach(
      fixture.consumerRoot,
      fixture.targetRepositoryRoot
    );
    assert.equal(attached.status.mode, "LOCAL");
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects a concurrent operation owned by a live process", async () => {
  const fixture = await createFixture();
  try {
    const lockRoot = join(
      fixture.consumerRoot,
      ".agent-teams-local",
      "foundation-operation.lock"
    );
    await mkdir(lockRoot, { recursive: true });

    await assert.rejects(
      fixture.service.attach(
        fixture.consumerRoot,
        fixture.targetRepositoryRoot
      ),
      /operation is active or its lock is not safely recoverable/u
    );
    assert.equal((await inspectFoundationMode(fixture.consumerRoot)).mode, "INVALID");
  } finally {
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
