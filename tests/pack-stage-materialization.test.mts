import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate, setTimeout } from "node:timers/promises";
import test from "node:test";
import { mapStageIo, MAX_STAGE_BYTES, type StageByteState } from "../scripts/pack-stage-io.mts";
import { materializeStableTree, readStableRegularFile, runStagedPackageBuild, wireStagedPackageDependencies } from "../scripts/pack-artifact-stage-support.mjs";
import { createPnpmRunner, runCommand } from "../scripts/pack-test-support.mjs";
import { tarArchive } from "./pack-publishable-artifacts-support.mjs";

// pnpm 11's implicit pre-build install used to link shared-store inodes while
// another stage held their proved identities, making the strict ctime guard red.
void test("staged pnpm builds preserve cached source custody during another stage's read", async t => {
  const root = await mkdtemp(join(tmpdir(), "stage-pnpm-custody-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = join(root, "vfile-6.0.3.tgz");
  const source = join(root, "source");
  const buildStage = join(root, "build-stage");
  const store = join(root, "shared-store");
  const payload = "independent fixture bytes";
  await writeFile(archive, tarArchive([
    { name: "package/package.json", data: Buffer.from('{"name":"vfile","version":"6.0.3"}\n') },
    { name: "package/lib/index.d.ts.map", data: Buffer.from(payload) },
  ]));
  for (const path of [source, buildStage]) {
    await mkdir(path);
    await writeFile(join(path, "pnpm-workspace.yaml"),
      `packages: ["."]\nstoreDir: ${JSON.stringify(store)}\npackageImportMethod: hardlink\noffline: true\nverifyDepsBeforeRun: install\n`);
    await writeFile(join(path, "package.json"), JSON.stringify({
      name: "fixture-build", version: "1.0.0", private: true,
      dependencies: { vfile: `file:${archive.replaceAll("\\", "/")}` }, scripts: { build: "node --version > built.txt" },
    }));
  }
  const runPnpm = createPnpmRunner();
  await runPnpm(["install", "--ignore-scripts", "--offline"], source);
  const external = join(source, "node_modules", "vfile");
  const path = join(external, "lib", "index.d.ts.map");
  const physical = await realpath(path);
  const before = await lstat(path, { bigint: true });
  assert.ok(before.nlink > 1n, "fixture must share an inode with its disposable store");
  await mkdir(join(buildStage, "node_modules"));
  await materializeStableTree(external, join(buildStage, "node_modules", "vfile"), {
    allowLinks: true, excludedEntries: new Set<string>(), label: "External dependency tree",
    state: { bytes: 0, entries: 0 }, validatePhysical: undefined,
  });
  await writeFile(join(buildStage, "pnpm-lock.yaml"), await readFile(join(source, "pnpm-lock.yaml")));
  const handle = await open(physical, "r");
  try {
    let built = false;
    const readingStage = join(root, "reading-stage");
    await materializeStableTree(external, readingStage, {
      allowLinks: true, excludedEntries: new Set<string>(), label: "External dependency tree",
      state: { bytes: 0, entries: 0 },
      validatePhysical: async (_physical: string, pathname: string, metadata: Stats) => {
        if (!metadata.isFile() || pathname !== path) { return; }
        await runStagedPackageBuild(runPnpm, buildStage);
        assert.match(await readFile(join(buildStage, "built.txt"), "utf8"), /v\d+\.\d+\.\d+/u,
          "the actual build script must run");
        built = true;
      },
    });
    assert.equal(built, true);
    assert.equal(await realpath(path), physical);
    const identities = await Promise.all([lstat(path, { bigint: true }), lstat(physical, { bigint: true }), handle.stat({ bigint: true })]);
    for (const identity of identities) {
      for (const field of ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs", "nlink"] as const) {
        assert.equal(identity[field], before[field], field);
      }
    }
    assert.equal(await readFile(join(readingStage, "lib", "index.d.ts.map"), "utf8"), payload);
    const staged = await lstat(join(buildStage, "node_modules", "vfile", "lib", "index.d.ts.map"), { bigint: true });
    assert.equal(staged.nlink, 1n);
    assert.notEqual(staged.ino, before.ino);
  } finally { await handle.close(); }
});

// Missing staged executable shims used to silently select a source/global tsc.
void test("staged TypeScript builds use the copied compiler rather than ambient executables", async t => {
  const root = await mkdtemp(join(tmpdir(), "stage-compiler-custody-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  const poison = join(root, "ambient-bin");
  await mkdir(join(stage, "src"), { recursive: true });
  await mkdir(poison);
  const manifest = { name: "fixture-build", version: "1.0.0", private: true, type: "module",
    devDependencies: { typescript: "7.0.2" }, scripts: { build: "tsc --project tsconfig.json" } };
  await writeFile(join(stage, "package.json"), JSON.stringify(manifest));
  await writeFile(join(stage, "pnpm-workspace.yaml"), 'packages: ["."]\nverifyDepsBeforeRun: install\noffline: true\n');
  await writeFile(join(stage, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    strict: true, types: [], target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", rootDir: "src", outDir: "dist",
  }, include: ["src/**/*.ts"] }));
  await writeFile(join(stage, "src", "index.ts"), "export const answer: number = 42;\n");
  const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  await wireStagedPackageDependencies({ sourceRoot, stagedRoot: stage, manifest,
    catalogVersions: new Map<string, string>(), internalPackageNames: new Set<string>(), physicalInternalRoots: [],
    packageName: manifest.name, dependencyDeclarations: {}, stagedPackagesByName: new Map<string, string>(),
  });
  await writeFile(join(poison, process.platform === "win32" ? "tsc.cmd" : "tsc"),
    process.platform === "win32" ? "@echo off\r\nexit /b 79\r\n" : "#!/bin/sh\nexit 79\n", { mode: 0o755 });
  const inherited = (process.env.PATH ?? "").split(delimiter)
    .filter(path => !path.toLowerCase().startsWith((sourceRoot + sep).toLowerCase()));
  // Windows inherits Path; a plain spread plus PATH creates two names that
  // the native managed-process environment correctly rejects as duplicates.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "path"));
  environment.PATH = [poison, ...inherited].join(delimiter);
  await runCommand(process.execPath,
    [fileURLToPath(new URL("./support/staged-compiler-build-probe.mts", import.meta.url)), stage], root,
    { environment });
  assert.match(await readFile(join(stage, "dist", "index.js"), "utf8"), /export const answer = 42/u);
});

void test("staged compiler entrypoints cannot escape their package before build execution", async t => {
  const root = await mkdtemp(join(tmpdir(), "stage-compiler-escape-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const compiler = join(root, "node_modules", "typescript");
  await mkdir(compiler, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { typescript: "7.0.2" } }));
  await writeFile(join(compiler, "package.json"), JSON.stringify({ name: "typescript", bin: { tsc: "../outside.js" } }));
  let calls = 0;
  await assert.rejects(runStagedPackageBuild(async () => { calls += 1; }, root), /entrypoint escapes its package/u);
  assert.equal(calls, 0);
});

// Dropping ctime or rebaselining a proved identity would accept this real drift
// even though the pathname, inode, content, mode, size and mtime stay unchanged.
void test("a ctime-only source mutation still rejects its proved identity", async t => {
  const root = await mkdtemp(join(tmpdir(), "stage-ctime-custody-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "index.d.ts.map");
  await writeFile(path, "unchanged bytes");
  const expected = { physical: await realpath(path), pathname: await lstat(path), metadata: await lstat(path) };
  const before = await lstat(path, { bigint: true });
  // Toggle the writable attribute, then restore it. A no-op chmod does not
  // change Windows metadata; real transitions retain the final mode and bytes.
  const originalMode = Number(before.mode) & 0o777;
  // Separate the mutations from the write timestamp tick on the tested filesystems.
  await setTimeout(20);
  await chmod(path, originalMode ^ 0o200);
  await chmod(path, originalMode);
  const after = await lstat(path, { bigint: true });
  for (const field of ["dev", "ino", "size", "mode", "mtimeNs"] as const) {
    assert.equal(after[field], before[field], field);
  }
  assert.notEqual(after.ctimeNs, before.ctimeNs);
  assert.equal(await readFile(path, "utf8"), "unchanged bytes");
  await assert.rejects(readStableRegularFile(path, { bytes: 0 }, "External dependency tree", expected),
    /changed before its proved identity was read/u);
});

// A stale regular-file hint must reject before directory validation can admit nested work.
void test("a replaced queued leaf rejects before invoking directory validation", async t => {
  const root = await mkdtemp(join(tmpdir(), "stage-leaf-race-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  const paths = Array.from({ length: 8 }, (_, index) => join(source, `${index}.txt`));
  await Promise.all(paths.map(path => writeFile(path, "source")));
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const started = new Set<string>();
  const validatedDirectories: string[] = [];
  const task = materializeStableTree(source, join(root, "destination"), {
    allowLinks: false, excludedEntries: new Set(), label: "Queued leaf fixture", state: { bytes: 0, entries: 0 },
    validatePhysical: async (_physical: string, pathname: string, metadata: Stats) => {
      if (metadata.isDirectory()) { validatedDirectories.push(pathname); return; }
      started.add(pathname);
      if (started.size === 4) { admitted.resolve(); }
      await release.promise;
    },
  });
  void task.catch(() => {});
  try {
    await admitted.promise;
    const queued = paths.find(path => !started.has(path));
    assert.ok(queued !== undefined);
    await rm(queued);
    await mkdir(queued);
  } finally { release.resolve(); }
  await assert.rejects(task, /scheduled leaf is no longer a regular file/u);
  assert.deepEqual(validatedDirectories, [source]);
});

// An early rejection must not release the temporary-root owner while writers remain.
void test("stage I/O stops admission on undefined rejection and drains all started jobs", async () => {
  const admitted = Promise.withResolvers<void>();
  const rejectFirst = Promise.withResolvers<void>();
  const finishOthers = Promise.withResolvers<void>();
  const started: number[] = [];
  let settled = false;
  const task = mapStageIo(Array.from({ length: 12 }, (_, index) => index), async item => {
    started.push(item);
    if (started.length === 4) { admitted.resolve(); }
    if (item === 0) { await rejectFirst.promise; return Promise.reject<void>(); }
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
void test("overlapping stable reads cannot exceed their shared stage byte budget", async t => {
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
void test("batched tree materialization preserves bytes, modes and generated exclusions", async t => {
  const root = await mkdtemp(join(tmpdir(), "stage-copy-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const destination = join(root, "destination");
  await mkdir(join(source, "nested"), { recursive: true });
  await mkdir(join(source, "dist"));
  await writeFile(join(source, "dist", "poison.txt"), "GENERATED POISON");
  const names = Array.from({ length: 48 }, (_, index) => `${index}.txt`);
  await Promise.all(names.map(name => writeFile(join(source, "nested", name), `source ${name}`)));
  await chmod(join(source, "nested", names[0]), 0o750);
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
  await writeFile(join(destination, "nested", names[0]), "stage changed");
  assert.equal(await readFile(join(source, "nested", names[0]), "utf8"), `source ${names[0]}`);
  assert.equal(state.bytes, names.reduce((total, name) => total + Buffer.byteLength(`source ${name}`), 0));
});

// Moving a directory after-check before concurrent descendants would miss this mutation.
void test("source directory mutation during leaf staging still rejects the tree", async t => {
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
