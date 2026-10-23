import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import {
  type ManagedPnpmInstallResult,
  type ProcessFacts,
  type RuntimeDebt,
  type RuntimeObservation,
  type RuntimeRefusalCode,
} from "../application/ports/managed-runtime.js";
import { type ManagedRuntimeAttempt } from "./node-managed-runtime-attempt.js";
import {
  hashRuntimeFile,
  type RuntimeImage,
  type TrustedRuntimeSelection,
} from "./node-managed-runtime-identity.js";
import { verifyLeafArchive } from "./node-managed-runtime-archive.js";
export const empty: ProcessFacts = {
  spawned: false,
  exitCode: null,
  signal: null,
  cancelled: false,
  timedOut: false,
  stdoutBytes: 0,
  stderrBytes: 0,
  directChild: "not-started",
  group: "not-started",
  streams: "not-started",
};
export const uncertain: ProcessFacts = {
  ...empty,
  directChild: "unconfirmed",
  group: "unconfirmed",
  streams: "unconfirmed",
};
export const hex = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value);
export type RefusedInstall = Extract<ManagedPnpmInstallResult, { outcome: "refused" }>;
export interface DirectoryBinding {
  readonly device: bigint;
  readonly inode: bigint;
  readonly birthtimeNs: bigint;
}
export interface InstallationOwner {
  readonly selection: TrustedRuntimeSelection;
  readonly image: RuntimeImage;
  readonly attempt: ManagedRuntimeAttempt;
}

export function refused(
  code: RuntimeRefusalCode,
  facts: ProcessFacts = empty,
  debt: RuntimeDebt | null = null,
): RefusedInstall {
  return { outcome: "refused", code, facts, debt };
}

/** Preserve runtime mode validation for callers outside TypeScript. */
export function validInstallMode(value: unknown): boolean {
  return value === "prepare" || value === "frozen-offline";
}

export async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function bindDirectory(path: string): Promise<DirectoryBinding> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || (await realpath(path)) !== path) {
    throw new Error("installation-directory-substituted");
  }
  return { device: info.dev, inode: info.ino, birthtimeNs: info.birthtimeNs };
}

export function sameDirectory(left: DirectoryBinding, right: DirectoryBinding): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.birthtimeNs === right.birthtimeNs &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

export async function boundedBytes(path: string, maximum = 16 * 1024 * 1024): Promise<Buffer> {
  if ((await realpath(path)) !== path) {
    throw new Error("installation-file-alias");
  }
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) {
      throw new Error("unsafe-installation-file");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) {
        throw new Error("installation-file-short-read");
      }
      offset += read.bytesRead;
    }
    if (
      !sameFile(before, await fd.stat({ bigint: true })) ||
      !sameFile(before, await lstat(path, { bigint: true }))
    ) {
      throw new Error("installation-file-changed");
    }
    return bytes;
  } finally {
    await fd.close();
  }
}

export function yamlValue(bytes: Buffer): unknown {
  const document = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
    uniqueKeys: true,
  });
  if (document.errors.length !== 0) {
    throw new Error("invalid-installation-yaml");
  }
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}

export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
export const fileDigest = async (path: string): Promise<string> =>
  (await hashRuntimeFile(path, 16 * 1024 * 1024, false)).sha256;

async function tarballIntegrity(path: string): Promise<string> {
  if ((await realpath(path)) !== path) {
    throw new Error("local-tarball-alias");
  }
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 128n * 1024n * 1024n) {
      throw new Error("unsafe-local-tarball");
    }
    const hash = createHash("sha512");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < Number(before.size)) {
      const read = await fd.read(
        chunk,
        0,
        Math.min(chunk.length, Number(before.size) - offset),
        offset,
      );
      if (read.bytesRead === 0) {
        throw new Error("local-tarball-short-read");
      }
      hash.update(chunk.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    if (
      !sameFile(before, await fd.stat({ bigint: true })) ||
      !sameFile(before, await lstat(path, { bigint: true }))
    ) {
      throw new Error("local-tarball-changed");
    }
    return `sha512-${hash.digest("base64")}`;
  } finally {
    await fd.close();
  }
}

export async function verifyDirectTarballs(root: string, project: unknown): Promise<void> {
  const dependencies = (project as Record<string, unknown>).dependencies as Record<string, string>;
  const entries = Object.entries(dependencies);
  if (entries.length > 64) {
    throw new Error("local-package-count-limit");
  }
  let compressed = 0;
  let expanded = 0;
  for (const [name, specification] of entries) {
    const path = resolve(root, specification.slice(5));
    if (!path.startsWith(`${root}${sep}`)) {
      throw new Error("local-tarball-outside-root");
    }
    const packed = await boundedBytes(path, 32 * 1024 * 1024);
    compressed += packed.length;
    if (compressed > 64 * 1024 * 1024) {
      throw new Error("local-tarball-total-limit");
    }
    expanded += await verifyLeafArchive(
      packed,
      Math.min(64 * 1024 * 1024, 128 * 1024 * 1024 - expanded),
      name,
    );
  }
}

async function verifyTarball(root: string, value: unknown): Promise<void> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid-lock-resolution");
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.tarball !== "string" ||
    !entry.tarball.startsWith("file:") ||
    typeof entry.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)
  ) {
    throw new Error("nonlocal-lock-resolution");
  }
  const relative = entry.tarball.slice(5);
  const path = resolve(root, relative);
  if (
    !relative ||
    isAbsolute(relative) ||
    relative.includes("\0") ||
    relative.split(/[\\/]/).includes("..") ||
    !path.startsWith(`${root}${sep}`) ||
    (await tarballIntegrity(path)) !== entry.integrity
  ) {
    throw new Error("local-tarball-integrity");
  }
}

export async function verifyLocalTarballs(root: string): Promise<void> {
  const lock = yamlValue(await boundedBytes(join(root, "pnpm-lock.yaml")));
  if (lock === null || typeof lock !== "object" || Array.isArray(lock)) {
    throw new Error("invalid-lock");
  }
  const packages = (lock as Record<string, unknown>).packages;
  if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("invalid-lock-packages");
  }
  for (const info of Object.values(packages)) {
    if (info === null || typeof info !== "object" || Array.isArray(info)) {
      throw new Error("invalid-lock-package");
    }
    await verifyTarball(root, (info as Record<string, unknown>).resolution);
  }
}

export function observation(owner: InstallationOwner): RuntimeObservation {
  const { selection, image } = owner;
  return {
    kind: "managed-runtime-observation",
    tuple: { ...selection.expected },
    node: { ...image.node },
    pnpm: {
      manifest: { ...image.manifest },
      entry: { ...image.entry },
      packageTreeDigest: image.treeDigest,
    },
    launcher: { kind: "direct-node" },
    containment: "cooperative-posix-process-group",
  };
}

/** One attempt's installation custody; the issuing runtime scope authenticates both handles. */
