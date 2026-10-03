import type { BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

import { inspectCompressedTarArchive, readVerifiedArchive, sha256 } from "./pack-artifact-archive.mjs";
import {
  boundedDirectoryEntries, containsPhysicalPath, generatedPackageEntries, readStableRegularFile,
} from "./pack-artifact-stage-support.mjs";

export type QualifiedArchiveRecord = Readonly<{
  archivePath: string; archiveName: string; packageName: string; packageVersion: string;
  sha256: string; integrity: string;
}>;
export type QualifiedArchives = Readonly<Record<string, QualifiedArchiveRecord>>;
export type ArchiveCustody = Readonly<{
  directories: ReadonlyMap<string, BigIntStats>; files: ReadonlyMap<string, BigIntStats>; root: string;
}>;
export type QualificationMode = "combined" | "packed" | "registry";
export type QualificationStage = Exclude<QualificationMode, "combined">;
export type QualificationHandle = object;
export type QualificationContext = Readonly<{
  artifacts: QualifiedArchives; temporaryRoot: string; checkpoint: () => Promise<void>;
}>;
export type QualificationEvidence = ReadonlyArray<Readonly<{
  name: string; version: string; sha256: string; integrity: string;
}>>;

// Private qualification mechanism. These observations confer no cross-process
// authority and do not certify a Git revision or hostile same-uid isolation.
function fail(message: string): never {
  throw new Error(`Qualified package artifact custody: ${message}`);
}

function sameIdentity(first: BigIntStats, second: BigIntStats) {
  return first.dev === second.dev && first.ino === second.ino;
}

export async function assertPhysicalPath(path: string, directory = false): Promise<BigIntStats> {
  let current = resolve(path);
  let leaf: BigIntStats | undefined;
  while (true) {
    const metadata = await lstat(current, { bigint: true });
    if (metadata.isSymbolicLink() || (current === resolve(path)
      ? directory ? !metadata.isDirectory() : !metadata.isFile()
      : !metadata.isDirectory())) {
      fail(`path traverses a symlink or special entry: ${current}`);
    }
    leaf ??= metadata;
    const parent = dirname(current);
    if (parent === current) { break; }
    current = parent;
  }
  if (await realpath(path) !== resolve(path)) { fail(`path is not physical: ${path}`); }
  if (leaf === undefined) { fail("physical path has no leaf"); }
  return leaf;
}

async function exactChildren(path: string, names: readonly string[]) {
  const entries = await boundedDirectoryEntries(path, "Qualified snapshot directory", { entries: 0 });
  if (entries.map(({ name }) => name).toSorted().join("\0") !== names.toSorted().join("\0")) {
    fail(`unexpected, missing or extra snapshot entry in ${path}`);
  }
}

export async function retainArchiveCustody(root: string, records: QualifiedArchives): Promise<ArchiveCustody> {
  const directories = new Map([[root, await assertPhysicalPath(root, true)]]);
  const files = new Map<string, BigIntStats>();
  for (const record of Object.values(records)) {
    const parent = dirname(record.archivePath);
    if (!containsPhysicalPath(root, parent) || parent === root || files.has(record.archivePath)) {
      fail("snapshot paths must be unique and contained");
    }
    directories.set(parent, await assertPhysicalPath(parent, true));
    const metadata = await assertPhysicalPath(record.archivePath);
    if (metadata.nlink !== 1n) { fail("archive has a hardlink alias"); }
    files.set(record.archivePath, metadata);
  }
  const custody = { directories, files, root };
  await verifyArchiveCustody(custody, records);
  return custody;
}

export async function verifyArchiveCustody(custody: ArchiveCustody, records: QualifiedArchives) {
  const { directories, files, root } = custody;
  for (const [path, identity] of directories) {
    if (!sameIdentity(identity, await assertPhysicalPath(path, true))) {
      fail(`snapshot directory was replaced: ${path}`);
    }
  }
  await exactChildren(root, [...directories.keys()].filter(path => path !== root).map(path => path.slice(root.length + 1)));
  for (const path of directories.keys()) {
    if (path !== root) {
      await exactChildren(path, [...files.keys()].filter(file => dirname(file) === path).map(file => file.slice(path.length + 1)));
    }
  }
  const identities = new Set();
  for (const record of Object.values(records)) {
    const expected = files.get(record.archivePath);
    const before = await assertPhysicalPath(record.archivePath);
    if (expected === undefined || !sameIdentity(expected, before) || before.nlink !== 1n) {
      fail(`archive was replaced or has a hardlink alias: ${record.archivePath}`);
    }
    const identity = `${before.dev}:${before.ino}`;
    if (before.ino !== 0n && identities.has(identity)) { fail("archives alias the same file"); }
    identities.add(identity);
    const bytes = await readVerifiedArchive(record.archivePath, record.sha256);
    const after = await assertPhysicalPath(record.archivePath);
    if (!sameIdentity(before, after) || after.nlink !== 1n) { fail("archive custody changed during verification"); }
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== record.integrity) {
      fail("archive integrity differs from original qualified bytes");
    }
    const inspection = inspectCompressedTarArchive(bytes, record.packageName);
    const manifests = inspection.entries.filter(entry => entry.name === "package/package.json" && entry.type === "0");
    if (manifests.length !== 1 || inspection.entries.some(entry => !["0", "5"].includes(entry.type))) {
      fail("archive no longer has a safe qualified manifest");
    }
    const manifest = JSON.parse(manifests[0].data.toString("utf8"));
    if (manifest.name !== record.packageName || manifest.version !== record.packageVersion ||
        record.archiveName !== `${manifest.name.replace(/^@/u, "").replace("/", "-")}-${manifest.version}.tgz`) {
      fail("archive name, package name or version differs from qualification");
    }
  }
}

