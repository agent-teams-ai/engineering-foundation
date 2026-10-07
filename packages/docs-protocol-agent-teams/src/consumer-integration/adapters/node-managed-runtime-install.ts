import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";
import { parseDocument } from "yaml";
import { hasNoManagedChild, hasSettledManagedChild, permitsDisposableProject } from "../application/managed-runtime-policy.js";
import { sameRuntimeTuple } from "../application/policies/managed-runtime-observation.js";
import type { ManagedPnpmInstallInput, ManagedPnpmInstallResult, ProcessFacts,
  RuntimeDebt, RuntimeObservation, RuntimeRefusalCode } from "../application/ports/managed-runtime.js";
import type { ManagedRuntimeAttempt } from "./node-managed-runtime-attempt.js";
import { hashRuntimeFile, observeRuntimeImage, type RuntimeImage,
  type TrustedRuntimeSelection } from "./node-managed-runtime-identity.js";
import { runManagedProbe } from "./node-managed-runtime-process.js";
import { verifyLeafArchive } from "./node-managed-runtime-archive.js";

const empty: ProcessFacts = { spawned: false, exitCode: null, signal: null, cancelled: false,
  timedOut: false, stdoutBytes: 0, stderrBytes: 0, directChild: "not-started",
  group: "not-started", streams: "not-started" };
const uncertain: ProcessFacts = { ...empty, directChild: "unconfirmed", group: "unconfirmed", streams: "unconfirmed" };
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value);
type RefusedInstall = Extract<ManagedPnpmInstallResult, { outcome: "refused" }>;
interface DirectoryBinding {
  readonly device: bigint;
  readonly inode: bigint;
  readonly birthtimeNs: bigint;
}
interface InstallationOwner {
  readonly selection: TrustedRuntimeSelection;
  readonly image: RuntimeImage;
  readonly attempt: ManagedRuntimeAttempt;
}

function refused(code: RuntimeRefusalCode, facts: ProcessFacts = empty,
  debt: RuntimeDebt | null = null): RefusedInstall {
  return { outcome: "refused", code, facts, debt };
}

/** Preserve runtime mode validation for callers outside TypeScript. */
function validInstallMode(value: unknown): boolean {
  return value === "prepare" || value === "frozen-offline";
}

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function bindDirectory(path: string): Promise<DirectoryBinding> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || await realpath(path) !== path) {
    throw new Error("installation-directory-substituted");
  }
  return { device: info.dev, inode: info.ino, birthtimeNs: info.birthtimeNs };
}

function sameDirectory(left: DirectoryBinding, right: DirectoryBinding): boolean {
  return left.device === right.device && left.inode === right.inode && left.birthtimeNs === right.birthtimeNs;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink &&
    left.birthtimeNs === right.birthtimeNs && left.size === right.size &&
    left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs;
}

async function boundedBytes(path: string, maximum = 16 * 1024 * 1024): Promise<Buffer> {
  if (await realpath(path) !== path) {
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
    if (!sameFile(before, await fd.stat({ bigint: true })) ||
        !sameFile(before, await lstat(path, { bigint: true }))) {
      throw new Error("installation-file-changed");
    }
    return bytes;
  } finally {
    await fd.close();
  }
}

function yamlValue(bytes: Buffer): unknown {
  const document = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { uniqueKeys: true });
  if (document.errors.length !== 0) {
    throw new Error("invalid-installation-yaml");
  }
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const fileDigest = async (path: string): Promise<string> =>
  (await hashRuntimeFile(path, 16 * 1024 * 1024, false)).sha256;

async function tarballIntegrity(path: string): Promise<string> {
  if (await realpath(path) !== path) {
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
      const read = await fd.read(chunk, 0, Math.min(chunk.length, Number(before.size) - offset), offset);
      if (read.bytesRead === 0) {
        throw new Error("local-tarball-short-read");
      }
      hash.update(chunk.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    if (!sameFile(before, await fd.stat({ bigint: true })) ||
        !sameFile(before, await lstat(path, { bigint: true }))) {
      throw new Error("local-tarball-changed");
    }
    return `sha512-${hash.digest("base64")}`;
  } finally {
    await fd.close();
  }
}

async function verifyDirectTarballs(root: string, project: unknown): Promise<void> {
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
    expanded += await verifyLeafArchive(packed,
      Math.min(64 * 1024 * 1024, 128 * 1024 * 1024 - expanded), name);
  }
}

