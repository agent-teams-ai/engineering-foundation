import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { mapStageIo, MAX_STAGE_BYTES, type StageByteState } from "../scripts/pack-stage-io.mts";
import { materializeStableTree, readStableRegularFile } from "../scripts/pack-artifact-stage-support.mjs";

// An early rejection must not release the temporary-root owner while writers remain.
test("stage I/O stops admission on undefined rejection and drains all started jobs", async () => {
  const admitted = Promise.withResolvers<void>();
  const rejectFirst = Promise.withResolvers<void>();
  const finishOthers = Promise.withResolvers<void>();
  const started: number[] = [];
  let settled = false;
  const task = mapStageIo(Array.from({ length: 12 }, (_, index) => index), async item => {
    started.push(item);
    if (started.length === 4) { admitted.resolve(); }
    if (item === 0) { await rejectFirst.promise; throw undefined; }
    await finishOthers.promise;
    return item;
  });
  void task.then(() => { settled = true; return settled; }, () => { settled = true; return settled; });
  await admitted.promise;
  rejectFirst.resolve();
  // Drain the microtask queue before checking that held writers still block return.
  await setImmediate();
  assert.equal(settled, false);
  assert.deepEqual(started, [0, 1, 2, 3]);
  finishOthers.resolve();
  await assert.rejects(task, error => error === undefined);
  assert.deepEqual(started, [0, 1, 2, 3]);
});

// Before reservations, overlapping reads could each admit the same remaining bytes.
test("overlapping stable reads cannot exceed their shared stage byte budget", async t => {
  const root = await mkdtemp(join(tmpdir(), "stage-budget-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = Array.from({ length: 8 }, (_, index) => join(root, `${index}.txt`));
  await Promise.all(paths.map(path => writeFile(path, "1234")));
  const state: StageByteState = { bytes: MAX_STAGE_BYTES - 4 };
  const identities = await Promise.all(paths.map(async path => ({
    physical: await realpath(path), pathname: await lstat(path), metadata: await lstat(path),
  })));
  const results = await Promise.allSettled(paths.map((path, index) =>
    readStableRegularFile(path, state, "Budget fixture", identities[index])));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  for (const result of results) {
    if (result.status === "rejected") { assert.match(String(result.reason), /bounded byte limit/u); }
  }
  assert.equal(state.bytes, MAX_STAGE_BYTES);
  assert.equal(state.reservedBytes, 0);
});

// Concurrent leaves must preserve exact bytes/modes and physically independent copies.
test("batched tree materialization preserves bytes, modes and generated exclusions", async t => {
  const root = await mkdtemp(join(tmpdir(), "stage-copy-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const destination = join(root, "destination");
  await mkdir(join(source, "nested"), { recursive: true });
  await mkdir(join(source, "dist"));
  await writeFile(join(source, "dist", "poison.txt"), "GENERATED POISON");
  const names = Array.from({ length: 48 }, (_, index) => `${index}.txt`);
  await Promise.all(names.map(name => writeFile(join(source, "nested", name), `source ${name}`)));
  await chmod(join(source, "nested", names[0]!), 0o750);
  const state = { bytes: 0, entries: 0 };
  await materializeStableTree(source, destination, {
    allowLinks: false, excludedEntries: new Set(["dist"]), label: "Copy fixture", state,
    validatePhysical: undefined,
  });
  for (const name of names) {
    assert.equal(await readFile(join(destination, "nested", name), "utf8"), `source ${name}`);
    assert.equal((await lstat(join(destination, "nested", name))).mode & 0o777,
      (await lstat(join(source, "nested", name))).mode & 0o777);
  }
  await assert.rejects(lstat(join(destination, "dist")), { code: "ENOENT" });
  await writeFile(join(destination, "nested", names[0]!), "stage changed");
  assert.equal(await readFile(join(source, "nested", names[0]!), "utf8"), `source ${names[0]}`);
  assert.equal(state.bytes, names.reduce((total, name) => total + Buffer.byteLength(`source ${name}`), 0));
});

// Moving a directory after-check before concurrent descendants would miss this mutation.
test("source directory mutation during leaf staging still rejects the tree", async t => {
  const root = await mkdtemp(join(tmpdir(), "stage-directory-race-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  await Promise.all(Array.from({ length: 8 }, (_, index) => writeFile(join(source, `${index}.txt`), "source")));
  let mutated = false;
  await assert.rejects(materializeStableTree(source, join(root, "destination"), {
    allowLinks: false, excludedEntries: new Set<string>(), label: "Race fixture",
    state: { bytes: 0, entries: 0 },
    validatePhysical: async (_physical: string, _path: string, metadata: Awaited<ReturnType<typeof lstat>>) => {
      if (metadata.isFile() && !mutated) {
        mutated = true;
        await writeFile(join(source, "late.txt"), "late addition");
        // Make the metadata change observable even on coarse timestamp filesystems.
        await utimes(source, new Date(0), new Date(0));
      }
    },
  }), /changed during staging/u);
  assert.equal(mutated, true);
});
