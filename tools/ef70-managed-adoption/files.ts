import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ownedDirectory } from "../ef70-managed-campaign/owned-root.ts";
import { row, type Row, type SelectedFile } from "../ef70-managed-campaign/campaign-io.ts";

export interface FileImage {
  readonly path: string;
  readonly kind: "file" | "symlink";
  readonly mode: number;
  readonly bytes: number;
  readonly sha256: string;
}
export interface RootIdentity {
  readonly root: string;
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
  readonly ownerUID: number;
}
export function text(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0 && !/[\0\r\n]/u.test(value), label);
  return value;
}
export function list(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), label);
  return value;
}
export function sha256(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}
export function absolute(value: unknown, label: string): string {
  const path = text(value, label);
  assert(isAbsolute(path) && resolve(path) === path, label + ": absolute canonical path");
  return path;
}
export function relativePath(value: unknown): string {
  const path = text(value, "repository path");
  assert(
    !isAbsolute(path) &&
      path.split(sep).every((part) => part !== "" && part !== "." && part !== ".."),
  );
  return path;
}
export function rootIdentity(path: string): RootIdentity {
  ownedDirectory(path);
  const stat = lstatSync(path, { bigint: true });
  return {
    root: path,
    device: String(stat.dev),
    inode: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs),
    ownerUID: Number(stat.uid),
  };
}
function metadata(stat: Stats): Row {
  return {
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    bytes: stat.size,
    nlink: stat.nlink,
    mtime: stat.mtimeMs,
    ctime: stat.ctimeMs,
  };
}
export function regularImage(path: string, maximum = 32 * 1024 * 1024): FileImage {
  assert.equal(realpathSync(path), path, "File traverses an alias: " + path);
  const before = lstatSync(path);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  assert(before.size >= 0 && before.size <= maximum);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    assert.deepEqual(metadata(fstatSync(descriptor)), metadata(before));
    const hash = createHash("sha256"),
      buffer = Buffer.allocUnsafe(64 * 1024);
    let count: number,
      length = 0;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) !== 0) {
      length += count;
      assert(length <= maximum);
      hash.update(buffer.subarray(0, count));
    }
    assert.equal(length, before.size);
    assert.deepEqual(metadata(fstatSync(descriptor)), metadata(before));
    assert.deepEqual(metadata(lstatSync(path)), metadata(before));
    return {
      path,
      kind: "file",
      mode: before.mode & 0o777,
      bytes: length,
      sha256: hash.digest("hex"),
    };
  } finally {
    closeSync(descriptor);
  }
}
export function bytes(path: string, maximum = 32 * 1024 * 1024): Buffer {
  const image = regularImage(path, maximum),
    content = readFileSync(path);
  assert.equal(content.length, image.bytes);
  assert.equal(sha256(content), image.sha256);
  assert.deepEqual(regularImage(path, maximum), image);
  return content;
}
export function selected(path: string): SelectedFile {
  return { path, sha256: "sha256:" + regularImage(path).sha256 };
}
export function json(path: string): Row {
  return row(JSON.parse(bytes(path).toString("utf8")), path);
}
function excluded(prefix: string, name: string): boolean {
  return (
    name === "node_modules" || (prefix === "" && (name === ".git" || name === ".agent-teams-local"))
  );
}
export function inventory(root: string, consumer = true): FileImage[] {
  ownedDirectory(root);
  const result: FileImage[] = [];
  let totalBytes = 0;
  function visit(directory: string, prefix: string, depth: number): void {
    assert(depth <= 32);
    for (const name of readdirSync(directory).toSorted()) {
      if (consumer && excluded(prefix, name)) {
        continue;
      }
      const path = join(directory, name),
        relativeName = prefix ? prefix + "/" + name : name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        visit(path, relativeName, depth + 1);
        continue;
      }
      assert(result.length < 10_000, "Inventory exceeds file bound");
      if (stat.isSymbolicLink()) {
        assert(consumer, "Installed controller archive cannot contain a symlink");
        const target = readlinkSync(path);
        assert.equal(readlinkSync(path), target);
        result.push({
          path: relativeName,
          kind: "symlink",
          mode: stat.mode & 0o777,
          bytes: Buffer.byteLength(target),
          sha256: sha256(target),
        });
        continue;
      }
      const image = regularImage(path);
      totalBytes += image.bytes;
      assert(totalBytes <= 128 * 1024 * 1024, "Inventory exceeds byte bound");
      result.push({ ...image, path: relativeName });
    }
  }
  visit(root, "", 0);
  return result.toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}
export function installedFiles(root: string): Row[] {
  const images = inventory(root, false);
  assert(images.length < 4096);
  return images.map(({ path, mode, sha256: hash, bytes: length }) => ({
    path,
    mode,
    sha256: hash,
    bytes: length,
  }));
}
export function retainAt(root: string, path: string, content: Uint8Array | string): string {
  const relativeName = relativePath(path),
    destination = resolve(root, relativeName);
  assert(destination.startsWith(root + sep));
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  ownedDirectory(dirname(destination));
  writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
  return destination;
}
export function siblingRoots(roots: readonly string[]): void {
  for (const left of roots) {
    ownedDirectory(left);
    for (const right of roots) {
      if (left === right) {
        continue;
      }
      const child = relative(left, right);
      assert(
        child === ".." || child.startsWith(".." + sep) || isAbsolute(child),
        "Protected roots overlap",
      );
    }
  }
  assert.equal(new Set(roots).size, roots.length);
}
