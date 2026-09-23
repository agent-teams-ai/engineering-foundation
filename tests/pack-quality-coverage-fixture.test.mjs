import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { copyInstalledClosure } from "../scripts/pack-quality-coverage-test.mjs";

async function createQualityClosureFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "quality-closure-fixture-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const consumerRoot = join(root, "source-consumer");
  const source = join(consumerRoot, "node_modules");
  const destination = join(root, "copied-consumer", "node_modules");
  const fixtureRoot = join(consumerRoot, "packages", "library");
  const fixtureLink = join(source, ".pnpm", "node_modules", "@fixture", "public-api");
  const installedTool = join(source, ".pnpm", "tool@1.0.0", "node_modules", "tool");
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(join(fixtureLink, ".."), { recursive: true });
  await mkdir(installedTool, { recursive: true });
  await mkdir(join(destination, ".."), { recursive: true });
  await writeFile(join(fixtureRoot, "package.json"), JSON.stringify({ name: "@fixture/public-api" }));
  await writeFile(join(fixtureRoot, "fixture.txt"), "workspace fixture bytes\n");
  await writeFile(join(installedTool, "package.json"), JSON.stringify({ name: "tool", version: "1.0.0" }));
  const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(
    process.platform === "win32" ? fixtureRoot : "../../../../packages/library",
    fixtureLink,
    directoryLinkType
  );
  await symlink(installedTool, join(source, "tool"), directoryLinkType);
  return { consumerRoot, destination, fixtureRoot, root, source };
}

test("quality closure materializes only its real workspace fixture", async (t) => {
  const fixture = await createQualityClosureFixture(t);
  await copyInstalledClosure(fixture.source, fixture.destination);

  const copiedFixture = join(
    fixture.destination,
    ".pnpm", "node_modules", "@fixture", "public-api"
  );
  assert((await lstat(copiedFixture)).isDirectory());
  assert(!(await lstat(copiedFixture)).isSymbolicLink());
  await rm(fixture.consumerRoot, { force: true, recursive: true });
  assert.equal(await readFile(join(copiedFixture, "fixture.txt"), "utf8"), "workspace fixture bytes\n");
  assert.equal(
    await readFile(join(fixture.destination, "tool", "package.json"), "utf8"),
    JSON.stringify({ name: "tool", version: "1.0.0" })
  );
  const copiedTool = await realpath(join(fixture.destination, "tool"));
  assert.equal(relative(await realpath(fixture.destination), copiedTool).split(/[\\/]/u)[0], ".pnpm");
});

test("quality closure rejects arbitrary absolute and sibling links", async (t) => {
  for (const name of ["absolute", "sibling"]) {
    await t.test(name, async (context) => {
      const root = await mkdtemp(join(tmpdir(), `quality-closure-${name}-`));
      context.after(() => rm(root, { force: true, recursive: true }));
      const source = join(root, "consumer", "node_modules");
      const outside = join(root, name === "absolute" ? "outside" : "consumer", "sibling");
      const destination = join(root, "copied", "node_modules");
      await mkdir(source, { recursive: true });
      await mkdir(outside, { recursive: true });
      await mkdir(join(destination, ".."), { recursive: true });
      await symlink(
        name === "absolute" || process.platform === "win32" ? outside : "../sibling",
        join(source, "malicious"),
        process.platform === "win32" ? "junction" : "dir"
      );
      await assert.rejects(
        copyInstalledClosure(source, destination),
        /Installed dependency link escapes its node_modules closure/u
      );
      await assert.rejects(lstat(destination), { code: "ENOENT" });
    });
  }
});

test("quality closure rejects an approved-path link to an arbitrary target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "quality-closure-spoofed-fixture-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const source = join(root, "consumer", "node_modules");
  const destination = join(root, "copied", "node_modules");
  const fixtureLink = join(source, ".pnpm", "node_modules", "@fixture", "public-api");
  const outside = join(root, "outside");
  await mkdir(join(fixtureLink, ".."), { recursive: true });
  await mkdir(join(destination, ".."), { recursive: true });
  await mkdir(outside);
  await symlink(outside, fixtureLink, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    copyInstalledClosure(source, destination),
    /Installed dependency link escapes its node_modules closure/u
  );
  await assert.rejects(lstat(destination), { code: "ENOENT" });
});

