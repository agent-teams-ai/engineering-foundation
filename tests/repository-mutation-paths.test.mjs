import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertSafeExistingRepositoryAncestors,
  ExistingRepositoryAncestorError
} from "../packages/engineering-foundation/dist/repository-mutation/adapters/node/node-existing-repository-ancestors.js";
import { syncDirectoryDurably } from "../packages/engineering-foundation/dist/repository-mutation/adapters/node/node-directory-durability.js";
import { isLexicallyContainedPath } from "../packages/engineering-foundation/dist/repository-mutation/adapters/node/node-repository-path.js";
import {
  findPortableRepositoryPathCollision,
  portableRepositoryPathIdentity,
  portableRepositoryPathProblem
} from "../packages/engineering-foundation/dist/repository-mutation/application/model/repository-path.js";

async function withTemporaryRoot(callback) {
  const root = await mkdtemp(join(tmpdir(), "repository-mutation-paths-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("validates portable repository paths independently of the host", () => {
  assert.equal(portableRepositoryPathProblem("docs/guide.md"), undefined);
  assert.equal(portableRepositoryPathProblem("C:/escape.md"), "absolute");
  assert.equal(portableRepositoryPathProblem("\\\\host\\share"), "absolute");
  assert.equal(portableRepositoryPathProblem("docs\\guide.md"), "backslash");
  assert.equal(portableRepositoryPathProblem("docs/../guide.md"), "invalid-segment");
  assert.equal(portableRepositoryPathProblem("docs/CON.md"), "reserved-name");
  assert.equal(portableRepositoryPathProblem("docs/bad\u0001.md"), "control-character");
});

test("assigns NFC and case folded portable identities", () => {
  const decomposed = "docs/Cafe\u0301.md";
  const composed = "DOCS/CAFÉ.md";
  assert.equal(
    portableRepositoryPathIdentity(decomposed),
    portableRepositoryPathIdentity(composed)
  );
  assert.deepEqual(findPortableRepositoryPathCollision([decomposed, composed]), {
    first: decomposed,
    second: composed
  });
});

test("checks lexical containment without touching the filesystem", () => {
  assert.equal(isLexicallyContainedPath("/repo", "/repo/docs/a.md"), true);
  assert.equal(isLexicallyContainedPath("/repo", "/repo-other/a.md"), false);
});

test("accepts missing existing parents without creating them", async () => {
  await withTemporaryRoot(async (root) => {
    await assertSafeExistingRepositoryAncestors(root, "missing/child/file.md");
    await assert.rejects(
      async () => (await import("node:fs/promises")).stat(join(root, "missing")),
      { code: "ENOENT" }
    );
  });
});

test("rejects symbolic-link and non-directory ancestors", async () => {
  await withTemporaryRoot(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "repository-mutation-outside-"));
    try {
      await symlink(outside, join(root, "linked"));
      await assert.rejects(
        assertSafeExistingRepositoryAncestors(root, "linked/file.md"),
        (error) =>
          error instanceof ExistingRepositoryAncestorError &&
          error.problem === "not-directory"
      );
      await writeFile(join(root, "plain"), "not a directory\n");
      await assert.rejects(
        assertSafeExistingRepositoryAncestors(root, "plain/file.md"),
        (error) =>
          error instanceof ExistingRepositoryAncestorError &&
          error.problem === "not-directory"
      );
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("reports directory durability capability honestly", async () => {
  let closed = false;
  assert.equal(
    await syncDirectoryDurably("unused", {
      platform: "linux",
      open: async () => ({
        close: async () => {
          closed = true;
        },
        sync: async () => undefined
      })
    }),
    "durable"
  );
  assert.equal(closed, true);

  const unsupported = Object.assign(new Error("unsupported"), { code: "EINVAL" });
  assert.equal(
    await syncDirectoryDurably("unused", {
      platform: "win32",
      open: async () => {
        throw unsupported;
      }
    }),
    "unsupported"
  );
  await assert.rejects(
    syncDirectoryDurably("unused", {
      platform: "linux",
      open: async () => {
        throw unsupported;
      }
    }),
    unsupported
  );
});
