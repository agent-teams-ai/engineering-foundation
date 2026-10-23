import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdtemp, open, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@agent-teams/repository-mutation/serialization";
import {
  permitsAttemptRelease,
  permitsAttemptTransition,
  snapshotAttemptInput,
  type ManagedAttemptPhase,
} from "../application/managed-runtime-policy.js";
import {
  type AttemptAcquisition,
  type ManagedAttemptClose,
  type ManagedAttemptInput,
  type ManagedRuntimeHandle,
  type ProcessFacts,
  type RuntimeDebt,
} from "../application/ports/managed-runtime.js";
import { type RuntimeImage } from "./node-managed-runtime-identity.js";
import {
  FORMAT,
  MAX_RECORD,
  empty,
  cleanPath,
  digest,
  hash,
  type FileHandle,
  type PhysicalRoot,
  type ChildIdentity,
  type AttemptRecord,
  type ManagedRuntimeAttempt,
  attemptRecordJson,
  physicalDirectory,
  syncDirectory,
  controllerIdentity,
  ownsRecord,
  writeAll,
  absent,
} from "./managed-attempt-support.js";
export type { ManagedRuntimeAttempt } from "./managed-attempt-support.js";
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

  constructor(
    private readonly fd: FileHandle,
    private readonly external: PhysicalRoot,
    private record: AttemptRecord,
    path: string,
  ) {
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
    return Object.freeze({
      code,
      attemptId: this.token,
      evidencePath,
      facts: Object.freeze({ ...this.record.facts }),
    });
  }

  private async persist(next: AttemptRecord, path = this.evidencePath): Promise<void> {
    if (this.failed || this.descriptorClosed) {
      throw new Error("attempt-custody-uncertain");
    }
    try {
      if (!(await ownsRecord(path, next.record, 1n, this.written))) {
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
    if (
      signal.aborted ||
      JSON.stringify(await physicalDirectory(this.external.path)) !== JSON.stringify(this.external)
    ) {
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
        physicalDirectory(this.external.path),
        physicalDirectory(this.record.consumer.path),
        physicalDirectory(this.ownedRoot),
      ]);
      const valid =
        JSON.stringify(external) === JSON.stringify(this.external) &&
        JSON.stringify(consumer) === JSON.stringify(this.record.consumer) &&
        JSON.stringify(owned) === JSON.stringify(this.record.ownedRoots[0]) &&
        (await absent(this.releaseBarrier)) &&
        (await ownsRecord(this.evidencePath, this.record.record, 1n, this.written));
      this.custodyLost ||= !valid;
      return valid;
    } catch {
      this.custodyLost = true;
      return false;
    }
  }

  transition(
    phase: Exclude<ManagedAttemptPhase, "acquired">,
    facts: ProcessFacts,
    child?: ChildIdentity,
  ): Promise<void> {
    if (this.releaseRequested || this.failed || this.custodyLost) {
      return Promise.reject(new Error("attempt-closed-or-uncertain"));
    }
    const next = this.transitionTail.then(() => {
      if (!permitsAttemptTransition(this.record.phase, phase)) {
        throw new Error("attempt-transition-invalid");
      }
      if (
        phase === "running" &&
        (!child ||
          !Number.isSafeInteger(child.pid) ||
          child.pid <= 0 ||
          child.pgid !== child.pid ||
          !/^\d+$/.test(child.start))
      ) {
        throw new Error("attempt-child-invalid");
      }
      return this.persist({
        ...this.record,
        phase,
        child: phase === "spawning" ? null : (child ?? this.record.child),
        facts: Object.freeze({ ...facts }),
      });
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
    const primary = await ownsRecord(this.evidencePath, this.record.record, 1n, this.written).catch(
      () => false,
    );
    if (!primary && !(await absent(this.releaseBarrier))) {
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
    if (
      JSON.stringify(external) !== JSON.stringify(this.external) ||
      !(await ownsRecord(path, this.record.record, links, this.written))
    ) {
      throw new Error("release-record-substituted");
    }
  }

  private async release(): Promise<ManagedAttemptClose> {
    if (!(await this.verifyOwnedRoot())) {
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
      if (!(await absent(this.releaseBarrier))) {
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
      if (
        this.failed ||
        !permitsAttemptRelease(this.record.phase, this.record.facts, this.record.child !== null)
      ) {
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

async function acquisitionRoots(
  request: ManagedAttemptInput,
  image: RuntimeImage,
): Promise<{
  external: PhysicalRoot;
  consumer: PhysicalRoot;
}> {
  const [external, consumer] = await Promise.all([
    physicalDirectory(request.externalRoot),
    physicalDirectory(request.consumerRoot),
  ]);
  const forbidden = [
    image.rootPath,
    dirname(image.nodePath),
    dirname(process.execPath),
    resolve(fileURLToPath(new URL("../../../", import.meta.url))),
  ];
  if (
    overlaps(external.path, consumer.path) ||
    forbidden.some((root) => overlaps(external.path, root))
  ) {
    throw new Error("overlapping-roots");
  }
  return { external, consumer };
}

async function discardProvisional(
  fd: FileHandle,
  path: string,
  external: PhysicalRoot,
): Promise<boolean> {
  let settled = false;
  try {
    const created = await fd.stat({ bigint: true });
    const identity = {
      device: String(created.dev),
      inode: String(created.ino),
      birthtimeNs: String(created.birthtimeNs),
    };
    if (
      JSON.stringify(await physicalDirectory(external.path)) === JSON.stringify(external) &&
      (await ownsRecord(path, identity, 1n, null))
    ) {
      await unlink(path);
      await syncDirectory(external.path);
      settled =
        JSON.stringify(await physicalDirectory(external.path)) === JSON.stringify(external) &&
        (await absent(path));
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

function validatedAttemptInput(
  input: ManagedAttemptInput,
  runtime: ManagedRuntimeHandle,
): ManagedAttemptInput | null {
  const request = snapshotAttemptInput(input);
  if (
    !request ||
    request.runtime !== runtime ||
    !cleanPath(request.externalRoot) ||
    !cleanPath(request.consumerRoot) ||
    !digest(request.controllerBuildDigest) ||
    (request.preparationDigest !== undefined && !digest(request.preparationDigest))
  ) {
    return null;
  }
  return request;
}

/** Existing records and release siblings are refusal barriers, never restart leases. */
export async function acquireManagedRuntimeAttempt(
  input: ManagedAttemptInput,
  admitted: {
    readonly runtime: ManagedRuntimeHandle;
    readonly image: RuntimeImage;
  },
): Promise<AttemptAcquisition> {
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
  const path = join(
    roots.external.path,
    `managed-runtime-${hash(`${roots.consumer.device}:${roots.consumer.inode}`)}.json`,
  );
  const attemptNonce: string = randomBytes(32).toString("hex");
  let fd: FileHandle;
  try {
    fd = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return { outcome: "refused", code: "liveness-uncertain", debt: null };
  }
  const debt = (code: RuntimeDebt["code"] = "liveness-uncertain"): RuntimeDebt =>
    Object.freeze({ code, attemptId: attemptNonce, evidencePath: path, facts: empty });
  try {
    if (!(await absent(`${path}.release-debt`))) {
      const settled = await discardProvisional(fd, path, roots.external);
      return {
        outcome: "refused",
        code: settled ? "liveness-uncertain" : "cleanup-failed",
        debt: settled ? null : debt("cleanup-failed"),
      };
    }
    const identity = await fd.stat({ bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n) {
      throw new Error("unsafe-attempt-record");
    }
    const record: AttemptRecord = {
      format: FORMAT,
      ["token"]: attemptNonce,
      record: {
        device: String(identity.dev),
        inode: String(identity.ino),
        birthtimeNs: String(identity.birthtimeNs),
      },
      consumer: roots.consumer,
      controller,
      role: request.role,
      runtime: { node: admitted.image.node.sha256, pnpmTree: admitted.image.treeDigest },
      phase: "acquired",
      child: null,
      facts: empty,
      ownedRoots: [],
      preparationDigest: request.preparationDigest ?? null,
      installation: [],
      backup: [],
    };
    const attempt = new ManagedAttemptOwner(fd, roots.external, record, path);
    await attempt.initialize(request.signal);
    if (requestAborted()) {
      const closed = await attempt.close();
      return {
        outcome: "refused",
        code: closed.outcome === "closed" ? "cancelled" : "cleanup-failed",
        debt: closed.outcome === "closed" ? null : closed.debt,
      };
    }
    return { outcome: "acquired", attempt };
  } catch {
    await fd.sync().catch(() => null);
    await syncDirectory(roots.external.path).catch(() => null);
    await fd.close().catch(() => null);
    return {
      outcome: "refused",
      code: requestAborted() ? "cancelled" : "liveness-uncertain",
      debt: debt(),
    };
  }
}