test("quality closure rejects links hidden in the approved fixture", async (t) => {
  const fixture = await createQualityClosureFixture(t);
  const outside = join(fixture.root, "outside");
  await mkdir(outside);
  await symlink(
    outside,
    join(fixture.fixtureRoot, "hidden-dependency"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await assert.rejects(
    copyInstalledClosure(fixture.source, fixture.destination),
    /Approved workspace fixture target must not contain symbolic links/u
  );
  await assert.rejects(lstat(fixture.destination), { code: "ENOENT" });
});

test("quality closure validates the fixture snapshot after copying it", async (t) => {
  const fixture = await createQualityClosureFixture(t);
  const outside = join(fixture.root, "outside");
  await mkdir(outside);
  await assert.rejects(
    copyInstalledClosure(fixture.source, fixture.destination, {
      afterFixtureTargetApproved: async () => {
        await symlink(
          outside,
          join(fixture.fixtureRoot, "late-hidden-dependency"),
          process.platform === "win32" ? "junction" : "dir"
        );
      }
    }),
    /Approved workspace fixture target must not contain symbolic links/u
  );
  await assert.rejects(lstat(fixture.destination), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(fixture.destination, "..")), []);
});

test("quality closure rejects a manifest symlink replacement after snapshot validation", async (t) => {
  const fixture = await createQualityClosureFixture(t);
  const outsideManifest = join(fixture.root, "outside-package.json");
  const symlinkProbe = join(fixture.root, "manifest-symlink-probe.json");
  await writeFile(outsideManifest, JSON.stringify({ name: "@fixture/public-api" }));
  try {
    await symlink(outsideManifest, symlinkProbe, "file");
  } catch (error) {
    if (process.platform === "win32" && error?.code === "EPERM") {
      t.skip("Creating file symlinks requires unavailable Windows privileges");
      return;
    }
    throw error;
  }
  await rm(symlinkProbe);
  await assert.rejects(
    copyInstalledClosure(fixture.source, fixture.destination, {
      afterFixtureSnapshotTreeValidated: async ({ snapshot }) => {
        const manifestPath = join(snapshot, "package.json");
        await rm(manifestPath);
        await symlink(outsideManifest, manifestPath);
      }
    }),
    (error) => error?.code === "ELOOP" ||
      (error?.code === "ERR_ASSERTION" &&
        /Approved workspace fixture manifest must be a regular file/u.test(error.message))
  );
  await assert.rejects(lstat(fixture.destination), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(fixture.destination, "..")), []);
});

test("quality closure rejects a manifest path replacement after opening it", async (t) => {
  const fixture = await createQualityClosureFixture(t);
  const { ino } = await lstat(join(fixture.fixtureRoot, "package.json"), { bigint: true });
  if (ino === 0n) {
    t.skip("File IDs are unavailable on this filesystem");
    return;
  }
  await assert.rejects(
    copyInstalledClosure(fixture.source, fixture.destination, {
      afterFixtureSnapshotManifestOpened: async ({ manifestPath }) => {
        await rm(manifestPath);
        await writeFile(manifestPath, JSON.stringify({ name: "@fixture/public-api" }));
      }
    }),
    /Approved workspace fixture manifest identity changed/u
  );
  await assert.rejects(lstat(fixture.destination), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(fixture.destination, "..")), []);
});

test("quality closure never rereads the fixture after validating its snapshot", async (t) => {
  await t.test("source mutation", async (context) => {
    const fixture = await createQualityClosureFixture(context);
    const outside = join(fixture.root, "replacement");
    await mkdir(outside);
    await writeFile(join(outside, "fixture.txt"), "replacement bytes\n");
    await copyInstalledClosure(fixture.source, fixture.destination, {
      afterFixtureSnapshotValidated: async () => {
        await rm(fixture.fixtureRoot, { force: true, recursive: true });
        await symlink(
          outside,
          fixture.fixtureRoot,
          process.platform === "win32" ? "junction" : "dir"
        );
      }
    });
    assert.equal(
      await readFile(join(
        fixture.destination,
        ".pnpm", "node_modules", "@fixture", "public-api", "fixture.txt"
      ), "utf8"),
      "workspace fixture bytes\n"
    );
  });

  await t.test("source deletion", async (context) => {
    const fixture = await createQualityClosureFixture(context);
    await copyInstalledClosure(fixture.source, fixture.destination, {
      afterFixtureSnapshotValidated: async () => {
        await rm(fixture.fixtureRoot, { force: true, recursive: true });
      }
    });
    assert.equal(
      await readFile(join(
        fixture.destination,
        ".pnpm", "node_modules", "@fixture", "public-api", "fixture.txt"
      ), "utf8"),
      "workspace fixture bytes\n"
    );
  });
});
