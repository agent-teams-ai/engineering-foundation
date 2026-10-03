import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import type { QualificationHandle } from "../scripts/package-artifact-custody.mts";

import { readQualifiedReleaseArtifact, readVerifiedArchive } from "../scripts/pack-artifact-archive.mjs";
import { retainArchiveCustody, verifyArchiveCustody } from "../scripts/package-artifact-custody.mts";
import { runCommand } from "../scripts/pack-test-support.mjs";
import { verifyInstalledTargetPayload } from "../scripts/registry-installed-package-qualification.mjs";
import { qualifiedArchive } from "./pack-publishable-artifacts-support.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function directory(t: TestContext, prefix: string) {
  const root = await mkdtemp(join(await realpath(tmpdir()), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function snapshot(t: TestContext) {
  const parent = await directory(t, "qc-");
  const root = join(parent, "snapshots");
  await mkdir(join(root, "qualified"), { recursive: true });
  const manifest = { name: "@fixture/qualified", version: "1.2.3" };
  const bytes = qualifiedArchive(manifest);
  const archivePath = join(root, "qualified", "fixture-qualified-1.2.3.tgz");
  await writeFile(archivePath, bytes, { mode: 0o444 });
  const records = Object.freeze({ [manifest.name]: Object.freeze({ archivePath,
    archiveName: "fixture-qualified-1.2.3.tgz", packageName: manifest.name, packageVersion: manifest.version,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  }) });
  return { parent, root, bytes, archivePath, records, custody: await retainArchiveCustody(root, records) };
}

// Each counterexample crosses the actual bounded reader and filesystem custody
// boundary. A digest-only reader is green for replacement and hardlink attacks.
test("qualified snapshot custody rejects changed, missing and extra files", async t => {
  for (const mutation of ["changed", "missing", "extra", "name", "version"]) {
    await t.test(mutation, async sub => {
      const fixture = await snapshot(sub);
      if (mutation === "missing") { await rm(fixture.archivePath); }
      else if (mutation === "extra") { await writeFile(join(dirname(fixture.archivePath), "extra.tgz"), fixture.bytes); }
      else {
        await chmod(fixture.archivePath, 0o644);
        const bytes = mutation === "changed" ? Buffer.from("damaged archive") :
          qualifiedArchive({ name: mutation === "name" ? "@fixture/wrong" : "@fixture/qualified",
            version: mutation === "version" ? "2.0.0" : "1.2.3" });
        await writeFile(fixture.archivePath, bytes);
      }
      await assert.rejects(verifyArchiveCustody(fixture.custody, fixture.records));
    });
  }
});

test("same bytes do not authorize inode replacement, hardlinks or symlink ancestors", async t => {
  for (const mutation of ["replacement", "hardlink", "leaf-symlink", "ancestor-symlink", "directory-replacement"]) {
    await t.test(mutation, async sub => {
      const fixture = await snapshot(sub);
      const outside = join(fixture.parent, "outside.tgz");
      if (mutation === "replacement") {
        await writeFile(outside, fixture.bytes);
        // Windows refuses replacing the fixture's read-only file. Permit the
        // rename so this case actually reaches the custody rejection boundary.
        await chmod(fixture.archivePath, 0o644);
        await rename(outside, fixture.archivePath);
      } else if (mutation === "hardlink") { await link(fixture.archivePath, outside); }
      else if (mutation === "leaf-symlink") {
        await writeFile(outside, fixture.bytes);
        await rm(fixture.archivePath);
        await symlink(outside, fixture.archivePath);
      } else {
        const parent = dirname(fixture.archivePath);
        await rename(parent, `${parent}-old`);
        if (mutation === "ancestor-symlink") {
          await symlink(`${parent}-old`, parent, process.platform === "win32" ? "junction" : "dir");
        } else {
          await mkdir(parent);
          await copyFile(join(`${parent}-old`, "fixture-qualified-1.2.3.tgz"), fixture.archivePath);
        }
      }
      if (["replacement", "hardlink"].includes(mutation)) {
        // RED witness for the previous digest-only reuse boundary: it accepts
        // these same-byte attacks, while physical custody below must reject.
        assert.deepEqual(await readVerifiedArchive(fixture.archivePath, fixture.records["@fixture/qualified"].sha256), fixture.bytes);
      }
      await assert.rejects(verifyArchiveCustody(fixture.custody, fixture.records), /custody/iu);
    });
  }
});

test("qualified reader refuses wrong claimed package identity and unsafe archive members", async t => {
  const fixture = await snapshot(t);
  const record = fixture.records["@fixture/qualified"];
  await assert.rejects(readQualifiedReleaseArtifact(record, { name: "@fixture/wrong", version: "1.2.3" }), /identity/u);
  await assert.rejects(readQualifiedReleaseArtifact(record, { name: "@fixture/qualified", version: "2.0.0" }), /identity/u);
  const actual = await readQualifiedReleaseArtifact(record, { name: "@fixture/qualified", version: "1.2.3" });
  assert.equal(actual.integrity, record.integrity);
  const unsafe = qualifiedArchive({ name: "@fixture/qualified", version: "1.2.3" }, [{ name: "package/alias", type: "2" }]);
  await chmod(fixture.archivePath, 0o644);
  await writeFile(fixture.archivePath, unsafe);
  await assert.rejects(readQualifiedReleaseArtifact({ ...record, sha256: createHash("sha256").update(unsafe).digest("hex") },
    { name: "@fixture/qualified", version: "1.2.3" }), /special entry/u);
});


test("installed payload verification rejects bytes that retain the right package version", async t => {
  const fixture = await snapshot(t);
  const target = await readQualifiedReleaseArtifact(fixture.records["@fixture/qualified"],
    { name: "@fixture/qualified", version: "1.2.3" });
  const installation = join(fixture.parent, "installed");
  await mkdir(installation);
  await runCommand("tar", ["-xzf", target.archivePath, "-C", installation], fixture.parent);
  const packageRoot = join(installation, "package");
  await verifyInstalledTargetPayload(packageRoot, target);
  await writeFile(join(packageRoot, "dist", "index.js"), "export const forged = true;\n");
  await assert.rejects(verifyInstalledTargetPayload(packageRoot, target), /differs from original qualified bytes/u);
});

async function producerFixture(t: TestContext, { failBuild = false } = {}) {
  const root = await directory(t, "qf-");
  const source = join(root, "source");
  await mkdir(source);
  await cp(join(repositoryRoot, "scripts"), join(source, "scripts"), { recursive: true });
  await mkdir(join(source, "packages"));
  // Use the real compiled library with its assets and package-local dependencies;
  // only the two disposable publication targets below belong to TEST authority.
  await symlink(join(repositoryRoot, "packages", "engineering-foundation"),
    join(source, "packages", "engineering-foundation"),
    process.platform === "win32" ? "junction" : "dir");
  await symlink(join(repositoryRoot, "node_modules"), join(source, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  for (const name of ["LICENSE", ".node-version", "pnpm-lock.yaml", "package.json"]) {
    await copyFile(join(repositoryRoot, name), join(source, name));
  }
  await writeFile(join(source, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  const catalog = ["a", "b"].map(leaf => ({ name: `@fixture/${leaf}`, root: `packages/${leaf}`,
    manifestPath: `packages/${leaf}/package.json`, changelogPath: `packages/${leaf}/CHANGELOG.md` }));
  const projectionPath = join(source, "scripts", "publishable-packages.mjs");
  const projection = await readFile(projectionPath, "utf8");
  const start = projection.indexOf("export const PUBLISHABLE_PACKAGE_CATALOG =");
  const end = projection.indexOf("\nfunction fail", start);
  // Replace TEST authority data only; retain the actual projection algorithm.
  await writeFile(projectionPath, `${projection.slice(0, start)}export const PUBLISHABLE_PACKAGE_CATALOG = Object.freeze(${JSON.stringify(catalog)});\n${projection.slice(end)}`);
  const log = join(root, "builds.jsonl");
  for (const leaf of ["a", "b"]) {
    const path = join(source, "packages", leaf);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "README.md"), "# Disposable TEST build\n");
    await writeFile(join(path, "package.json"), JSON.stringify({ name: `@fixture/${leaf}`, version: "1.2.3", type: "module",
      files: ["dist"], exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      scripts: { build: "node build.mts" }, ...(leaf === "b" ? { dependencies: { "@fixture/a": "workspace:*" } } : {}) }));
    await writeFile(join(path, "build.mts"), `
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
await appendFile(${JSON.stringify(log)}, JSON.stringify({ name: ${JSON.stringify(leaf)}, cwd: process.cwd() }) + '\\n');
${leaf === "b" ? "if ((await import('@fixture/a')).value !== 42) throw new Error('missing built support');" : ""}
${failBuild ? "throw new Error('TEST producer failure');" : ""}
await mkdir('dist');
await writeFile('dist/index.js', 'export const value = 42;\\n');
await writeFile('dist/index.d.ts', 'export declare const value: number;\\n');
`);
  }
  const api: typeof import("../scripts/pack-publishable-artifacts.mjs") = await import(pathToFileURL(join(source, "scripts", "pack-publishable-artifacts.mjs")).href);
  return { api, log, source, root };
}

test("one real production retains two independent clean builds and identical consumer bytes", async t => {
  const fixture = await producerFixture(t);
  let handle: QualificationHandle | undefined;
  let invocationRoot: string | undefined;
  const observations: string[][] = [];
  const evidence = await fixture.api.withQualifiedPackageArtifacts("combined", async authority => {
    handle = authority;
    for (const stage of ["packed", "registry"] as const) {
      await fixture.api.runQualifiedArtifactConsumer(authority, stage, async ({ artifacts, temporaryRoot }) => {
        invocationRoot = temporaryRoot;
        observations.push(await Promise.all(Object.values(artifacts).map(async record =>
          createHash("sha256").update(await readFile(record.archivePath)).digest("hex"))));
        for (const forged of [{}, { ...authority }, JSON.parse(JSON.stringify(authority)), Object.create(authority)]) {
          await assert.rejects(fixture.api.runQualifiedArtifactConsumer(forged, stage, () => assert.fail("forged effect")), /forged/u);
        }
        // Production staging files may change; the retained producer snapshot
        // remains authoritative and downstream owned files remain untouched.
        if (stage === "packed") {
          const directories = await readdir(temporaryRoot);
          const original = directories.find(name => name.startsWith("verified-"));
          assert.ok(original);
          const entries = await readdir(join(temporaryRoot, original));
          await chmod(join(temporaryRoot, original, entries[0]), 0o644);
          await writeFile(join(temporaryRoot, original, entries[0]), "mutated original staging output");
        }
      });
    }
  });
  assert.deepEqual(observations[0], observations[1]);
  assert.deepEqual(evidence.map(record => record.sha256), observations[0]);
  const builds = (await readFile(fixture.log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { name: string; cwd: string });
  assert.equal(builds.length, 6); // Two A targets plus two independent (A -> B) closures.
  assert.equal(new Set(builds.map(row => row.cwd)).size, 6);
  const groups = Map.groupBy(builds, row => dirname(dirname(row.cwd)));
  assert.deepEqual([...groups.values()].map(rows => rows.map(row => row.name)).toSorted(), [["a"], ["a"], ["a", "b"], ["a", "b"]]);
  assert.ok(invocationRoot);
  await assert.rejects(lstat(invocationRoot), { code: "ENOENT" });
  await assert.rejects(fixture.api.runQualifiedArtifactConsumer(handle, "registry", () => assert.fail("stale effect")), /closed/u);
});

test("standalone lifetimes produce fresh qualified sets and refuse previous handles", async t => {
  const fixture = await producerFixture(t);
  const roots: string[] = [];
  let previous: QualificationHandle | undefined;
  for (const mode of ["packed", "registry"] as const) {
    await fixture.api.withQualifiedPackageArtifacts(mode, authority =>
      fixture.api.runQualifiedArtifactConsumer(authority, mode, async ({ temporaryRoot }) => {
        roots.push(temporaryRoot);
        if (previous !== undefined) {
          await assert.rejects(fixture.api.runQualifiedArtifactConsumer(previous, mode, () => assert.fail("old invocation effect")), /closed/u);
        }
        previous = authority;
      }));
  }
  assert.notEqual(roots[0], roots[1]);
  assert.equal((await readFile(fixture.log, "utf8")).trim().split("\n").length, 12);
});

test("producer failure admits zero consumers", async t => {
  const fixture = await producerFixture(t, { failBuild: true });
  let called = false;
  await assert.rejects(fixture.api.withQualifiedPackageArtifacts("combined", () => { called = true; }), error => {
    assert.ok(error instanceof Error && "stderr" in error && typeof error.stderr === "string");
    assert.match(error.stderr, /TEST producer failure/u);
    return true;
  });
  assert.equal(called, false);
});

test("packed failure, downstream tampering and source drift prevent registry effects", async t => {
  const fixture = await producerFixture(t);
  for (const failure of ["consumer", "tamper", "drift", "toolchain-pin"]) {
    let registryCalls = 0;
    const source = failure === "toolchain-pin"
      ? join(fixture.source, ".node-version")
      : join(fixture.source, "packages", "a", "README.md");
    const original = await readFile(source);
    await assert.rejects(fixture.api.withQualifiedPackageArtifacts("combined", async handle => {
      await fixture.api.runQualifiedArtifactConsumer(handle, "packed", async ({ artifacts }) => {
        if (failure === "consumer") { throw new Error("TEST packed failure"); }
        if (failure === "drift" || failure === "toolchain-pin") { await writeFile(source, "TEST changed relevant input"); }
        else {
          const record = Object.values(artifacts)[0];
          await chmod(record.archivePath, 0o644);
          await writeFile(record.archivePath, "TEST downstream tampering");
        }
      });
      await fixture.api.runQualifiedArtifactConsumer(handle, "registry", () => { registryCalls += 1; });
    }));
    await writeFile(source, original);
    assert.equal(registryCalls, 0);
  }
});

test("registry failure and cleanup failure reject final acceptance", async t => {
  const fixture = await producerFixture(t);
  for (const failure of ["registry", "cleanup"]) {
    let stranded: string | undefined;
    await assert.rejects(fixture.api.withQualifiedPackageArtifacts("combined", async handle => {
      await fixture.api.runQualifiedArtifactConsumer(handle, "packed", async () => {});
      await fixture.api.runQualifiedArtifactConsumer(handle, "registry", async ({ temporaryRoot }) => {
        if (failure === "registry") { throw new Error("TEST registry failure"); }
        stranded = `${temporaryRoot}-moved`;
        await rename(temporaryRoot, stranded);
        await mkdir(temporaryRoot); // Same pathname cannot authorize removal of a replacement.
        t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
      });
    }));
    if (stranded !== undefined) { await rm(stranded, { recursive: true, force: true }); }
  }
});

test("admitted child work settles before acceptance even when caller forgets await", async t => {
  const fixture = await producerFixture(t);
  const marker = join(fixture.root, "settled");
  await fixture.api.withQualifiedPackageArtifacts("packed", handle => {
    void fixture.api.runQualifiedArtifactConsumer(handle, "packed", async () => {
      await runCommand(process.execPath, ["--input-type=module", "--eval",
        `import { writeFile } from 'node:fs/promises'; setTimeout(() => writeFile(${JSON.stringify(marker)}, 'settled'), 75);`], fixture.root);
    });
  });
  assert.equal(await readFile(marker, "utf8"), "settled");
});

// A rejected promise with no reason must poison the lifetime just like an Error.
test("undefined consumer rejection prevents retries and subsequent consumer effects", async t => {
  const fixture = await producerFixture(t);
  let retryCalls = 0;
  let registryCalls = 0;
  await assert.rejects(fixture.api.withQualifiedPackageArtifacts("combined", async handle => {
    await assert.rejects(fixture.api.runQualifiedArtifactConsumer(handle, "packed", () => Promise.reject()),
      error => error === undefined);
    await assert.rejects(fixture.api.runQualifiedArtifactConsumer(handle, "packed", () => { retryCalls += 1; }), /failed/u);
    await assert.rejects(fixture.api.runQualifiedArtifactConsumer(handle, "registry", () => { registryCalls += 1; }), /failed/u);
  }), error => error === undefined);
  assert.equal(retryCalls, 0);
  assert.equal(registryCalls, 0);
});

// Previously queued continuations must not admit work while owner cleanup drains.
test("owner failure closes next-stage admission before accepted work drains", async t => {
  const fixture = await producerFixture(t);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let registryAttempt: Promise<unknown> | undefined;
  let registryCalls = 0;
  let invocationRoot: string | undefined;
  await assert.rejects(fixture.api.withQualifiedPackageArtifacts("combined", async handle => {
    const packed = fixture.api.runQualifiedArtifactConsumer(handle, "packed", async ({ temporaryRoot }) => {
      invocationRoot = temporaryRoot;
      started.resolve();
      await release.promise;
    });
    registryAttempt = packed.then(() => fixture.api.runQualifiedArtifactConsumer(handle, "registry", () => {
      registryCalls += 1;
    }));
    void registryAttempt.catch(() => {});
    await started.promise;
    setImmediate(() => release.resolve());
    throw new Error("TEST owner failure while packed work is active");
  }), /TEST owner failure/u);
  assert.ok(registryAttempt);
  await assert.rejects(registryAttempt, /closed/u);
  assert.equal(registryCalls, 0);
  assert.ok(invocationRoot);
  await assert.rejects(lstat(invocationRoot), { code: "ENOENT" });
});

test("imports of the producer, consumers and combined entrypoint have no qualification effects", async t => {
  const root = await directory(t, "qi-");
  const modules = ["pack-publishable-artifacts.mjs", "pack-test.mjs", "registry-install-e2e.mjs", "qualify-package-artifacts.mts", "package-qualification-groups.mts", "qualify-package-group.mts"];
  const script = `
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
const before = process.getActiveResourcesInfo().filter(name => name !== 'PipeWrap');
await Promise.all(${JSON.stringify(modules.map(name => pathToFileURL(join(repositoryRoot, "scripts", name)).href))}.map(url => import(url)));
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(await readdir(${JSON.stringify(root)}), []);
assert.deepEqual(process.getActiveResourcesInfo().filter(name => !['PipeWrap', 'Immediate', 'FSReqPromise'].includes(name)), before);
process.stdout.write('import-safe');
`;
  const result = await runCommand(process.execPath, ["--input-type=module", "--eval", script], root,
    { environment: { ...process.env, TMPDIR: root, TMP: root, TEMP: root } });
  assert.equal(result.stdout, "import-safe");
  assert.equal(result.stderr, "");
});

test("direct entrypoints reject archive overrides before allocating resources", async t => {
  const root = await directory(t, "qd-");
  for (const module of ["pack-test.mjs", "registry-install-e2e.mjs", "qualify-package-artifacts.mts"]) {
    await assert.rejects(runCommand(process.execPath, [resolve(repositoryRoot, "scripts", module), "--archive", "/tmp/forged.tgz"], root,
      { environment: { ...process.env, TMPDIR: root, TMP: root, TEMP: root } }), error => {
      assert.ok(error instanceof Error && "stderr" in error && typeof error.stderr === "string");
    assert.match(error.stderr, /accepts no archive overrides/u);
      return true;
    });
    assert.deepEqual(await readdir(root), []);
  }
});
