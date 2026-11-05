import assert from "node:assert/strict";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCommand, writeJson } from "./pack-test-support.mjs";
import {
  localModeJson,
  rejectPackedFoundation,
  runPackedFoundation,
  type PackedLocalModeCommand,
} from "./packed-local-mode-command.ts";

export interface PackedLocalModeCustody extends PackedLocalModeCommand {
  readonly repositoryRoot: string;
  readonly temporaryRoot: string;
  readonly packageVersion: string;
  readonly installedPackageRoot: string;
}

function localPaths(input: PackedLocalModeCommand) {
  return {
    installed: join(input.consumerRoot, "node_modules", "@agent-teams", "engineering-foundation"),
    marker: join(input.consumerRoot, ".agent-teams-local", "foundation-link.json"),
    backup: join(input.consumerRoot, ".agent-teams-local", "foundation-registry-backup"),
  };
}

async function entryIdentity(path: string) {
  const metadata = await lstat(path, { bigint: true });
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    link: metadata.isSymbolicLink() ? await readlink(path) : undefined,
  };
}

async function backupEvidence(path: string) {
  return {
    entry: await entryIdentity(path),
    root: await realpath(path),
    manifest: await readFile(join(path, "package.json")),
  };
}

async function attach(input: PackedLocalModeCustody, target = input.repositoryRoot): Promise<void> {
  const result = await runPackedFoundation(input, [
    "attach",
    target,
    "--consumer",
    input.consumerRoot,
    "--json",
  ]);
  assert.equal(localModeJson(result.stdout)["mode"], "LOCAL");
  assert.equal(result.stderr, "");
}

async function detach(input: PackedLocalModeCommand): Promise<void> {
  const result = await runPackedFoundation(input, [
    "detach",
    "--consumer",
    input.consumerRoot,
    "--json",
  ]);
  assert.equal(localModeJson(result.stdout)["mode"], "REGISTRY");
  assert.equal(result.stderr, "");
  const paths = localPaths(input);
  for (const path of [paths.marker, paths.backup]) {
    await assert.rejects(lstat(path), { code: "ENOENT" });
  }
}

async function rejectDetach(input: PackedLocalModeCommand): Promise<void> {
  const result = await rejectPackedFoundation(
    input,
    ["detach", "--consumer", input.consumerRoot, "--json"],
    1,
  );
  assert.equal(result.stderr, "");
  assert.equal(localModeJson(result.stdout)["outcome"], "execution-failure");
}

async function assertRecoveryMarkerRetained(path: string, previous: Buffer): Promise<void> {
  const before = localModeJson(previous.toString("utf8"));
  const after = localModeJson(await readFile(path, "utf8"));
  assert.equal(after["schemaVersion"], 1);
  assert.ok(after["phase"] === "LOCAL" || after["phase"] === "DETACHING");
  for (const key of Object.keys(before).filter((field) => field !== "phase")) {
    assert.deepEqual(after[key], before[key], `Failed detach lost recovery marker field ${key}.`);
  }
}

async function verifyForeignDirectory(input: PackedLocalModeCustody): Promise<void> {
  await attach(input);
  const paths = localPaths(input);
  const parkedLink = join(input.consumerRoot, "parked-local-directory-link");
  const evidence = await backupEvidence(paths.backup);
  const marker = await readFile(paths.marker);
  await rename(paths.installed, parkedLink);
  await writeJson(join(paths.installed, "package.json"), {
    name: "@agent-teams/engineering-foundation",
    version: input.packageVersion,
  });
  const sentinel = join(paths.installed, "foreign", "preserve.bin");
  await mkdir(dirname(sentinel));
  const bytes = Buffer.from([0, 255, 1, 128, 42]);
  await writeFile(sentinel, bytes);
  const identity = await entryIdentity(paths.installed);
  const manifest = await readFile(join(paths.installed, "package.json"));

  await rejectDetach(input);
  assert.deepEqual(await entryIdentity(paths.installed), identity);
  assert.deepEqual(await readFile(sentinel), bytes);
  assert.deepEqual(await readFile(join(paths.installed, "package.json")), manifest);
  assert.deepEqual(await backupEvidence(paths.backup), evidence);
  await assertRecoveryMarkerRetained(paths.marker, marker);

  // Only the fixture-created foreign entry is removed; the retained original link is restored.
  await rm(paths.installed, { recursive: true });
  await rename(parkedLink, paths.installed);
  await detach(input);
}

