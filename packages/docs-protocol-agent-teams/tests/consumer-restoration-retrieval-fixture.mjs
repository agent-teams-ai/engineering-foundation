import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Includes installed files, virtual-store lock, symlink targets, directories and Git.
// lstat/readlink never follow a dependency symlink out of this tree.
export async function retrievalTree(root, excluded = []) {
  const result = {};
  async function visit(relative) {
    const path = join(root, relative);
    const stat = await lstat(path);
    const entry = { mode: stat.mode, type: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file" };
    if (stat.isSymbolicLink()) {entry.target = await readlink(path);}
    else if (stat.isDirectory()) {
      for (const name of (await readdir(path)).toSorted()) {
        if (relative === "" && excluded.includes(name)) {continue;}
        await visit(relative ? `${relative}/${name}` : name);
      }
    } else {assert.ok(stat.isFile(), path); entry.hash = hash(await readFile(path));}
    result[relative] = entry;
  }
  await visit("");
  const stat = await lstat(root);
  return { root: await realpath(root), dev: stat.dev, ino: stat.ino, entries: result };
}

export async function withRetrievalEnvironment(store, action) {
  const values = { npm_config_store_dir: store, pnpm_config_store_dir: store, npm_config_cache_dir: store, pnpm_config_cache_dir: store, pnpm_config_offline: "true" };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {Object.assign(process.env, values); return await action();}
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) {delete process.env[key];} else {process.env[key] = value;}
    }
  }
}

// Resolve existing ancestors too: pnpm retains registrations for removed staging trees.
async function resolvedTarget(path, depth = 0) {
  assert.ok(depth < 64, `unresolvable registry target: ${path}`);
  try {return await realpath(path);}
  catch (error) {
    if (error.code !== "ENOENT") {throw error;}
    const stat = await lstat(path).catch((cause) => {
      if (cause.code !== "ENOENT") {throw cause;}
      return;
    });
    if (stat?.isSymbolicLink()) {
      return resolvedTarget(resolve(dirname(path), await readlink(path)), depth + 1);
    }
    const parent = dirname(path);
    assert.notEqual(parent, path);
    return join(await resolvedTarget(parent, depth + 1), relativePath(parent, path));
  }
}

const inside = (root, path) => {
  const tail = relativePath(root, path);
  return tail === "" || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`));
};

async function assertRegistryLinks(fixture, source, destination, entries, diagnostic) {
  const disposable = await realpath(fixture.disposable);
  const allowed = [join(disposable, "consumer"), join(disposable, "retrieval-staging")];
  assert.equal(await realpath(fixture.consumerRoot), allowed[0]);
  let count = 0;
  for (const [path, entry] of Object.entries(entries)) {
    if (entry.type !== "link") {continue;}
    const label = `store link ${JSON.stringify(path)} -> ${JSON.stringify(entry.target)}`;
    if (count++ < 16) {diagnostic(label);}
    assert.match(path, /^v11\/projects\/[^/\\]+$/u, label);
    for (const store of [source, destination]) {
      const target = resolve(dirname(join(store, path)), entry.target);
      // Rebase only the fixture ancestor alias; retain lexical and resolved containment.
      const literal = inside(resolve(fixture.disposable), target)
        ? resolve(disposable, relativePath(resolve(fixture.disposable), target)) : target;
      const resolved = await resolvedTarget(literal).catch((error) => {assert.fail(`${label}: ${error.message}`);});
      assert.ok(allowed.some((root) => inside(root, literal) && inside(root, resolved)) &&
        ![source, destination].some((root) => inside(root, literal) || inside(root, resolved)), label);
    }
  }
  diagnostic(`store registry links: ${count}; inventory limited to first 16`);
}

// Caller has awaited the complete V1 -> V2 -> V1 lifecycle: no store writer remains.
// Copy every file, including committed WAL and metadata, before opening ONLY the copy.
export async function retrievalStoreCopy(fixture, name, diagnostic = () => {}) {
  const disposable = await realpath(fixture.disposable);
  const source = await realpath(join(disposable, "store"));
  const before = await retrievalTree(source);
  const metadata = [];
  for (const path of Object.keys(before.entries).filter((candidate) => candidate.includes("/metadata") && candidate.endsWith(".jsonl"))) {
    const lines = (await readFile(join(source, path), "utf8")).trim().split("\n");
    metadata.push(...lines.map((line) => JSON.parse(line)).filter((value) => value.versions));
  }
  for (const cohort of [fixture.origin, fixture.target]) {
    for (const pkg of Object.values(cohort.packages)) {
      assert.ok(metadata.some((meta) => meta.versions?.[pkg.version]?.dist?.integrity === pkg.integrity),
        `complete metadata for ${pkg.version} / ${pkg.integrity}`);
    }
  }
  const destination = await resolvedTarget(join(disposable, name));
  assert.equal(dirname(destination), disposable);
  assert.notEqual(destination, source);
  await assertRegistryLinks(fixture, source, destination, before.entries, diagnostic);
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false,
    dereference: false, verbatimSymlinks: true });
  const copied = await retrievalTree(destination);
  assert.deepEqual(copied.entries, before.entries);
  for (const relative of Object.keys(before.entries)) {
    const left = await lstat(join(source, relative));
    const right = await lstat(join(destination, relative));
    assert.ok(left.dev !== right.dev || left.ino !== right.ino, `shared inode: ${relative}`);
  }
  const databases = Object.keys(copied.entries).filter((path) => path.endsWith("/index.db"));
  assert.equal(databases.length, 1);
  const database = join(destination, databases[0]);
  const adapter = fixture.target.packages.docsProtocolAgentTeams;
  const key = `${adapter.integrity}\t@agent-teams/docs-protocol-agent-teams@${adapter.version}`;
  const rows = (db) => db.prepare("SELECT key, data FROM package_index ORDER BY key").all()
    .map((row) => ({ key: row.key, hash: hash(row.data) }));
  let deleted;
  let original;
  function mutate(restore) {
    const db = new DatabaseSync(database);
    try {
      if (!restore) {
        original = rows(db);
        deleted = db.prepare("SELECT data FROM package_index WHERE key = ?").get(key);
        assert.ok(deleted, "complete seeded store contains exact adapter row");
        assert.equal(db.prepare("DELETE FROM package_index WHERE key = ?").run(key).changes, 1);
        assert.deepEqual(rows(db), original.filter((row) => row.key !== key));
      } else {
        assert.deepEqual(rows(db), original.filter((row) => row.key !== key));
        assert.equal(db.prepare("INSERT INTO package_index (key, data) VALUES (?, ?)").run(key, deleted.data).changes, 1);
        assert.deepEqual(rows(db), original);
      }
    } finally {db.close();}
  }
  async function remove() {
    const beforeRemoval = await retrievalTree(destination);
    mutate(false);
    const afterRemoval = await retrievalTree(destination);
    // SQLite may checkpoint/create sidecars; every other cache file (including metadata)
    // must retain its exact bytes and mode. Other package_index blobs are checked above.
    const outsideDatabase = (tree) => Object.fromEntries(Object.entries(tree.entries)
      .filter(([path]) => !path.startsWith(databases[0])));
    assert.deepEqual(outsideDatabase(afterRemoval), outsideDatabase(beforeRemoval));
  }
  return { destination, remove, repair: () => mutate(true),
    assertSourceUnchanged: async () => assert.deepEqual(await retrievalTree(source), before) };
}
