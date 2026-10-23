import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readFile, realpath, statfs } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { type CanonicalJsonValue } from "@agent-teams/repository-mutation/serialization";
import { type ManagedAttemptPhase } from "../application/managed-runtime-policy.js";
import {
  type ManagedRuntimeAttemptHandle,
  type ProcessFacts,
} from "../application/ports/managed-runtime.js";
export const FORMAT = "agent-teams.managed-runtime-attempt/v1";
export const MAX_RECORD = 64 * 1024;
export const empty: ProcessFacts = Object.freeze({
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
});
export const cleanPath = (value: string): boolean =>
  isAbsolute(value) && resolve(value) === value && !value.includes("\0");
export const digest = (value: string): boolean =>
  /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value);
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export type FileHandle = Awaited<ReturnType<typeof open>>;
export interface PhysicalRoot {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
}
export interface RecordIdentity {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
}
export interface ChildIdentity {
  readonly pid: number;
  readonly start: string;
  readonly pgid: number;
}
export interface AttemptRecord {
  readonly format: typeof FORMAT;
  readonly ["token"]: string;
  readonly record: RecordIdentity;
  readonly consumer: PhysicalRoot;
  readonly controller: {
    readonly pid: number;
    readonly start: string;
    readonly boot: string;
    readonly build: string;
  };
  readonly role: "source" | "target";
  readonly runtime: { readonly node: string; readonly pnpmTree: string };
  readonly phase: ManagedAttemptPhase;
  readonly child: ChildIdentity | null;
  readonly facts: ProcessFacts;
  readonly ownedRoots: readonly PhysicalRoot[];
  readonly preparationDigest: string | null;
  readonly installation: readonly [];
  readonly backup: readonly [];
}
export interface ManagedRuntimeAttempt extends ManagedRuntimeAttemptHandle {
  verifyOwnedRoot(): Promise<boolean>;
  transition(
    phase: Exclude<ManagedAttemptPhase, "acquired">,
    facts: ProcessFacts,
    child?: ChildIdentity,
  ): Promise<void>;
}

/** Project the private record schema into closed data; shared canonicalization remains authoritative. */
export function attemptRecordJson(record: AttemptRecord): CanonicalJsonValue {
  return {
    format: record.format,
    ["token"]: record.token,
    record: {
      device: record.record.device,
      inode: record.record.inode,
      birthtimeNs: record.record.birthtimeNs,
    },
    consumer: {
      path: record.consumer.path,
      device: record.consumer.device,
      inode: record.consumer.inode,
      birthtimeNs: record.consumer.birthtimeNs,
    },
    controller: {
      pid: record.controller.pid,
      start: record.controller.start,
      boot: record.controller.boot,
      build: record.controller.build,
    },
    role: record.role,
    runtime: { node: record.runtime.node, pnpmTree: record.runtime.pnpmTree },
    phase: record.phase,
    child:
      record.child === null
        ? null
        : {
            pid: record.child.pid,
            start: record.child.start,
            pgid: record.child.pgid,
          },
    facts: {
      spawned: record.facts.spawned,
      exitCode: record.facts.exitCode,
      signal: record.facts.signal,
      cancelled: record.facts.cancelled,
      timedOut: record.facts.timedOut,
      stdoutBytes: record.facts.stdoutBytes,
      stderrBytes: record.facts.stderrBytes,
      directChild: record.facts.directChild,
      group: record.facts.group,
      streams: record.facts.streams,
    },
    ownedRoots: record.ownedRoots.map((root) => ({
      path: root.path,
      device: root.device,
      inode: root.inode,
      birthtimeNs: root.birthtimeNs,
    })),
    preparationDigest: record.preparationDigest,
    installation: [],
    backup: [],
  } satisfies { readonly [Key in keyof AttemptRecord]: CanonicalJsonValue };
}

export async function physicalDirectory(path: string): Promise<PhysicalRoot> {
  if (!cleanPath(path) || (await realpath(path)) !== path) {
    throw new Error("noncanonical-root");
  }
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("unsafe-root");
  }
  const filesystem = await statfs(path);
  if (
    ![0xef53, 0x58465342, 0x9123683e, 0x794c7630, 0x01021994, 0x2fc12fc1].includes(filesystem.type)
  ) {
    throw new Error("nonlocal-filesystem");
  }
  return {
    path,
    device: String(info.dev),
    inode: String(info.ino),
    birthtimeNs: String(info.birthtimeNs),
  };
}

export async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}

export async function controllerIdentity(build: string): Promise<AttemptRecord["controller"]> {
  const stat = await readFile("/proc/self/stat", "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (start === undefined || !/^\d+$/.test(start) || !/^[a-f0-9-]{36}$/.test(boot)) {
    throw new Error("controller-identity-unavailable");
  }
  return { pid: process.pid, start, boot, build };
}

function sameRecord(info: BigIntStats, identity: RecordIdentity, links: bigint): boolean {
  return (
    info.isFile() &&
    info.nlink === links &&
    info.size <= BigInt(MAX_RECORD) &&
    String(info.dev) === identity.device &&
    String(info.ino) === identity.inode &&
    String(info.birthtimeNs) === identity.birthtimeNs
  );
}

function unchangedFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.birthtimeNs === right.birthtimeNs &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Descriptor-first, bounded reads also reject a FIFO substituted before open. */
export async function ownsRecord(
  path: string,
  identity: RecordIdentity,
  links: bigint,
  expected: Buffer | null,
): Promise<boolean> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat({ bigint: true });
    if (!sameRecord(before, identity, links)) {
      return false;
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) {
        return false;
      }
      offset += read.bytesRead;
    }
    const after = await fd.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    return (
      unchangedFile(before, after) &&
      unchangedFile(before, named) &&
      (expected === null ? bytes.length === 0 : bytes.equals(expected))
    );
  } finally {
    await fd.close();
  }
}

export async function writeAll(fd: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await fd.write(bytes, offset, bytes.length - offset, offset);
    if (result.bytesWritten === 0) {
      throw new Error("attempt-record-short-write");
    }
    offset += result.bytesWritten;
  }
  await fd.truncate(bytes.length);
  await fd.sync();
}

export async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