async function verifyTarball(root: string, value: unknown): Promise<void> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid-lock-resolution");
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.tarball !== "string" || !entry.tarball.startsWith("file:") ||
      typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) {
    throw new Error("nonlocal-lock-resolution");
  }
  const relative = entry.tarball.slice(5);
  const path = resolve(root, relative);
  if (!relative || isAbsolute(relative) || relative.includes("\0") ||
      relative.split(/[\\/]/).includes("..") || !path.startsWith(`${root}${sep}`) ||
      await tarballIntegrity(path) !== entry.integrity) {
    throw new Error("local-tarball-integrity");
  }
}

async function verifyLocalTarballs(root: string): Promise<void> {
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

function observation(owner: InstallationOwner): RuntimeObservation {
  const { selection, image } = owner;
  return { kind: "managed-runtime-observation", tuple: { ...selection.expected }, node: { ...image.node },
    pnpm: { manifest: { ...image.manifest }, entry: { ...image.entry }, packageTreeDigest: image.treeDigest },
    launcher: { kind: "direct-node" }, containment: "cooperative-posix-process-group" };
}

/** One attempt's installation custody; the issuing runtime scope authenticates both handles. */
export class ManagedPnpmInstallation {
  private installed = false;
  private store: DirectoryBinding | null = null;
  private modules: DirectoryBinding | null = null;
  private facts: ProcessFacts = empty;
  private uncertainProcess = false;

  constructor(private readonly owner: InstallationOwner) {}

  private hasUncertainProcess(): boolean {
    return this.uncertainProcess;
  }

  private debt(): RuntimeDebt {
    return Object.freeze({ code: "liveness-uncertain", attemptId: this.owner.attempt.token,
      evidencePath: this.owner.attempt.evidencePath, facts: Object.freeze({ ...this.facts }) });
  }

  private async verifyDirectories(root: string): Promise<RuntimeRefusalCode | null> {
    const storePath = join(root, ".managed-pnpm-store");
    if (!await absent(storePath)) {
      if (this.store === null) {
        return "invalid-selection";
      }
      if (!sameDirectory(await bindDirectory(storePath), this.store)) {
        return "identity-changed";
      }
    }
    const modulesPath = join(root, "node_modules");
    if (!await absent(modulesPath)) {
      if (!this.installed || this.modules === null) {
        return "invalid-selection";
      }
      if (!sameDirectory(await bindDirectory(modulesPath), this.modules)) {
        return "identity-changed";
      }
      await bindDirectory(join(modulesPath, ".pnpm"));
    }
    return null;
  }

  private async preflight(input: ManagedPnpmInstallInput): Promise<RuntimeRefusalCode | null> {
    const root = this.owner.attempt.ownedRoot;
    if (!await this.owner.attempt.verifyOwnedRoot()) {
      return "identity-changed";
    }
    for (const name of [".npmrc", "user.npmrc", "global.npmrc", ".pnpmfile.cjs", "pnpmfile.cjs", ".pnpmfile.mjs"]) {
      if (!await absent(join(root, name))) {
        return "invalid-selection";
      }
    }
    if (input.mode === "prepare" && !await absent(join(root, "pnpm-lock.yaml"))) {
      return "invalid-selection";
    }
    const directories = await this.verifyDirectories(root);
    if (directories) {
      return directories;
    }
    const manifest = await boundedBytes(join(root, "package.json"));
    const workspace = await boundedBytes(join(root, "pnpm-workspace.yaml"));
    if (sha256(manifest) !== input.expectedManifestDigest || sha256(workspace) !== input.expectedWorkspaceDigest) {
      return "identity-changed";
    }
    const project: unknown = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(manifest));
    if (!permitsDisposableProject(project, yamlValue(workspace))) {
      return "invalid-selection";
    }
    if (input.mode === "frozen-offline") {
      const locked = await this.preflightLock(input);
      if (locked) {
        return locked;
      }
    }
    try {
      await verifyDirectTarballs(root, project);
    } catch {
      return "invalid-selection";
    }
    return null;
  }

  private async preflightLock(input: ManagedPnpmInstallInput): Promise<RuntimeRefusalCode | null> {
    const root = this.owner.attempt.ownedRoot;
    const virtual = join(root, "node_modules/.pnpm/lock.yaml");
    if (await fileDigest(join(root, "pnpm-lock.yaml")) !== input.expectedLockDigest ||
        !await absent(virtual) && await fileDigest(virtual) !== input.expectedLockDigest) {
      return "identity-changed";
    }
    await verifyLocalTarballs(root);
    return null;
  }

  private async captureStore(): Promise<void> {
    const path = join(this.owner.attempt.ownedRoot, ".managed-pnpm-store");
    if (!await absent(path)) {
      const current = await bindDirectory(path);
      if (this.store !== null && !sameDirectory(current, this.store)) {
        throw new Error("installation-store-substituted");
      }
      this.store = current;
    }
  }

  private async stage(input: ManagedPnpmInstallInput,
    kind: "pnpm-install-prepare" | "pnpm-install-frozen-offline" | "pnpm-peers-check"): Promise<RefusedInstall | null> {
    const { attempt, image, selection } = this.owner;
    await observeRuntimeImage(selection, image);
    let reserved = false;
    const wasReserved = (): boolean => reserved;
    const result = await runManagedProbe({ image, expected: selection.expected,
      cwd: attempt.ownedRoot, kind, signal: input.signal, lifecycle: {
        spawning: async () => {
          reserved = true;
          this.uncertainProcess = true;
          this.facts = uncertain;
          await attempt.transition("spawning", empty);
        },
        running: async child => {
          await attempt.transition("running", { ...uncertain, spawned: true }, child);
        },
        stopping: async () => {
          await attempt.transition("stopping", { ...uncertain, spawned: true });
        }
      } });
    this.facts = result.facts;
    const noChild = hasNoManagedChild(this.facts);
    const clean = noChild || hasSettledManagedChild(this.facts);
    if (wasReserved()) {
      if (noChild) {
        await attempt.transition("stopping", this.facts);
      }
      await attempt.transition(clean ? "terminated" : "debt", this.facts);
    }
    this.uncertainProcess = !clean;
    if (!clean) {
      return refused(result.code ?? "liveness-uncertain", this.facts, this.debt());
    }
    await this.captureStore();
    if (result.code) {
      return { ...refused(result.code, this.facts),
        ...(result.diagnosticTailBase64 === undefined ? {} : { diagnosticTailBase64: result.diagnosticTailBase64 }) };
    }
    if (noChild || !result.handshake || !sameRuntimeTuple(result.handshake, selection.expected)) {
      return refused("runtime-mismatch", this.facts);
    }
    return input.signal.aborted ? refused("cancelled", { ...this.facts, cancelled: true }) : null;
  }

  private async finish(input: ManagedPnpmInstallInput): Promise<ManagedPnpmInstallResult> {
    const { attempt, image, selection } = this.owner;
    const root = attempt.ownedRoot;
    await observeRuntimeImage(selection, image);
    if (!await attempt.verifyOwnedRoot() ||
        await fileDigest(join(root, "package.json")) !== input.expectedManifestDigest ||
        await fileDigest(join(root, "pnpm-workspace.yaml")) !== input.expectedWorkspaceDigest) {
      return refused("identity-changed", this.facts);
    }
    const modules = await bindDirectory(join(root, "node_modules"));
    await bindDirectory(join(root, "node_modules/.pnpm"));
    const lockDigest = await fileDigest(join(root, "pnpm-lock.yaml"));
    const virtualStoreLockDigest = await fileDigest(join(root, "node_modules/.pnpm/lock.yaml"));
    if (lockDigest !== virtualStoreLockDigest ||
        input.mode === "frozen-offline" && lockDigest !== input.expectedLockDigest) {
      return refused("identity-changed", this.facts);
    }
    await verifyLocalTarballs(root);
    if (input.signal.aborted) {
      return refused("cancelled", { ...this.facts, cancelled: true });
    }
    this.modules = modules;
    this.installed = true;
    return { outcome: "installed", facts: this.facts, runtime: observation(this.owner),
      lockDigest, virtualStoreLockDigest };
  }

  async install(input: ManagedPnpmInstallInput): Promise<ManagedPnpmInstallResult> {
    if (!hex(input.expectedManifestDigest) || !hex(input.expectedWorkspaceDigest) ||
        (input.mode === "prepare" ? input.expectedLockDigest !== null : !hex(input.expectedLockDigest)) ||
        !validInstallMode(input.mode)) {
      return refused("invalid-selection");
    }
    if (this.hasUncertainProcess()) {
      return refused("liveness-uncertain", this.facts, this.debt());
    }
    this.facts = empty;
    if (input.signal.aborted) {
      return refused("cancelled", { ...empty, cancelled: true });
    }
    // The process adapter replaces the child environment; the fixed probe enforces install flags.
    // Preflight still refuses effective project configuration and executable hooks.
    try {
      const rejected = await this.preflight(input);
      if (rejected) {
        return refused(rejected);
      }
      const installed = await this.stage(input,
        input.mode === "prepare" ? "pnpm-install-prepare" : "pnpm-install-frozen-offline");
      if (installed) {
        return installed;
      }
      if (input.mode === "frozen-offline") {
        const peers = await this.stage(input, "pnpm-peers-check");
        if (peers) {
          return peers;
        }
      }
      return await this.finish(input);
    } catch {
      const unconfirmed = this.hasUncertainProcess();
      return refused(unconfirmed ? "liveness-uncertain" : "identity-changed",
        this.facts, unconfirmed ? this.debt() : null);
    }
  }
}
