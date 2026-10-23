import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

async function installedLinks(directory) {
  const links = [];
  for await (const entry of await opendir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      links.push(path);
    } else if (entry.isDirectory()) {
      links.push(...(await installedLinks(path)));
    }
  }
  return links;
}

const publicApiFixtureLink = join(".pnpm", "node_modules", "@fixture", "public-api");
const publicApiFixtureTarget = join("packages", "library");

async function approvedWorkspaceFixtureTarget(source, sourceLink, physicalTarget) {
  assert.equal(
    relative(source, sourceLink),
    publicApiFixtureLink,
    "Installed dependency link escapes its node_modules closure",
  );
  const consumerRoot = dirname(source);
  const target = join(consumerRoot, publicApiFixtureTarget);
  let canonicalTarget;
  try {
    canonicalTarget = await realpath(target);
  } catch {
    assert.fail("Installed dependency link escapes its node_modules closure");
  }
  assert.equal(
    physicalTarget,
    canonicalTarget,
    "Installed dependency link escapes its node_modules closure",
  );
  const targetStatus = await lstat(target);
  assert.ok(
    targetStatus.isDirectory() && !targetStatus.isSymbolicLink(),
    "Approved workspace fixture target must be a physical directory",
  );
  return target;
}

async function assertRegularFixtureTree(directory) {
  for await (const entry of await opendir(directory)) {
    const path = join(directory, entry.name);
    const status = await lstat(path);
    assert.ok(
      !status.isSymbolicLink(),
      "Approved workspace fixture target must not contain symbolic links",
    );
    assert.ok(
      status.isDirectory() || status.isFile(),
      "Approved workspace fixture target must contain only regular files and directories",
    );
    if (status.isDirectory()) {
      await assertRegularFixtureTree(path);
    }
  }
}

function hasReliableFileIdentity(metadata) {
  return metadata.ino !== 0n;
}

async function validateWorkspaceFixtureSnapshot(snapshot, testHooks) {
  const snapshotStatus = await lstat(snapshot);
  assert.ok(
    snapshotStatus.isDirectory() && !snapshotStatus.isSymbolicLink(),
    "Approved workspace fixture snapshot must be a physical directory",
  );
  await assertRegularFixtureTree(snapshot);
  await testHooks.afterFixtureSnapshotTreeValidated?.({ snapshot });
  const manifestPath = join(snapshot, "package.json");
  const noFollowFlags =
    process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  const manifestHandle = await open(manifestPath, fsConstants.O_RDONLY | noFollowFlags);
  try {
    await testHooks.afterFixtureSnapshotManifestOpened?.({ manifestPath });
    const [manifestPathStatus, manifestHandleStatus] = await Promise.all([
      lstat(manifestPath, { bigint: true }),
      manifestHandle.stat({ bigint: true }),
    ]);
    assert.ok(
      manifestPathStatus.isFile() &&
        !manifestPathStatus.isSymbolicLink() &&
        manifestHandleStatus.isFile(),
      "Approved workspace fixture manifest must be a regular file",
    );
    assert.ok(
      !hasReliableFileIdentity(manifestPathStatus) ||
        !hasReliableFileIdentity(manifestHandleStatus) ||
        (manifestPathStatus.dev === manifestHandleStatus.dev &&
          manifestPathStatus.ino === manifestHandleStatus.ino),
      "Approved workspace fixture manifest identity changed",
    );
    const manifest = JSON.parse(await manifestHandle.readFile("utf8"));
    assert.equal(
      manifest.name,
      "@fixture/public-api",
      "Approved workspace fixture identity changed",
    );
  } finally {
    await manifestHandle.close();
  }
}

const sameFileState = (before, after) =>
  after.isFile() &&
  !after.isSymbolicLink() &&
  before.size === after.size &&
  before.mtimeNs === after.mtimeNs &&
  (!hasReliableFileIdentity(before) ||
    !hasReliableFileIdentity(after) ||
    (before.dev === after.dev && before.ino === after.ino));

const sameDirectoryState = (before, after) =>
  after.isDirectory() &&
  !after.isSymbolicLink() &&
  (!hasReliableFileIdentity(before) ||
    !hasReliableFileIdentity(after) ||
    (before.dev === after.dev && before.ino === after.ino));