async function fileIdentity(path: string) {
  const physical = await realpath(path);
  const metadata = await lstat(physical, { bigint: true });
  return [physical, ...[metadata.dev, metadata.ino, metadata.size, metadata.mode, metadata.mtimeNs, metadata.ctimeNs].map(String)];
}

async function executableIdentity(command: string, optional = false) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const suffix of process.platform === "win32" ? [".cmd", ".exe", ""] : [""]) {
      const path = resolve(directory, `${command}${suffix}`);
      try {
        const physical = await realpath(path);
        const metadata = await lstat(physical);
        if (metadata.isFile()) {
          return fileIdentity(physical);
        }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) { throw error; }
      }
    }
  }
  if (optional) { return null; }
  fail(`toolchain command is unavailable: ${command}`);
}

export async function capturePackageArtifactInputs(repositoryRoot: string, packages: readonly { root: string }[], declarations: unknown, additionalPaths: readonly string[] = []) {
  const digest = createHash("sha256");
  const state = { bytes: 0, entries: 0 };
  const add = (path: string, value: unknown) => digest.update(JSON.stringify([path, value])).update("\n");
  add("projection", { packages, declarations });
  add("runtime", { versions: process.versions, platform: process.platform, arch: process.arch,
    executable: await fileIdentity(process.execPath), pnpm: await executableIdentity("pnpm"), npm: await executableIdentity("npm", true),
    environment: [process.env.PATH, process.env.NODE_OPTIONS, process.env.NODE_ENV, process.env.SOURCE_DATE_EPOCH] });
  async function visit(path: string, depth = 0) {
    if (depth > 64) { fail("input traversal exceeds its bound"); }
    const absolute = join(repositoryRoot, path);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) { fail(`qualification input is a symlink: ${path}`); }
    if (metadata.isDirectory()) {
      add(path, "directory");
      const entries = await boundedDirectoryEntries(absolute, "Qualification inputs", state);
      for (const entry of entries.toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (!generatedPackageEntries.has(entry.name)) { await visit(`${path}/${entry.name}`, depth + 1); }
      }
    } else if (metadata.isFile()) {
      const { bytes, mode } = await readStableRegularFile(absolute, state, "Qualification inputs");
      add(path, [mode, sha256(bytes)]);
    } else { fail(`qualification input is a special file: ${path}`); }
  }
  for (const path of [...new Set(["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "LICENSE", "scripts",
    ...packages.map(entry => entry.root), ...additionalPaths])].toSorted()) { await visit(path); }
  return digest.digest("hex");
}
