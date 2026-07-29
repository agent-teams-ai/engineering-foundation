import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
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
  constructor({ consumerRoot, registryVersion, targetPackageRoot }) {
    this.consumerRoot = consumerRoot;
    this.registryVersion = registryVersion;
    this.targetPackageRoot = targetPackageRoot;
    this.requests = [];
  }

  async run(request) {
    this.requests.push(request);
    if (request.command === "git" && request.args.includes("--git-path")) {
      return { stdout: ".git/info/exclude\n", stderr: "" };
    }
    if (request.command === "git" && request.args.includes("rev-parse")) {
      return { stdout: `${COMMIT}\n`, stderr: "" };
    }
    if (request.command === "git" && request.args.includes("status")) {
      return { stdout: "", stderr: "" };
    }
    if (request.command === "pnpm" && request.args[0] === "link") {
      const installed = join(
        this.consumerRoot,
        "node_modules",
        "@agent-teams",
        "engineering-foundation"
      );
      await rm(installed, { force: true, recursive: true });
      await mkdir(dirname(installed), { recursive: true });
      await symlink(this.targetPackageRoot, installed, "dir");
      return { stdout: "", stderr: "" };
    }
    if (request.command === "pnpm" && request.args[0] === "unlink") {
      await rm(
        join(
          this.consumerRoot,
          "node_modules",
          "@agent-teams",
          "engineering-foundation"
        ),
        { force: true, recursive: true }
      );
      return { stdout: "", stderr: "" };
    }
    if (request.command === "pnpm" && request.args[0] === "install") {
      await replaceWithDirectory(
        join(
          this.consumerRoot,
          "node_modules",
          "@agent-teams",
          "engineering-foundation"
        ),
        this.registryVersion
      );
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected process request: ${JSON.stringify(request)}`);
  }
}

async function createFixture() {
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
    consumerRoot,
    registryVersion,
    targetPackageRoot
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
