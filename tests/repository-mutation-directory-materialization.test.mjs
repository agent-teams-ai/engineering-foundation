import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyUnboundDirectoryCreation,
  createAndBindOneDirectory,
  projectDirectoryMaterialization,
  recaptureExactDirectoryIdentity,
} from "../packages/engineering-foundation/dist/repository-mutation/adapters/node/node-directory-materialization.js";

const strictDirectoryDurabilityTest = process.platform === "win32" ? test.skip : test;
const windowsTest = process.platform === "win32" ? test : test.skip;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "repository-directory-mutation-"));
  return {
    root,
    async dispose() {
      await rm(root, { force: true, recursive: true });
    },
  };
}

test("projects the deepest exact anchor and every missing directory without mutation", async () => {
  const subject = await fixture();
  try {
    await mkdir(join(subject.root, "docs"));
    const projection = await projectDirectoryMaterialization({
      createPolicy: "allow",
      repositoryPath: "docs/architecture/decisions",
      repositoryRoot: subject.root,
    });
    assert.equal(projection.anchor.repositoryPath, "docs");
    assert.equal(projection.createPolicy, "allow");
    assert.deepEqual(
      projection.missingDirectories.map(({ repositoryPath }) => repositoryPath),
      ["docs/architecture", "docs/architecture/decisions"],
    );
    assert.equal(projection.finalParent.repositoryPath, "docs/architecture/decisions");
    await assert.rejects(lstat(join(subject.root, "docs", "architecture")), {
      code: "ENOENT",
    });
  } finally {
    await subject.dispose();
  }
});

test("rejects portable case and NFC aliases during read-only projection", async () => {
  const subject = await fixture();
  try {
    await mkdir(join(subject.root, "Docs"));
    await assert.rejects(
      projectDirectoryMaterialization({
        createPolicy: "allow",
        repositoryPath: "docs/api",
        repositoryRoot: subject.root,
      }),
      (error) => error?.code === "ALIAS_COLLISION",
    );
    await rm(join(subject.root, "Docs"), { recursive: true });
    await mkdir(join(subject.root, "\u212A"));
    await assert.rejects(
      projectDirectoryMaterialization({
        createPolicy: "allow",
        repositoryPath: "k/api",
        repositoryRoot: subject.root,
      }),
      (error) => error?.code === "ALIAS_COLLISION",
    );
  } finally {
    await subject.dispose();
  }
});

test("rejects symlinked ancestors and never traverses outside the repository", async () => {
  const subject = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "repository-directory-outside-"));
  try {
    await symlink(
      outside,
      join(subject.root, "docs"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      projectDirectoryMaterialization({
        createPolicy: "allow",
        repositoryPath: "docs/private",
        repositoryRoot: subject.root,
      }),
      (error) => error?.code === "SYMLINK",
    );
    assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(outside)), []);
  } finally {
    await subject.dispose();
    await rm(outside, { force: true, recursive: true });
  }
});

test("rejects directory creation when policy forbids it", async () => {
  const subject = await fixture();
  try {
    const forbidden = await projectDirectoryMaterialization({
      createPolicy: "forbid",
      repositoryPath: "forbidden",
      repositoryRoot: subject.root,
    });
    await assert.rejects(
      createAndBindOneDirectory({
        binding: { async bindCreatedDirectory() {} },
        createPolicy: forbidden.createPolicy,
        expectedParentIdentity: forbidden.anchor.identity,
        repositoryPath: "forbidden",
        repositoryRoot: subject.root,
      }),
      (error) => error?.code === "CREATE_FORBIDDEN",
    );
    await assert.rejects(lstat(join(subject.root, "forbidden")), { code: "ENOENT" });
  } finally {
    await subject.dispose();
  }
});

strictDirectoryDurabilityTest("creates exclusively, syncs, and requires identity binding before success", async () => {
  const subject = await fixture();
  try {
    const projection = await projectDirectoryMaterialization({
      createPolicy: "allow",
      repositoryPath: "docs/api",
      repositoryRoot: subject.root,
    });
    const events = [];
    const created = await createAndBindOneDirectory({
      binding: {
        async bindCreatedDirectory(directory) {
          assert.equal((await lstat(directory.absolutePath)).isDirectory(), true);
          events.push(`bound:${directory.repositoryPath}`);
        },
      },
      createPolicy: projection.createPolicy,
      expectedParentIdentity: projection.anchor.identity,
      repositoryPath: projection.missingDirectories[0].repositoryPath,
      repositoryRoot: subject.root,
    });
    assert.equal(created.outcome, "created-and-bound");
    assert.deepEqual(events, ["bound:docs"]);

    await assert.rejects(
      createAndBindOneDirectory({
        binding: { async bindCreatedDirectory() {} },
        createPolicy: "allow",
        expectedParentIdentity: projection.anchor.identity,
        repositoryPath: "docs",
        repositoryRoot: subject.root,
      }),
      (error) => error?.code === "EEXIST",
    );
  } finally {
    await subject.dispose();
  }
});

