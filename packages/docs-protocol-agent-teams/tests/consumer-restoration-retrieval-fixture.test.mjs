import assert from "node:assert/strict";
import { constants } from "node:fs";
import fs, { link, lstat, mkdir, mkdtemp, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { retrievalStoreCopy, retrievalTree } from "./consumer-restoration-retrieval-fixture.mjs";

async function seeded(t, base = tmpdir()) {
  const disposable = await mkdtemp(join(base, "retrieval-helper-TEST-"));
  t.after(() => rm(disposable, { recursive: true, force: true }));
  const consumerRoot = join(disposable, "consumer");
  const store = join(disposable, "store");
  for (const path of [consumerRoot, join(disposable, "retrieval-staging"), join(store, "v11/projects"), join(store, "v11/metadata"), join(store, "v11/files")]) {
    await mkdir(path, { recursive: true });
  }
  const pkg = { version: "1.0.0", integrity: "sha512-TEST" };
  await writeFile(join(store, "v11/metadata/registry.jsonl"), JSON.stringify({ versions: { [pkg.version]: { dist: { integrity: pkg.integrity } } } }));
  await writeFile(join(store, "v11/files/payload"), "independent payload");
  await writeFile(join(consumerRoot, "must-not-copy"), "consumer contents");
  const db = new DatabaseSync(join(store, "v11/index.db"));
  try {
    db.exec("CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB)");
    db.prepare("INSERT INTO package_index VALUES (?, ?)").run(`${pkg.integrity}\t@agent-teams/docs-protocol-agent-teams@${pkg.version}`, Buffer.from("adapter"));
    db.prepare("INSERT INTO package_index VALUES (?, ?)").run("other", Buffer.from("retain"));
  } finally {db.close();}
  return { disposable, consumerRoot, store, origin: { packages: { docsProtocolAgentTeams: pkg } }, target: { packages: { docsProtocolAgentTeams: pkg } } };
}

test("full store retains literal registry links without traversing projects and isolates every inode", async (t) => {
  const fixture = await seeded(t);
  const links = {
    "v11/projects/absolute": fixture.consumerRoot,
    "v11/projects/relative": relative(join(fixture.store, "v11/projects"), fixture.consumerRoot),
    "v11/projects/removed-stage": join(fixture.disposable, "retrieval-staging/docs-consumer-upgrade-TEST/staged"),
  };
  for (const [path, target] of Object.entries(links)) {await symlink(target, join(fixture.store, path));}
  const source = await retrievalTree(fixture.store);
  const copy = await retrievalStoreCopy(fixture, "copy", (message) => t.diagnostic(message));
  assert.deepEqual((await retrievalTree(copy.destination)).entries, source.entries);
  for (const [path, entry] of Object.entries(source.entries)) {
    if (entry.type === "directory") {continue;}
    const left = await lstat(join(fixture.store, path));
    const right = await lstat(join(copy.destination, path));
    assert.ok(left.dev !== right.dev || left.ino !== right.ino, path);
    if (entry.type === "link") {
      assert.ok(right.isSymbolicLink());
      assert.equal(await readlink(join(copy.destination, path)), links[path]);
    }
  }
  await copy.remove();
  copy.repair();
  await copy.assertSourceUnchanged();
});

for (const kind of ["payload", "unrelated", "shared-store", "copy-store", "nested", "wrong-version", "ancestor-escape"]) {
  test(`rejects ${kind} symlink with literal evidence before copying`, async (t) => {
    const fixture = await seeded(t);
    const paths = { payload: "v11/files/link", nested: "v11/projects/hash/nested", "wrong-version": "v10/projects/hash" };
    const path = paths[kind] ?? "v11/projects/hash";
    let target = fixture.consumerRoot;
    if (kind === "unrelated") {target = join(fixture.disposable, "unrelated");}
    if (kind === "shared-store") {target = join(fixture.store, "v11/files");}
    if (kind === "copy-store") {target = join(fixture.disposable, "copy/v11/files");}
    if (kind === "ancestor-escape") {
      await symlink(fixture.store, join(fixture.consumerRoot, "escape"), "dir");
      target = join(fixture.consumerRoot, "escape/v11/files");
    }
    await mkdir(dirname(join(fixture.store, path)), { recursive: true });
    await symlink(target, join(fixture.store, path));
    const before = await retrievalTree(fixture.store);
    await assert.rejects(retrievalStoreCopy(fixture, "copy"), (error) => {
      assert.ok(error.message.includes(JSON.stringify(path)));
      assert.ok(error.message.includes(JSON.stringify(target)));
      return true;
    });
    await assert.rejects(lstat(join(fixture.disposable, "copy")), { code: "ENOENT" });
    assert.deepEqual(await retrievalTree(fixture.store), before);
  });
}

for (const escape of [false, true]) {
  test(`aliased temporary ancestor ${escape ? "rejects dangling escape" : "copies literal registry links"}`, async (t) => {
    const owned = await mkdtemp(join(tmpdir(), "item17-alias-TEST-"));
    try {
      const real = await realpath(owned);
      await mkdir(join(real, "temporary"));
      const alias = join(real, "alias");
      await symlink(join(real, "temporary"), alias, "dir");
      const fixture = await seeded(t, alias);
      const canonical = await realpath(fixture.disposable);
      assert.notEqual(fixture.disposable, canonical);
      const links = {
        absolute: fixture.consumerRoot,
        canonical: join(canonical, "consumer"),
        relative: relative(join(fixture.store, "v11/projects"), fixture.consumerRoot),
        dangling: join(fixture.disposable, "retrieval-staging/removed/staged"),
      };
      if (escape) {
        await symlink(fixture.store, join(fixture.disposable, "retrieval-staging/escape"), "dir");
        links.dangling = join(fixture.disposable, "retrieval-staging/escape/missing/staged");
      }
      for (const [name, target] of Object.entries(links)) {
        await symlink(target, join(fixture.store, "v11/projects", name));
      }
      const before = await retrievalTree(fixture.store);
      if (escape) {
        await assert.rejects(retrievalStoreCopy(fixture, "copy"), (error) => {
          assert.ok(error.message.includes(JSON.stringify(links.dangling)));
          return true;
        });
        await assert.rejects(lstat(join(canonical, "copy")), { code: "ENOENT" });
        assert.deepEqual(await retrievalTree(fixture.store), before);
      } else {
        const copy = await retrievalStoreCopy(fixture, "copy");
        assert.equal(copy.destination, join(canonical, "copy"));
        assert.deepEqual((await retrievalTree(copy.destination)).entries, before.entries);
        for (const [name, target] of Object.entries(links)) {
          assert.equal(await readlink(join(copy.destination, "v11/projects", name)), target);
        }
        await copy.remove();
        copy.repair();
        await copy.assertSourceUnchanged();
      }
    } finally {await rm(owned, { recursive: true, force: true });}
  });
}

// Exercise opens without optional Windows flags on Linux too. Only open flags
// change; the real descriptor stat, identity checks and reads remain intact.
for (const missingFlags of [false, true]) {
for (const race of ["leaf-link", "leaf-file", "leaf-directory", "parent-link", "during-read"]) {
  test(`inventory rejects ${race} drift and closes opened handles (missing flags: ${missingFlags})`, async (t) => {
    const owned = await mkdtemp(join(tmpdir(), "item17-inventory-TEST-"));
    const originalOpen = fs.open;
    let opened = false;
    let closed = false;
    let intercepted = false;
    let reads = 0;
    let openError;
    try {
      const parent = join(owned, "tree");
      const file = join(parent, "payload");
      const foreign = join(owned, "foreign");
      await mkdir(parent);
      await mkdir(foreign);
      await writeFile(file, "original bytes");
      await writeFile(join(foreign, "target"), "foreign bytes");
      // Same leaf inode makes this specifically exercise parent identity checks.
      await link(file, join(foreign, "payload"));
      t.mock.method(fs, "open", async (path, flags) => {
        if (path !== file || intercepted) {return originalOpen(path, flags);}
        intercepted = true;
        if (race === "parent-link") {
          await rename(parent, join(owned, "old-tree"));
          await symlink(foreign, parent, "dir");
        } else if (race !== "during-read") {
          await rename(file, join(parent, "old-payload"));
          if (race === "leaf-link") {await symlink(join(foreign, "target"), file);}
          else if (race === "leaf-file") {await writeFile(file, "replacement bytes");}
          else {await mkdir(file);}
        }
        let handle;
        const optionalFlags = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
        try {handle = await originalOpen(path, missingFlags ? flags & ~optionalFlags : flags);}
        catch (error) {openError = error; throw error;}
        opened = true;
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => {await close(); closed = true;});
        const read = handle.readFile.bind(handle);
        t.mock.method(handle, "readFile", async () => {
          reads++;
          assert.equal(race, "during-read", "foreign descriptor must never be read");
          const bytes = await read();
          assert.equal(bytes.toString(), "original bytes");
          await writeFile(file, "changed length during descriptor read");
          return bytes;
        });
        return handle;
      });
      syncBuiltinESMExports();
      await assert.rejects(retrievalTree(parent), (error) => {
        if (openError) {
          assert.equal(error, openError);
          if (race === "leaf-link" && !missingFlags && typeof constants.O_NOFOLLOW === "number") {
            assert.equal(error.code, "ELOOP");
          } else {
            assert.equal(race, "leaf-directory");
            assert.equal(process.platform, "win32");
            assert.equal(error.code, "EISDIR");
          }
        } else {
          assert.equal(error.code, "ERR_ASSERTION");
          const message = race === "parent-link" ? "parent changed:"
            : race === "during-read" ? "file changed during read:"
            : race === "leaf-directory" ? file : "file changed before read:";
          assert.ok(error.message.includes(message), error.message);
        }
        return true;
      });
      assert.ok(intercepted);
      assert.equal(opened, !openError);
      assert.equal(reads, race === "during-read" ? 1 : 0);
      assert.equal(closed, opened);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(owned, { recursive: true, force: true });
    }
  });
}
}
