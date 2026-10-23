import { constants, open, realpath, lstat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { getNodeValue, parseTree, type Node, type ParseError } from "jsonc-parser";
import { inspectBunLockfile } from "../../application/bun-registry-policy.js";
import {
  FOUNDATION_PACKAGE_NAME,
  type RegistryProvenanceInspection,
} from "../../application/model.js";

const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface FileSnapshot extends FileIdentity {
  readonly nlink: number;
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(before: FileSnapshot, after: FileSnapshot): boolean {
  return (
    sameIdentity(before, after) &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function capturePathIdentity(root: string, path: string, expected: FileIdentity) {
  if ((await realpath(root)) !== root || (await realpath(dirname(path))) !== dirname(path)) {
    throw new Error("File ancestry must remain canonical.");
  }
  const rootDirectory = await lstat(root);
  const parentDirectory = await lstat(dirname(path));
  if (!rootDirectory.isDirectory() || !parentDirectory.isDirectory()) {
    throw new Error("File ancestry must remain regular directories.");
  }
  const observed = await lstat(path);
  if (!observed.isFile() || !sameIdentity(observed, expected)) {
    throw new Error("File identity changed.");
  }
  return { rootDirectory, parentDirectory };
}

async function readBoundedBytes(file: FileHandle, maximumBytes: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > maximumBytes) {
    throw new Error("File exceeds its byte bound.");
  }
  return buffer.subarray(0, offset);
}

async function readRegularFile(root: string, path: string, maximumBytes: number): Promise<string> {
  const relation = relative(root, path);
  if (isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error("File must remain contained.");
  }
  const flags =
    constants.O_RDONLY |
    (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const file = await open(path, flags);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximumBytes) {
      throw new Error("Expected a bounded regular file.");
    }
    const before = await capturePathIdentity(root, path, stat);
    const bytes = await readBoundedBytes(file, maximumBytes);
    const after = await file.stat();
    const current = await capturePathIdentity(root, path, stat);
    if (
      !sameSnapshot(stat, after) ||
      bytes.length !== stat.size ||
      !sameIdentity(before.rootDirectory, current.rootDirectory) ||
      !sameIdentity(before.parentDirectory, current.parentDirectory)
    ) {
      throw new Error("File changed during its bounded read.");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await file.close();
  }
}

function readUniqueObject(source: string, allowJsonc = true): Record<string, unknown> {
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, {
    allowTrailingComma: allowJsonc,
    disallowComments: !allowJsonc,
  });
  if (tree?.type !== "object" || errors.length !== 0) {
    throw new Error("Expected an unambiguous JSONC object.");
  }
  const pending: Node[] = [tree];
  while (pending.length !== 0) {
    const node = pending.pop();
    if (node === undefined) {
      break;
    }
    if (node.type === "object") {
      const keys = new Set<unknown>();
      for (const property of node.children ?? []) {
        const key: unknown = property.children?.[0]?.value;
        if (keys.has(key)) {
          throw new Error("Duplicate JSONC key.");
        }
        keys.add(key);
      }
    }
    pending.push(...(node.children ?? []));
  }
  return getNodeValue(tree) as Record<string, unknown>;
}

async function inspectInstalledSelection(consumerRoot: string, version: string): Promise<void> {
  const modules = await realpath(join(consumerRoot, "node_modules"));
  if (modules !== join(await realpath(consumerRoot), "node_modules")) {
    throw new Error("External node_modules is unsupported.");
  }
  const root = await realpath(join(modules, FOUNDATION_PACKAGE_NAME));
  const coordinate = relative(modules, root).split(sep);
  const expected = `@agent-teams+engineering-foundation@${version}`;
  if (
    coordinate.length !== 5 ||
    coordinate[0] !== ".bun" ||
    !(
      coordinate[1] === expected ||
      coordinate[1]?.match(/^(.+)\+([a-f0-9]{16})$/u)?.[1] === expected
    ) ||
    coordinate[2] !== "node_modules" ||
    coordinate[3] !== "@agent-teams" ||
    coordinate[4] !== "engineering-foundation"
  ) {
    throw new Error("Only the contained Bun isolated registry layout is supported.");
  }
  const manifestPath = join(root, "package.json");
  if ((await realpath(manifestPath)) !== manifestPath) {
    throw new Error("Installed manifest must be canonical.");
  }
  const manifest = readUniqueObject(
    await readRegularFile(modules, manifestPath, MAX_MANIFEST_BYTES),
    false,
  );
  if (manifest.name !== FOUNDATION_PACKAGE_NAME || manifest.version !== version) {
    throw new Error("Installed Foundation identity must equal the Bun lock selection.");
  }
}

export async function inspectBunRegistryProvenance(
  consumerRoot: string,
  dependencySpec: string | undefined,
): Promise<RegistryProvenanceInspection> {
  try {
    const root = await realpath(consumerRoot);
    const lockfilePath = join(root, "bun.lock");
    const selected = inspectBunLockfile(
      readUniqueObject(await readRegularFile(root, lockfilePath, MAX_LOCK_BYTES)),
      dependencySpec,
    );
    if (
      selected.issues.length !== 0 ||
      selected.packageKey === undefined ||
      selected.integrity === undefined ||
      dependencySpec === undefined
    ) {
      return { issues: selected.issues };
    }
    await inspectInstalledSelection(root, dependencySpec);
    return {
      provenance: { lockfilePath, packageKey: selected.packageKey, integrity: selected.integrity },
      issues: [],
    };
  } catch (error) {
    return {
      issues: [
        `Consumer Bun registry selection cannot be inspected safely: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

export async function readBoundedConsumerManifest(
  consumerRoot: string,
): Promise<Record<string, unknown>> {
  const root = await realpath(consumerRoot);
  return readUniqueObject(
    await readRegularFile(root, join(root, "package.json"), MAX_MANIFEST_BYTES),
    false,
  );
}
