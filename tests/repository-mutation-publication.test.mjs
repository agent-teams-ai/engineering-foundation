import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, link as hardLink, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertTemporaryPathsAbsent,
  classifyExactFilePostimage
} from "../packages/repository-mutation/dist/repository-mutation/adapters/node/node-absent-file-publication.js";
import { publishAbsentFile } from "../packages/repository-mutation/dist/qualification/index.js";
import { readBoundedRegularFile } from "../packages/repository-mutation/dist/repository-mutation/adapters/node/node-bounded-regular-file.js";

const bytes = Buffer.from("exact postimage\n");
const postimage = {
  bytes,
  digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  mode: 0o644,
  size: bytes.byteLength
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foundation-publication-"));
  return {
    allowUnsupportedDirectoryDurability: process.platform === "win32",
    destinationPath: join(root, "result.txt"),
    root,
    temporaryPath: join(root, ".result.tmp")
  };
}

async function missing(path) {
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
}

async function quarantinedEvidence(root) {
  const entry = (await readdir(root)).find((name) =>
    name.includes(".foundation-owned-cleanup-"));
  assert.ok(entry, "expected preserved cleanup quarantine");
  return readFile(join(root, entry, "owned-temporary"));
}

test("classifies absent, exact and conflicting postimages", async () => {
  const paths = await fixture();
  try {
    assert.equal(await classifyExactFilePostimage(paths.destinationPath, postimage), "absent");
    await writeFile(paths.destinationPath, bytes, { mode: 0o644 });
    assert.equal(await classifyExactFilePostimage(paths.destinationPath, postimage), "exact");
    await writeFile(paths.destinationPath, "different\n");
    assert.equal(await classifyExactFilePostimage(paths.destinationPath, postimage), "conflict");
    await rm(paths.destinationPath);
    await mkdir(paths.destinationPath);
    assert.equal(await classifyExactFilePostimage(paths.destinationPath, postimage), "conflict");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("publishes absent postimage and removes only its temporary", async () => {
  const paths = await fixture();
  try {
    assert.equal(await publishAbsentFile({ ...paths, displayPath: "result.txt", postimage }), "published");
    assert.deepEqual(await readFile(paths.destinationPath), bytes);
    await missing(paths.temporaryPath);
    assert.equal(await publishAbsentFile({ ...paths, displayPath: "result.txt", postimage }), "already-satisfied");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("uses the injected bounded reader for every publication verification", async () => {
  const paths = await fixture();
  let reads = 0;
  try {
    assert.equal(
      await publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        operations: {
          async readBoundedRegularFile(path, maximumBytes) {
            reads += 1;
            return readBoundedRegularFile(path, maximumBytes);
          }
        },
        postimage
      }),
      "published"
    );
    assert.equal(reads, 4);
    assert.deepEqual(await readFile(paths.destinationPath), bytes);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("rejects identical or cross-directory publication paths before I/O", async () => {
  const paths = await fixture();
  const otherRoot = await fixture();
  try {
    for (const temporaryPath of [
      paths.destinationPath,
      join(paths.root, ".", "RESULT.TXT"),
      join(otherRoot.root, ".result.tmp")
    ]) {
      await assert.rejects(
        publishAbsentFile({
          ...paths,
          displayPath: "result.txt",
          postimage,
          temporaryPath
        }),
        (error) => error?.code === "PUBLICATION_INVALID"
      );
      await missing(paths.destinationPath);
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
    await rm(otherRoot.root, { recursive: true, force: true });
  }
});

test("publishes an immutable postimage snapshot when the caller mutates its input", async () => {
  const paths = await fixture();
  const mutableBytes = Buffer.from(bytes);
  const mutablePostimage = { ...postimage, bytes: mutableBytes };
  try {
    const publication = publishAbsentFile({
      ...paths,
      displayPath: "result.txt",
      postimage: mutablePostimage
    });
    mutableBytes.fill(0x78);
    mutablePostimage.digest = "sha256:caller-mutated";
    mutablePostimage.mode = 0;
    mutablePostimage.size = 0;
    assert.equal(await publication, "published");
    assert.deepEqual(await readFile(paths.destinationPath), bytes);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("publishes from an immutable options snapshot", async () => {
  const paths = await fixture();
  const alternate = await fixture();
  const options = {
    ...paths,
    displayPath: "result.txt",
    postimage
  };
  try {
    const publication = publishAbsentFile(options);
    options.destinationPath = alternate.destinationPath;
    options.displayPath = "alternate.txt";
    options.temporaryPath = alternate.temporaryPath;
    options.operations = {
      async link() {
        throw new Error("mutated operation must not run");
      }
    };
    assert.equal(await publication, "published");
    assert.deepEqual(await readFile(paths.destinationPath), bytes);
    await missing(alternate.destinationPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
    await rm(alternate.root, { recursive: true, force: true });
  }
});

test("accepts only an exact concurrent publication", async () => {
  for (const [content, expected] of [[bytes, "already-satisfied"], [Buffer.from("other\n"), "CONFLICT"]]) {
    const paths = await fixture();
    try {
      const promise = publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        operations: {
          async link() {
            await writeFile(paths.destinationPath, content, { mode: 0o644 });
            const error = new Error("exists");
            error.code = "EEXIST";
            throw error;
          }
        },
        postimage
      });
      if (expected === "already-satisfied") {
        assert.equal(await promise, expected);
      } else {
        await assert.rejects(promise, (error) => error?.code === expected);
      }
      assert.deepEqual(await readFile(paths.destinationPath), content);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  }
});

test("syncs the destination directory before accepting an exact EEXIST publication", async () => {
  const paths = await fixture();
  const synced = [];
  try {
    assert.equal(
      await publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        operations: {
          async link() {
            await writeFile(paths.destinationPath, bytes, { mode: 0o644 });
            const error = Object.assign(new Error("exists"), { code: "EEXIST" });
            throw error;
          },
          async syncDirectory(path) { synced.push(path); return "durable"; }
        },
        postimage
      }),
      "already-satisfied"
    );
    assert.ok(synced.includes(paths.root));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("concurrent real-filesystem publishers converge on one exact postimage", async () => {
  const paths = await fixture();
  try {
    const outcomes = await Promise.all([
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        postimage,
        temporaryPath: join(paths.root, ".first.tmp")
      }),
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        postimage,
        temporaryPath: join(paths.root, ".second.tmp")
      })
    ]);
    assert.deepEqual(outcomes.toSorted(), ["already-satisfied", "published"]);
    assert.deepEqual(await readFile(paths.destinationPath), bytes);
    await missing(join(paths.root, ".first.tmp"));
    await missing(join(paths.root, ".second.tmp"));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("retries a transient inode metadata change while accepting an exact concurrent publisher", async () => {
  const paths = await fixture();
  let publicationStarted = false;
  let unstableReads = 0;
  try {
    assert.equal(
      await publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        operations: {
          async link() {
            await writeFile(paths.destinationPath, bytes, { mode: 0o644 });
            publicationStarted = true;
            const error = new Error("exists");
            error.code = "EEXIST";
            throw error;
          },
          async readBoundedRegularFile(path, maximumBytes) {
            if (publicationStarted && unstableReads === 0) {
              unstableReads += 1;
              return { outcome: "changed" };
            }
            return readBoundedRegularFile(path, maximumBytes);
          }
        },
        postimage
      }),
      "already-satisfied"
    );
    assert.equal(unstableReads, 1);
    assert.deepEqual(await readFile(paths.destinationPath), bytes);
    await missing(paths.temporaryPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("retries an outcome-path metadata change after an exact EEXIST classification", async () => {
  const paths = await fixture();
  let publicationStarted = false;
  let postPublicationReads = 0;
  try {
    assert.equal(
      await publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        operations: {
          async link() {
            await writeFile(paths.destinationPath, bytes, { mode: 0o644 });
            publicationStarted = true;
            const error = new Error("exists");
            error.code = "EEXIST";
            throw error;
          },
          async readBoundedRegularFile(path, maximumBytes) {
            if (publicationStarted) {
              postPublicationReads += 1;
              if (postPublicationReads === 2) {
                return { outcome: "changed" };
              }
            }
            return readBoundedRegularFile(path, maximumBytes);
          }
        },
        postimage
      }),
      "already-satisfied"
    );
    assert.equal(postPublicationReads, 3);
    assert.deepEqual(await readFile(paths.destinationPath), bytes);
    await missing(paths.temporaryPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("rejects different bytes observed after an outcome-path metadata change", async () => {
  const paths = await fixture();
  const differentBytes = Buffer.alloc(bytes.byteLength, 0x78);
  let publicationStarted = false;
  let postPublicationReads = 0;
  try {
    await assert.rejects(
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        operations: {
          async link() {
            await writeFile(paths.destinationPath, bytes, { mode: 0o644 });
            publicationStarted = true;
            const error = new Error("exists");
            error.code = "EEXIST";
            throw error;
          },
          async readBoundedRegularFile(path, maximumBytes) {
            if (publicationStarted) {
              postPublicationReads += 1;
              if (postPublicationReads === 2) {
                await writeFile(paths.destinationPath, differentBytes, {
                  mode: 0o644
                });
                return { outcome: "changed" };
              }
            }
            return readBoundedRegularFile(path, maximumBytes);
          }
        },
        postimage
      }),
      (error) => error?.code === "CONFLICT"
    );
    assert.equal(postPublicationReads, 3);
    assert.deepEqual(await readFile(paths.destinationPath), differentBytes);
    await missing(paths.temporaryPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("fails closed after bounded retries when concurrent publication never stabilizes", async () => {
  const paths = await fixture();
  let publicationStarted = false;
  let unstableReads = 0;
  try {
    await assert.rejects(
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        operations: {
          async link() {
            await writeFile(paths.destinationPath, bytes, { mode: 0o644 });
            publicationStarted = true;
            const error = new Error("exists");
            error.code = "EEXIST";
            throw error;
          },
          async readBoundedRegularFile(path, maximumBytes) {
            if (publicationStarted) {
              unstableReads += 1;
              return { outcome: "changed" };
            }
            return readBoundedRegularFile(path, maximumBytes);
          }
        },
        postimage
      }),
      (error) => error?.code === "CONFLICT"
    );
    assert.equal(unstableReads, 3);
    assert.deepEqual(await readFile(paths.destinationPath), bytes);
    await missing(paths.temporaryPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("concurrent different postimages preserve the winner and reject the loser", async () => {
  const paths = await fixture();
  const otherBytes = Buffer.from("other postimage\n");
  const otherPostimage = {
    bytes: otherBytes,
    digest: `sha256:${createHash("sha256").update(otherBytes).digest("hex")}`,
    mode: 0o644,
    size: otherBytes.byteLength
  };
  try {
    const results = await Promise.allSettled([
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        postimage,
        temporaryPath: join(paths.root, ".first.tmp")
      }),
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        postimage: otherPostimage,
        temporaryPath: join(paths.root, ".second.tmp")
      })
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejection = results.find((result) => result.status === "rejected");
    assert.equal(rejection?.reason?.code, "CONFLICT");
    const observed = await readFile(paths.destinationPath);
    assert.ok(observed.equals(bytes) || observed.equals(otherBytes));
    await missing(join(paths.root, ".first.tmp"));
    await missing(join(paths.root, ".second.tmp"));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("fails closed when hard links are unsupported", async () => {
  const paths = await fixture();
  try {
    await assert.rejects(
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        operations: {
          async link() {
            const error = new Error("unsupported");
            error.code = "EPERM";
            throw error;
          }
        },
        postimage
      }),
      (error) => error?.code === "PUBLICATION_UNSUPPORTED"
    );
    await missing(paths.destinationPath);
    await missing(paths.temporaryPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("fails closed when publication directory durability is unsupported", async () => {
  const paths = await fixture();
  let syncCount = 0;
  try {
    await assert.rejects(
      publishAbsentFile({
        ...paths,
        allowUnsupportedDirectoryDurability: false,
        displayPath: "result.txt",
        operations: {
          async syncDirectory() {
            syncCount += 1;
            return syncCount === 1 ? "unsupported" : "durable";
          }
        },
        postimage
      }),
      (error) => error?.code === "PUBLICATION_UNSUPPORTED"
    );
    assert.deepEqual(await readFile(paths.destinationPath), bytes);
    await missing(paths.temporaryPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("reports cleanup failure when cleanup directory durability is unsupported", async () => {
  const paths = await fixture();
  const primary = new Error("primary publication fault");
  try {
    await assert.rejects(
      publishAbsentFile({
        ...paths,
        allowUnsupportedDirectoryDurability: false,
        displayPath: "result.txt",
        faultInjector(point) {
          if (point.phase === "after-temporary-written") {
            throw primary;
          }
        },
        operations: {
          async syncDirectory() {
            return "unsupported";
          }
        },
        postimage
      }),
      (error) =>
        error?.code === "CLEANUP_FAILED" &&
        error.cause === primary &&
        error.cleanupError?.code === "PUBLICATION_UNSUPPORTED"
    );
    await missing(paths.destinationPath);
    await missing(paths.temporaryPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("preserves destination after a post-link fault", async () => {
  const paths = await fixture();
  try {
    await assert.rejects(
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        faultInjector(point) {
          if (point.phase === "after-hard-link") {
            throw new Error("post-link fault");
          }
        },
        postimage
      }),
      /post-link fault/u
    );
    assert.deepEqual(await readFile(paths.destinationPath), bytes);
    await missing(paths.temporaryPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("cleans its known temporary after a pre-sync publication fault", async () => {
  const paths = await fixture();
  try {
    await assert.rejects(
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        faultInjector(point) {
          if (point.phase === "after-temporary-written") {
            throw new Error("write boundary fault");
          }
        },
        postimage
      }),
      /write boundary fault/u
    );
    await missing(paths.temporaryPath);
    await missing(paths.destinationPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("retains the primary publication failure when cleanup also fails", async () => {
  const paths = await fixture();
  const primary = new Error("primary publication fault");
  const cleanup = new Error("cleanup fault");
  try {
    await assert.rejects(
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        faultInjector(point) {
          if (point.phase === "after-temporary-written") {
            throw primary;
          }
        },
        operations: {
          async syncDirectory() {
            throw cleanup;
          }
        },
        postimage
      }),
      (error) =>
        error?.code === "CLEANUP_FAILED" &&
        error.cause === primary &&
        error.cleanupError === cleanup
    );
    assert.deepEqual(await quarantinedEvidence(paths.root), bytes);
    await missing(paths.destinationPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("preserves a replacement of an owned temporary", async () => {
  const paths = await fixture();
  try {
    await assert.rejects(
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        async faultInjector(point) {
          if (point.phase === "after-hard-link") {
            await rename(paths.temporaryPath, `${paths.temporaryPath}.owned`);
            await writeFile(paths.temporaryPath, "replacement\n");
          }
        },
        postimage
      }),
      (error) => error?.code === "TEMPORARY_REPLACED"
    );
    assert.equal(await readFile(paths.temporaryPath, "utf8"), "replacement\n");
    assert.equal(
      (await readdir(paths.root)).some((entry) =>
        entry.includes(".foundation-owned-cleanup-")),
      false,
    );
    assert.deepEqual(await readFile(paths.destinationPath), bytes);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("rejects an exact pre-link temporary replacement by identity", async () => {
  const paths = await fixture();
  try {
    await assert.rejects(
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        async faultInjector(point) {
          if (point.phase === "after-temporary-synced") {
            await rename(paths.temporaryPath, `${paths.temporaryPath}.owned`);
            await writeFile(paths.temporaryPath, bytes, { mode: 0o644 });
          }
        },
        postimage
      }),
      (error) => error?.code === "TEMPORARY_REPLACED"
    );
    await missing(paths.destinationPath);
    assert.deepEqual(await readFile(paths.temporaryPath), bytes);
    assert.equal(
      (await readdir(paths.root)).some((entry) =>
        entry.includes(".foundation-owned-cleanup-")),
      false,
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("rejects a pre-link in-place temporary mutation", async () => {
  const paths = await fixture();
  try {
    await assert.rejects(
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        async faultInjector(point) {
          if (point.phase === "after-temporary-synced") {
            await writeFile(paths.temporaryPath, "foreign bytes!!\n");
          }
        },
        postimage
      }),
      (error) => error?.code === "TEMPORARY_REPLACED"
    );
    await missing(paths.destinationPath);
    await missing(paths.temporaryPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("does not claim success when the pathname is replaced inside link", async () => {
  const paths = await fixture();
  try {
    await assert.rejects(
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        operations: {
          async link(source, destination) {
            await rename(source, `${source}.owned`);
            await writeFile(source, "foreign replacement\n");
            await hardLink(source, destination);
          }
        },
        postimage
      }),
      (error) => error?.code === "TEMPORARY_REPLACED"
    );
    assert.equal(await readFile(paths.destinationPath, "utf8"), "foreign replacement\n");
    assert.equal(await readFile(paths.temporaryPath, "utf8"), "foreign replacement\n");
    assert.equal(
      (await readdir(paths.root)).some((entry) =>
        entry.includes(".foundation-owned-cleanup-")),
      false,
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("does not claim success when the inode is mutated inside link", async () => {
  const paths = await fixture();
  try {
    await assert.rejects(
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        operations: {
          async link(source, destination) {
            await writeFile(source, "foreign mutation\n");
            await hardLink(source, destination);
          }
        },
        postimage
      }),
      (error) => error?.code === "VERIFICATION_FAILED"
    );
    assert.equal(await readFile(paths.destinationPath, "utf8"), "foreign mutation\n");
    await missing(paths.temporaryPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("reverifies destination identity and content before returning success", async () => {
  const paths = await fixture();
  let syncCount = 0;
  try {
    await assert.rejects(
      publishAbsentFile({
        ...paths,
        allowUnsupportedDirectoryDurability: true,
        displayPath: "result.txt",
        operations: {
          async syncDirectory() {
            syncCount += 1;
            if (syncCount === 2) {
              await rm(paths.destinationPath);
              await writeFile(paths.destinationPath, bytes, { mode: 0o644 });
            }
            return "unsupported";
          }
        },
        postimage
      }),
      (error) => error?.code === "VERIFICATION_FAILED"
    );
    assert.deepEqual(await readFile(paths.destinationPath), bytes);
    await missing(paths.temporaryPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("does not overwrite an existing temporary", async () => {
  const paths = await fixture();
  try {
    await writeFile(paths.temporaryPath, "reserved\n");
    await assert.rejects(
      publishAbsentFile({ ...paths, displayPath: "result.txt", postimage }),
      (error) => error?.code === "TEMPORARY_EXISTS"
    );
    assert.equal(await readFile(paths.temporaryPath, "utf8"), "reserved\n");
    await missing(paths.destinationPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("classifies every existing temporary by existence alone", async () => {
  const paths = await fixture();
  try {
    await writeFile(paths.temporaryPath, "unreadable\n", { mode: 0o000 });
    await chmod(paths.temporaryPath, 0o000);
    await assert.rejects(
      assertTemporaryPathsAbsent([
        { displayPath: "result.txt", temporaryPath: paths.temporaryPath }
      ]),
      (error) => error?.code === "TEMPORARY_EXISTS"
    );
    await rm(paths.temporaryPath);
    await mkdir(paths.temporaryPath);
    await assert.rejects(
      assertTemporaryPathsAbsent([
        { displayPath: "result.txt", temporaryPath: paths.temporaryPath }
      ]),
      (error) => error?.code === "TEMPORARY_EXISTS"
    );
    await rm(paths.temporaryPath, { recursive: true });
    await assert.doesNotReject(
      assertTemporaryPathsAbsent([
        { displayPath: "result.txt", temporaryPath: paths.temporaryPath }
      ])
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("rejects inconsistent postimage metadata before creating files", async () => {
  const paths = await fixture();
  try {
    await assert.rejects(
      publishAbsentFile({
        ...paths,
        displayPath: "result.txt",
        postimage: { ...postimage, size: postimage.size + 1 }
      }),
      (error) => error?.code === "INVALID_POSTIMAGE"
    );
    await missing(paths.destinationPath);
    await missing(paths.temporaryPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
