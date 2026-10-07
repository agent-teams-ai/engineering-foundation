import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdtemp, open, readFile, realpath, rm, statfs, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, type CanonicalJsonValue } from "@agent-teams/repository-mutation/serialization";
import { permitsAttemptRelease, permitsAttemptTransition, snapshotAttemptInput,
  type ManagedAttemptPhase } from "../application/managed-runtime-policy.js";
import type { AttemptAcquisition, ManagedAttemptClose, ManagedAttemptInput,
  ManagedRuntimeAttemptHandle, ManagedRuntimeHandle, ProcessFacts, RuntimeDebt } from "../application/ports/managed-runtime.js";
import type { RuntimeImage } from "./node-managed-runtime-identity.js";

const FORMAT = "agent-teams.managed-runtime-attempt/v1";
const MAX_RECORD = 64 * 1024;
const empty: ProcessFacts = Object.freeze({ spawned: false, exitCode: null, signal: null,
  cancelled: false, timedOut: false, stdoutBytes: 0, stderrBytes: 0,
  directChild: "not-started", group: "not-started", streams: "not-started" });
const cleanPath = (value: string): boolean =>
  isAbsolute(value) && resolve(value) === value && !value.includes("\0");
const digest = (value: string): boolean => /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
type FileHandle = Awaited<ReturnType<typeof open>>;
interface PhysicalRoot {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
}
interface RecordIdentity {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
}
interface ChildIdentity {
  readonly pid: number;
  readonly start: string;
  readonly pgid: number;
}
interface AttemptRecord {
  readonly format: typeof FORMAT;
  readonly ["token"]: string;
  readonly record: RecordIdentity;
  readonly consumer: PhysicalRoot;
  readonly controller: { readonly pid: number; readonly start: string; readonly boot: string; readonly build: string };
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
  transition(phase: Exclude<ManagedAttemptPhase, "acquired">, facts: ProcessFacts, child?: ChildIdentity): Promise<void>;
}

/** Project the private record schema into closed data; shared canonicalization remains authoritative. */
function attemptRecordJson(record: AttemptRecord): CanonicalJsonValue {
  return {
    format: record.format,
    ["token"]: record.token,
    record: { device: record.record.device, inode: record.record.inode,
      birthtimeNs: record.record.birthtimeNs },
    consumer: { path: record.consumer.path, device: record.consumer.device,
      inode: record.consumer.inode, birthtimeNs: record.consumer.birthtimeNs },
    controller: { pid: record.controller.pid, start: record.controller.start,
      boot: record.controller.boot, build: record.controller.build },
    role: record.role,
    runtime: { node: record.runtime.node, pnpmTree: record.runtime.pnpmTree },
    phase: record.phase,
    child: record.child === null ? null : {
      pid: record.child.pid, start: record.child.start, pgid: record.child.pgid
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
      streams: record.facts.streams
    },
    ownedRoots: record.ownedRoots.map(root => ({
      path: root.path, device: root.device, inode: root.inode,
      birthtimeNs: root.birthtimeNs
    })),
    preparationDigest: record.preparationDigest,
    installation: [],
    backup: []
  } satisfies { readonly [Key in keyof AttemptRecord]: CanonicalJsonValue };
}

async function physicalDirectory(path: string): Promise<PhysicalRoot> {
  if (!cleanPath(path) || await realpath(path) !== path) {
    throw new Error("noncanonical-root");
  }
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("unsafe-root");
  }
  const filesystem = await statfs(path);
  if (![0xef53, 0x58465342, 0x9123683e, 0x794c7630, 0x01021994, 0x2fc12fc1].includes(filesystem.type)) {
    throw new Error("nonlocal-filesystem");
  }
  return { path, device: String(info.dev), inode: String(info.ino), birthtimeNs: String(info.birthtimeNs) };
}

async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}

async function controllerIdentity(build: string): Promise<AttemptRecord["controller"]> {
  const stat = await readFile("/proc/self/stat", "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (start === undefined || !/^\d+$/.test(start) || !/^[a-f0-9-]{36}$/.test(boot)) {
    throw new Error("controller-identity-unavailable");
  }
  return { pid: process.pid, start, boot, build };
}

function sameRecord(info: BigIntStats, identity: RecordIdentity, links: bigint): boolean {
  return info.isFile() && info.nlink === links && info.size <= BigInt(MAX_RECORD) &&
    String(info.dev) === identity.device && String(info.ino) === identity.inode &&
    String(info.birthtimeNs) === identity.birthtimeNs;
}

function unchangedFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink &&
    left.birthtimeNs === right.birthtimeNs && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Descriptor-first, bounded reads also reject a FIFO substituted before open. */
async function ownsRecord(path: string, identity: RecordIdentity, links: bigint, expected: Buffer | null): Promise<boolean> {
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
    return unchangedFile(before, after) && unchangedFile(before, named) &&
      (expected === null ? bytes.length === 0 : bytes.equals(expected));
  } finally {
    await fd.close();
  }
}

async function writeAll(fd: FileHandle, bytes: Buffer): Promise<void> {
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

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

class ManagedAttemptOwner implements ManagedRuntimeAttempt {
  private written: Buffer | null = null;
  private directory: string | null = null;
  private failed = false;
  private custodyLost = false;
  private descriptorClosed = false;
  private releaseRequested = false;
  private releasePromise: Promise<ManagedAttemptClose> | null = null;
  private transitionTail: Promise<void> = Promise.resolve();
  private terminalDebt: RuntimeDebt | null = null;
  readonly ["token"]: string;
  readonly evidencePath: string;
  private readonly releaseBarrier: string;

  constructor(private readonly fd: FileHandle, private readonly external: PhysicalRoot,
    private record: AttemptRecord, path: string) {
    this["token"] = record.token;
    this.evidencePath = path;
    this.releaseBarrier = `${path}.release-debt`;
  }

  get ownedRoot(): string {
    if (this.directory === null) {
      throw new Error("attempt-directory-unacquired");
    }
    return this.directory;
  }

  private debt(code: RuntimeDebt["code"], evidencePath = this.evidencePath): RuntimeDebt {
    return Object.freeze({ code, attemptId: this.token, evidencePath,
      facts: Object.freeze({ ...this.record.facts }) });
  }

  private async persist(next: AttemptRecord, path = this.evidencePath): Promise<void> {
    if (this.failed || this.descriptorClosed) {
      throw new Error("attempt-custody-uncertain");
    }
    try {
      if (!await ownsRecord(path, next.record, 1n, this.written)) {
        throw new Error("attempt-record-substituted");
      }
      const bytes = Buffer.from(`${canonicalJson(attemptRecordJson(next))}\n`);
      if (bytes.length > MAX_RECORD) {
        throw new Error("attempt-record-over-limit");
      }
      await writeAll(this.fd, bytes);
      this.record = next;
      this.written = bytes;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  async initialize(signal: AbortSignal): Promise<void> {
    await this.persist(this.record);
    await syncDirectory(this.external.path);
    if (signal.aborted || JSON.stringify(await physicalDirectory(this.external.path)) !== JSON.stringify(this.external)) {
      throw new Error("attempt-acquisition-interrupted");
    }
    this.directory = await mkdtemp(join(this.external.path, "managed-runtime-owned-"));
    const owned = await physicalDirectory(this.directory);
    await this.persist({ ...this.record, ownedRoots: [owned] });
    await syncDirectory(this.external.path);
  }

  async verifyOwnedRoot(): Promise<boolean> {
    if (this.failed || this.custodyLost || this.descriptorClosed) {
      return false;
    }
    try {
      const [external, consumer, owned] = await Promise.all([
        physicalDirectory(this.external.path), physicalDirectory(this.record.consumer.path),
        physicalDirectory(this.ownedRoot)
      ]);
      const valid = JSON.stringify(external) === JSON.stringify(this.external) &&
        JSON.stringify(consumer) === JSON.stringify(this.record.consumer) &&
        JSON.stringify(owned) === JSON.stringify(this.record.ownedRoots[0]) &&
        await absent(this.releaseBarrier) &&
        await ownsRecord(this.evidencePath, this.record.record, 1n, this.written);
      this.custodyLost ||= !valid;
      return valid;
    } catch {
      this.custodyLost = true;
      return false;
    }
  }

  transition(phase: Exclude<ManagedAttemptPhase, "acquired">, facts: ProcessFacts, child?: ChildIdentity): Promise<void> {
    if (this.releaseRequested || this.failed || this.custodyLost) {
      return Promise.reject(new Error("attempt-closed-or-uncertain"));
    }
    const next = this.transitionTail.then(() => {
      if (!permitsAttemptTransition(this.record.phase, phase)) {
        throw new Error("attempt-transition-invalid");
      }
      if (phase === "running" && (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0 ||
          child.pgid !== child.pid || !/^\d+$/.test(child.start))) {
        throw new Error("attempt-child-invalid");
      }
      return this.persist({ ...this.record, phase,
        child: phase === "spawning" ? null : child ?? this.record.child,
        facts: Object.freeze({ ...facts }) });
    });
    this.transitionTail = next.catch(() => {
      this.failed = true;
    });
    return next;
  }

  private async closeDescriptor(): Promise<void> {
    if (!this.descriptorClosed) {
      await this.fd.close();
      this.descriptorClosed = true;
    }
  }

  private async retain(code: RuntimeDebt["code"]): Promise<ManagedAttemptClose> {
    let evidencePath = this.evidencePath;
    const primary = await ownsRecord(this.evidencePath, this.record.record, 1n, this.written).catch(() => false);
    if (!primary && !await absent(this.releaseBarrier)) {
      evidencePath = this.releaseBarrier;
    }
    if (!this.failed && !this.descriptorClosed) {
      await this.persist({ ...this.record, phase: "debt" }, evidencePath).catch(() => null);
    }
    this.terminalDebt = this.debt(code, evidencePath);
    await this.closeDescriptor().catch(() => null);
    return { outcome: "debt", debt: this.terminalDebt };
  }

  private async verifyReleaseRecord(path: string, links: bigint): Promise<void> {
    const external = await physicalDirectory(this.external.path);
    if (JSON.stringify(external) !== JSON.stringify(this.external) ||
        !await ownsRecord(path, this.record.record, links, this.written)) {
      throw new Error("release-record-substituted");
    }
  }

  private async release(): Promise<ManagedAttemptClose> {
    if (!await this.verifyOwnedRoot()) {
      throw new Error("attempt-root-substituted");
    }
    await link(this.evidencePath, this.releaseBarrier);
    await this.verifyReleaseRecord(this.releaseBarrier, 2n);
    await syncDirectory(this.external.path);
    const owned = await physicalDirectory(this.ownedRoot);
    if (JSON.stringify(owned) !== JSON.stringify(this.record.ownedRoots[0])) {
      throw new Error("owned-root-substituted");
    }
    await this.verifyReleaseRecord(this.evidencePath, 2n);
    await rm(this.ownedRoot, { recursive: true });
    await this.verifyReleaseRecord(this.evidencePath, 2n);
    await unlink(this.evidencePath);
    await syncDirectory(this.external.path);
    await this.closeDescriptor();
    // The primary sync and descriptor close are awaits. Authenticate the late sibling again.
    await this.verifyReleaseRecord(this.releaseBarrier, 1n);
    try {
      await unlink(this.releaseBarrier);
    } catch (error) {
      if (!await absent(this.releaseBarrier)) {
        throw error;
      }
    }
    // Redundant-link removal is conservative garbage collection, not a reclamation lease.
    return { outcome: "closed" };
  }

  close(): Promise<ManagedAttemptClose> {
    if (this.releasePromise) {
      return this.releasePromise;
    }
    this.releaseRequested = true;
    this.releasePromise = (async () => {
      await this.transitionTail;
      if (this.failed || !permitsAttemptRelease(this.record.phase, this.record.facts, this.record.child !== null)) {
        return this.retain("liveness-uncertain");
      }
      try {
        return await this.release();
      } catch {
        return this.retain("cleanup-failed");
      }
    })();
    return this.releasePromise;
  }
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

async function acquisitionRoots(request: ManagedAttemptInput, image: RuntimeImage): Promise<{
  external: PhysicalRoot; consumer: PhysicalRoot
}> {
  const [external, consumer] = await Promise.all([
    physicalDirectory(request.externalRoot), physicalDirectory(request.consumerRoot)
  ]);
  const forbidden = [image.rootPath, dirname(image.nodePath), dirname(process.execPath),
    resolve(fileURLToPath(new URL("../../../", import.meta.url)))];
  if (overlaps(external.path, consumer.path) || forbidden.some(root => overlaps(external.path, root))) {
    throw new Error("overlapping-roots");
  }
  return { external, consumer };
}

async function discardProvisional(fd: FileHandle, path: string, external: PhysicalRoot): Promise<boolean> {
  let settled = false;
  try {
    const created = await fd.stat({ bigint: true });
    const identity = { device: String(created.dev), inode: String(created.ino), birthtimeNs: String(created.birthtimeNs) };
    if (JSON.stringify(await physicalDirectory(external.path)) === JSON.stringify(external) &&
        await ownsRecord(path, identity, 1n, null)) {
      await unlink(path);
      await syncDirectory(external.path);
      settled = JSON.stringify(await physicalDirectory(external.path)) === JSON.stringify(external) &&
        await absent(path);
    }
  } catch {
    settled = false;
  } finally {
    try {
      await fd.close();
    } catch {
      settled = false;
    }
  }
  return settled;
}

function validatedAttemptInput(input: ManagedAttemptInput,
  runtime: ManagedRuntimeHandle): ManagedAttemptInput | null {
  const request = snapshotAttemptInput(input);
  if (!request || request.runtime !== runtime || !cleanPath(request.externalRoot) ||
      !cleanPath(request.consumerRoot) || !digest(request.controllerBuildDigest) ||
      request.preparationDigest !== undefined && !digest(request.preparationDigest)) {
    return null;
  }
  return request;
}

/** Existing records and release siblings are refusal barriers, never restart leases. */
export async function acquireManagedRuntimeAttempt(input: ManagedAttemptInput, admitted: {
  readonly runtime: ManagedRuntimeHandle; readonly image: RuntimeImage
}): Promise<AttemptAcquisition> {
  const request = validatedAttemptInput(input, admitted.runtime);
  if (!request) {
    return { outcome: "refused", code: "invalid-selection", debt: null };
  }
  // AbortSignal remains mutable across awaits; each check reads its current state.
  const requestAborted = (): boolean => request.signal.aborted;
  if (requestAborted()) {
    return { outcome: "refused", code: "cancelled", debt: null };
  }
  let roots: Awaited<ReturnType<typeof acquisitionRoots>>;
  let controller: AttemptRecord["controller"];
  try {
    roots = await acquisitionRoots(request, admitted.image);
    controller = await controllerIdentity(request.controllerBuildDigest);
  } catch {
    return { outcome: "refused", code: "invalid-selection", debt: null };
  }
  if (requestAborted()) {
    return { outcome: "refused", code: "cancelled", debt: null };
  }
  // Host supplies the common namespace; spelling changes do not change a physical consumer's key.
  const path = join(roots.external.path,
    `managed-runtime-${hash(`${roots.consumer.device}:${roots.consumer.inode}`)}.json`);
  const attemptNonce: string = randomBytes(32).toString("hex");
  let fd: FileHandle;
  try {
    fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    return { outcome: "refused", code: "liveness-uncertain", debt: null };
  }
  const debt = (code: RuntimeDebt["code"] = "liveness-uncertain"): RuntimeDebt =>
    Object.freeze({ code, attemptId: attemptNonce, evidencePath: path, facts: empty });
  try {
    if (!await absent(`${path}.release-debt`)) {
      const settled = await discardProvisional(fd, path, roots.external);
      return { outcome: "refused", code: settled ? "liveness-uncertain" : "cleanup-failed",
        debt: settled ? null : debt("cleanup-failed") };
    }
    const identity = await fd.stat({ bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n) {
      throw new Error("unsafe-attempt-record");
    }
    const record: AttemptRecord = { format: FORMAT, ["token"]: attemptNonce,
      record: { device: String(identity.dev), inode: String(identity.ino), birthtimeNs: String(identity.birthtimeNs) },
      consumer: roots.consumer, controller, role: request.role,
      runtime: { node: admitted.image.node.sha256, pnpmTree: admitted.image.treeDigest },
      phase: "acquired", child: null, facts: empty, ownedRoots: [],
      preparationDigest: request.preparationDigest ?? null, installation: [], backup: [] };
    const attempt = new ManagedAttemptOwner(fd, roots.external, record, path);
    await attempt.initialize(request.signal);
    if (requestAborted()) {
      const closed = await attempt.close();
      return { outcome: "refused", code: closed.outcome === "closed" ? "cancelled" : "cleanup-failed",
        debt: closed.outcome === "closed" ? null : closed.debt };
    }
    return { outcome: "acquired", attempt };
  } catch {
    await fd.sync().catch(() => null);
    await syncDirectory(roots.external.path).catch(() => null);
    await fd.close().catch(() => null);
    return { outcome: "refused", code: requestAborted() ? "cancelled" : "liveness-uncertain", debt: debt() };
  }
}