// lstat-driven finite copy of regular files and directories only. fs.cp does not preserve or
// reliably classify Windows junctions (it follows them and fails on dangling ones), so every
// link is reported to the caller instead of being followed or copied.
async function copyPhysicalDirectory(source, destination, { onLink, irregularMessage }) {
  const directory = await lstat(source, { bigint: true });
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink(), irregularMessage);
  await mkdir(destination);
  const handle = await opendir(source);
  // opendir follows links, so the same physical directory must still be at the path afterwards.
  assert.ok(
    sameDirectoryState(directory, await lstat(source, { bigint: true })),
    `Source directory changed while opening: ${source}`,
  );
  for await (const entry of handle) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const before = await lstat(from, { bigint: true });
    if (before.isSymbolicLink()) {
      await onLink(from);
      continue;
    }
    if (before.isDirectory()) {
      await copyPhysicalDirectory(from, to, { onLink, irregularMessage });
      continue;
    }
    assert.ok(before.isFile(), irregularMessage);
    await copyFile(from, to, fsConstants.COPYFILE_EXCL);
    assert.ok(
      sameFileState(before, await lstat(from, { bigint: true })),
      `Source changed while copying: ${relative(source, from)}`,
    );
  }
}

async function assertAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  assert.fail(`Copy destination already exists: ${path}`);
}

export async function copyInstalledClosure(source, destination, testHooks = {}) {
  await assertAbsent(destination);
  const physicalSource = await realpath(source);
  const links = await installedLinks(source);
  const plan = [];

  for (const sourceLink of links.toSorted()) {
    const physicalTarget = await realpath(sourceLink);
    const targetSuffix = relative(physicalSource, physicalTarget);
    const contained = !isAbsolute(targetSuffix) && targetSuffix.split(/[\\/]/u)[0] !== "..";
    if (!contained) {
      plan.push({
        fixtureSource: await approvedWorkspaceFixtureTarget(source, sourceLink, physicalTarget),
        relativeLink: relative(source, sourceLink),
      });
      continue;
    }

    const targetStatus = await stat(physicalTarget);
    plan.push({
      relativeLink: relative(source, sourceLink),
      targetSuffix,
      targetType: targetStatus.isDirectory()
        ? process.platform === "win32"
          ? "junction"
          : "dir"
        : "file",
    });
  }

  const fixture = plan.find(({ fixtureSource }) => fixtureSource !== undefined);
  if (fixture !== undefined) {
    await testHooks.afterFixtureTargetApproved?.({ fixtureSource: fixture.fixtureSource });
  }

  const temporaryRoot = await mkdtemp(join(dirname(destination), ".quality-closure-copy-"));
  const stagedDestination = join(temporaryRoot, "node_modules");
  const fixtureSnapshot = join(temporaryRoot, "public-api-fixture");
  try {
    if (fixture !== undefined) {
      await copyPhysicalDirectory(fixture.fixtureSource, fixtureSnapshot, {
        onLink: () =>
          assert.fail("Approved workspace fixture target must not contain symbolic links"),
        irregularMessage:
          "Approved workspace fixture target must contain only regular files and directories",
      });
      await validateWorkspaceFixtureSnapshot(fixtureSnapshot, testHooks);
      await testHooks.afterFixtureSnapshotValidated?.({ fixtureSource: fixture.fixtureSource });
    }

    // Links are never copied: each one was validated into `plan` and is recreated below.
    const plannedLinks = new Set(plan.map(({ relativeLink }) => relativeLink));
    const seenLinks = new Set();
    await copyPhysicalDirectory(source, stagedDestination, {
      onLink: (path) => {
        const link = relative(source, path);
        assert.ok(plannedLinks.has(link), "Installed dependency link set changed during copy");
        seenLinks.add(link);
      },
      irregularMessage:
        "Installed dependency closure must contain only regular files, directories and planned links",
    });
    // A planned link that was removed or replaced by a directory is not silently recreated.
    assert.deepEqual(
      [...seenLinks].toSorted(),
      [...plannedLinks].toSorted(),
      "Installed dependency link set changed during copy",
    );

    for (const { fixtureSource, relativeLink, targetSuffix, targetType } of plan) {
      const destinationLink = join(stagedDestination, relativeLink);
      await rm(destinationLink, { recursive: true, force: true });
      await mkdir(dirname(destinationLink), { recursive: true });
      if (fixtureSource !== undefined) {
        await rename(fixtureSnapshot, destinationLink);
        continue;
      }
      await symlink(join(destination, targetSuffix), destinationLink, targetType);
    }

    await rename(stagedDestination, destination);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}