async function verifyForeignLink(input: PackedLocalModeCustody): Promise<void> {
  await attach(input);
  const paths = localPaths(input);
  const parkedLink = join(input.consumerRoot, "parked-local-symbolic-link");
  const foreignRoot = join(input.temporaryRoot, "foreign-local-mode-target");
  await mkdir(foreignRoot);
  const sentinel = join(foreignRoot, "preserve.txt");
  await writeFile(sentinel, "foreign target remains owned by its creator\n", "utf8");
  const evidence = await backupEvidence(paths.backup);
  const marker = await readFile(paths.marker);
  await rename(paths.installed, parkedLink);
  await symlink(foreignRoot, paths.installed, process.platform === "win32" ? "junction" : "dir");
  const identity = await entryIdentity(paths.installed);
  const bytes = await readFile(sentinel);

  await rejectDetach(input);
  assert.deepEqual(await entryIdentity(paths.installed), identity);
  assert.deepEqual(await readFile(sentinel), bytes);
  assert.deepEqual(await backupEvidence(paths.backup), evidence);
  await assertRecoveryMarkerRetained(paths.marker, marker);

  await unlink(paths.installed);
  await rename(parkedLink, paths.installed);
  await detach(input);
}

async function verifyOrphanBackup(input: PackedLocalModeCustody): Promise<void> {
  await attach(input);
  const paths = localPaths(input);
  const marker = await readFile(paths.marker);
  const evidence = await backupEvidence(paths.backup);
  const localLink = await entryIdentity(paths.installed);
  await unlink(paths.marker);

  // The same link text is insufficient authority once its marker has been lost.
  await rejectDetach(input);
  assert.deepEqual(await entryIdentity(paths.installed), localLink);
  assert.deepEqual(await backupEvidence(paths.backup), evidence);
  await assert.rejects(lstat(paths.marker), { code: "ENOENT" });

  // The explicit fixture repair reinstates the original marker and permits normal detach.
  await writeFile(paths.marker, marker, { flag: "wx" });
  await detach(input);

  await attach(input);
  await unlink(paths.marker);
  await unlink(paths.installed);
  await detach(input);
}

async function verifyDanglingTarget(input: PackedLocalModeCustody): Promise<void> {
  const target = await mkdtemp(join(dirname(input.installedPackageRoot), "local-target-"));
  await cp(input.installedPackageRoot, target, { recursive: true, dereference: false });
  await runCommand("git", ["init", "--quiet"], target);
  await runCommand(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "Local target fixture",
    ],
    target,
  );
  await attach(input, target);
  const paths = localPaths(input);
  const evidence = await backupEvidence(paths.backup);
  await rm(target, { recursive: true });
  assert.equal((await lstat(paths.installed)).isSymbolicLink(), true);
  await assert.rejects(realpath(paths.installed), { code: "ENOENT" });
  assert.deepEqual(await backupEvidence(paths.backup), evidence);
  await detach(input);
}

async function verifyUnownedTemporary(input: PackedLocalModeCustody): Promise<void> {
  await attach(input);
  const paths = localPaths(input);
  const temporary = `${paths.marker}.unowned.tmp`;
  const bytes = Buffer.from("retained incomplete marker publication\n");
  await writeFile(temporary, bytes, { flag: "wx" });
  const marker = await readFile(paths.marker);
  const evidence = await backupEvidence(paths.backup);
  await rejectDetach(input);
  assert.deepEqual(await readFile(temporary), bytes);
  assert.deepEqual(await readFile(paths.marker), marker);
  assert.deepEqual(await backupEvidence(paths.backup), evidence);
  await unlink(temporary);
  await detach(input);
}

export async function verifyPackedLocalModeCustody(input: PackedLocalModeCustody): Promise<void> {
  await verifyForeignDirectory(input);
  await verifyForeignLink(input);
  await verifyOrphanBackup(input);
  await verifyDanglingTarget(input);
  await verifyUnownedTemporary(input);
  await attach(input);
  await unlink(localPaths(input).installed);
  await detach(input);
  await detach(input); // Already-restored registry state stays idempotent.
}