windowsTest("fails closed without binding when strict parent durability is unsupported", async () => {
  const subject = await fixture();
  try {
    const projection = await projectDirectoryMaterialization({
      createPolicy: "allow",
      repositoryPath: "docs",
      repositoryRoot: subject.root,
    });
    let bindings = 0;
    await assert.rejects(
      createAndBindOneDirectory({
        binding: {
          async bindCreatedDirectory() {
            bindings += 1;
          },
        },
        createPolicy: "allow",
        expectedParentIdentity: projection.anchor.identity,
        repositoryPath: "docs",
        repositoryRoot: subject.root,
      }),
      (error) =>
        error?.code === "AMBIGUOUS_CREATION" &&
        error.manualRecoveryRequired === true &&
        error.cause?.name === "StrictDirectoryDurabilityError",
    );
    assert.equal(bindings, 0);
    assert.equal((await lstat(join(subject.root, "docs"))).isDirectory(), true);
  } finally {
    await subject.dispose();
  }
});

test("classifies mkdir-before-bind failure as ambiguous and never adopts it", async () => {
  const subject = await fixture();
  try {
    const projection = await projectDirectoryMaterialization({
      createPolicy: "allow",
      repositoryPath: "docs",
      repositoryRoot: subject.root,
    });
    let bindings = 0;
    await assert.rejects(
      createAndBindOneDirectory({
        binding: {
          async bindCreatedDirectory() {
            bindings += 1;
          },
        },
        createPolicy: "allow",
        expectedParentIdentity: projection.anchor.identity,
        async faultInjector(point) {
          if (point.phase === "after-mkdir-before-capture") {
            throw new Error("simulated crash window");
          }
        },
        repositoryPath: "docs",
        repositoryRoot: subject.root,
      }),
      (error) =>
        error?.code === "AMBIGUOUS_CREATION" &&
        error.manualRecoveryRequired === true,
    );
    assert.equal(bindings, 0);
    assert.equal((await lstat(join(subject.root, "docs"))).isDirectory(), true);
    const recovery = await classifyUnboundDirectoryCreation({
      repositoryPath: "docs",
      repositoryRoot: subject.root,
    });
    assert.equal(recovery.outcome, "ambiguous-manual");
  } finally {
    await subject.dispose();
  }
});

test("never binds a replacement injected after the first mkdir observation", async () => {
  const subject = await fixture();
  try {
    const projection = await projectDirectoryMaterialization({
      createPolicy: "allow",
      repositoryPath: "docs",
      repositoryRoot: subject.root,
    });
    let bindings = 0;
    await assert.rejects(
      createAndBindOneDirectory({
        binding: {
          async bindCreatedDirectory() {
            bindings += 1;
          },
        },
        createPolicy: "allow",
        expectedParentIdentity: projection.anchor.identity,
        async faultInjector(point) {
          if (point.phase === "after-mkdir-before-capture") {
            await rename(
              join(subject.root, "docs"),
              join(subject.root, "docs.original"),
            );
            await mkdir(join(subject.root, "docs"));
          }
        },
        repositoryPath: "docs",
        repositoryRoot: subject.root,
      }),
      (error) =>
        error?.code === "AMBIGUOUS_CREATION" &&
        error.manualRecoveryRequired === true,
    );
    assert.equal(bindings, 0);
    assert.equal((await lstat(join(subject.root, "docs"))).isDirectory(), true);
    assert.equal(
      (await lstat(join(subject.root, "docs.original"))).isDirectory(),
      true,
    );
  } finally {
    await subject.dispose();
  }
});

test("exact recapture rejects a replaced created-directory identity", async () => {
  const subject = await fixture();
  try {
    await mkdir(join(subject.root, "docs"));
    const projection = await projectDirectoryMaterialization({
      createPolicy: "allow",
      repositoryPath: "docs",
      repositoryRoot: subject.root,
    });
    assert.equal(
      (await recaptureExactDirectoryIdentity({
        expectedIdentity: projection.anchor.identity,
        repositoryPath: "docs",
        repositoryRoot: subject.root,
      })).repositoryPath,
      "docs",
    );
    await rename(join(subject.root, "docs"), join(subject.root, "owned-docs"));
    await mkdir(join(subject.root, "docs"));
    await assert.rejects(
      recaptureExactDirectoryIdentity({
        expectedIdentity: projection.anchor.identity,
        repositoryPath: "docs",
        repositoryRoot: subject.root,
      }),
      (error) => error?.code === "CONCURRENT_CHANGE",
    );
    assert.equal((await lstat(join(subject.root, "docs"))).isDirectory(), true);
  } finally {
    await subject.dispose();
  }
});
