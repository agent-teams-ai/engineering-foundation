import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { retrievalStoreCopy, retrievalTree } from "./consumer-restoration-retrieval-fixture.mjs";

async function seeded(t) {
  const disposable = await mkdtemp(join(tmpdir(), "retrieval-helper-TEST-"));
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
      await symlink(fixture.store, join(fixture.consumerRoot, "escape"));
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
