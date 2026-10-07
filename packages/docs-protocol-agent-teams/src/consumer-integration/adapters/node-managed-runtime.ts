import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { sameRuntimeTuple } from "../application/policies/managed-runtime-observation.js";
import type { AttemptAcquisition, ManagedAttemptClose, ManagedAttemptInput,
  ManagedPnpmInstallInput, ManagedPnpmInstallResult, OwnedInstallationRoot,
  ManagedRuntimeHandle, ManagedRuntimeObservationPort, ProcessFacts,
  RuntimeDebt, RuntimeObservationResult, RuntimeRefusalCode, RuntimeTuple } from "../application/ports/managed-runtime.js";
import { snapshotAttemptInput, snapshotInstallInput } from "../application/managed-runtime-policy.js";
import { acquireManagedRuntimeAttempt, type ManagedRuntimeAttempt } from "./node-managed-runtime-attempt.js";
import { ManagedPnpmInstallation } from "./node-managed-runtime-install.js";
import { observeRuntimeImage, validateSelection, type RuntimeImage, type TrustedRuntimeSelection } from "./node-managed-runtime-identity.js";
import { runManagedProbe, type ProcessResult } from "./node-managed-runtime-process.js";

export interface ManagedRuntimeScopeInput {
  readonly privateRoot: string;
  readonly selection: TrustedRuntimeSelection;
  readonly signal: AbortSignal;
}
type RuntimeAdmission =
  | { readonly outcome: "admitted"; readonly runtime: ManagedRuntimeHandle }
  | { readonly outcome: "refused"; readonly code: RuntimeRefusalCode; readonly debt: RuntimeDebt | null };
type RuntimeScopeClose = { readonly outcome: "closed" } | { readonly outcome: "debt"; readonly debt: RuntimeDebt };
export interface NodeManagedRuntimeScope extends ManagedRuntimeObservationPort {
  admit(): Promise<RuntimeAdmission>;
  acquireAttempt(input: ManagedAttemptInput): Promise<AttemptAcquisition>;
  ownedInstallationRoot(): OwnedInstallationRoot | null;
  install(input: ManagedPnpmInstallInput): Promise<ManagedPnpmInstallResult>;
  close(): Promise<RuntimeScopeClose>;
}
const emptyFacts: ProcessFacts = { spawned: false, exitCode: null, signal: null, cancelled: false,
  timedOut: false, stdoutBytes: 0, stderrBytes: 0, directChild: "not-started",
  group: "not-started", streams: "not-started" };
const uncertainFacts: ProcessFacts = { ...emptyFacts, directChild: "unconfirmed",
  group: "unconfirmed", streams: "unconfirmed" };
const liveDebt = (code: RuntimeDebt["code"], attemptId: string,
  facts: ProcessFacts): RuntimeDebt => Object.freeze({ code, attemptId, evidencePath: null,
    facts: Object.freeze({ ...facts }) });
const refusal = (code: RuntimeRefusalCode, facts: ProcessFacts, debt: RuntimeDebt | null = null): Extract<RuntimeObservationResult, { outcome: "refused" }> =>
  ({ outcome: "refused", code, facts, debt });
async function validPrivateRoot(root: string, image: RuntimeImage): Promise<boolean> {
  try {
    const canonical = await realpath(root);
    const stat = await lstat(root);
    const nodeBin = dirname(image.nodePath);
    return canonical === root && stat.isDirectory() &&
      root !== image.rootPath && !root.startsWith(`${image.rootPath}${sep}`) &&
      root !== nodeBin && !root.startsWith(`${nodeBin}${sep}`);
  } catch { return false; }
}
interface OwnedDirectory {
  readonly path: string;
  readonly parent: string;
  readonly parentDevice: bigint;
  readonly parentInode: bigint;
  readonly device: bigint;
  readonly inode: bigint;
}
async function bindOwnedDirectory(path: string): Promise<OwnedDirectory> {
  const parent = dirname(path);
  const [parentStat, directoryStat, parentReal, directoryReal] = await Promise.all([
    lstat(parent, { bigint: true }), lstat(path, { bigint: true }), realpath(parent), realpath(path)
  ]);
  if (!parentStat.isDirectory() || !directoryStat.isDirectory() ||
      parentReal !== parent || directoryReal !== path) {throw new Error("owned-root-retargeted");}
  return { path, parent, parentDevice: parentStat.dev, parentInode: parentStat.ino,
    device: directoryStat.dev, inode: directoryStat.ino };
}
async function removeOwnedDirectory(owned: OwnedDirectory): Promise<boolean> {
  try {
    const current = await bindOwnedDirectory(owned.path);
    if (!sameOwnedDirectory(current, owned)) {return false;}
    await rm(owned.path, { recursive: true });
    return true;
  } catch { return false; }
}
function sameOwnedDirectory(current: OwnedDirectory, owned: OwnedDirectory): boolean {
  return current.parent === owned.parent && current.parentDevice === owned.parentDevice &&
    current.parentInode === owned.parentInode && current.device === owned.device &&
    current.inode === owned.inode;
}
async function validOwnedDirectory(path: string, owned: OwnedDirectory | null): Promise<boolean> {
  return owned !== null && await bindOwnedDirectory(path).then((current) =>
    sameOwnedDirectory(current, owned), () => false);
}
async function acquireOwnedDirectory(root: string): Promise<{ path: string | null; binding: OwnedDirectory | null }> {
  let parent: OwnedDirectory;
  try { parent = await bindOwnedDirectory(root); }
  catch {return { path: null, binding: null };}
  let path: string | null = null;
  try {
    path = await mkdtemp(join(root, "managed-runtime-"));
    const binding = await bindOwnedDirectory(path);
    if (binding.parentDevice !== parent.device || binding.parentInode !== parent.inode) {
      return { path, binding: null };
    }
    return { path, binding };
  } catch {return { path, binding: null };}
}
function observationFields(value: unknown): { runtime: ManagedRuntimeHandle;
  expected: RuntimeTuple; signal: AbortSignal } | null {
  try {
    if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype ||
        Reflect.ownKeys(value).length !== 3) {return null;}
    const runtime = Object.getOwnPropertyDescriptor(value, "runtime");
    const expected = Object.getOwnPropertyDescriptor(value, "expected");
    const signal = Object.getOwnPropertyDescriptor(value, "signal");
    if (!runtime || !expected || !signal || !Object.hasOwn(runtime, "value") ||
        !Object.hasOwn(expected, "value") || !Object.hasOwn(signal, "value") ||
        runtime.value === null || typeof runtime.value !== "object" ||
        !(signal.value instanceof AbortSignal)) {return null;}
    const expectedValue: unknown = expected.value;
    return { runtime: runtime.value as ManagedRuntimeHandle,
      expected: expectedValue as RuntimeTuple, signal: signal.value };
  } catch { return null; }
}

function scopeFields(input: ManagedRuntimeScopeInput) {
    try {
      if (Object.getPrototypeOf(input) !== Object.prototype ||
          Reflect.ownKeys(input).length !== 3) {return null;}
      const root = Object.getOwnPropertyDescriptor(input, "privateRoot");
      const selected = Object.getOwnPropertyDescriptor(input, "selection");
      const signal = Object.getOwnPropertyDescriptor(input, "signal");
      if (!root || !selected || !signal || !Object.hasOwn(root, "value") ||
          !Object.hasOwn(selected, "value") || !Object.hasOwn(signal, "value") ||
          !(signal.value instanceof AbortSignal)) {return null;}
      return { root: root.value as unknown, selection: selected.value as unknown,
        signal: signal.value };
    } catch { return null; }
}

function chooseRuntime(supplied: ReturnType<typeof scopeFields>, root: string | null): {
  code: RuntimeRefusalCode | null; selection: TrustedRuntimeSelection | null } {
  let selection: TrustedRuntimeSelection | null = null;
    if (!supplied) {return { code: "invalid-selection", selection };}
    try {
      const launcher = Object.getOwnPropertyDescriptor(supplied.selection, "launcher");
      if (launcher && Object.hasOwn(launcher, "value") && launcher.value === "corepack") {
        return { code: "unsupported-launcher", selection };
      }
    } catch { return { code: "invalid-selection", selection }; }
    selection = validateSelection(supplied.selection);
    if (!selection || typeof root !== "string" || resolvePath(root) !== root || root.includes("\0")) {
      return { code: "invalid-selection", selection };
    }
    if (process.platform !== "linux" || process.arch !== "x64" ||
        selection.expected.platform !== "linux" || selection.expected.architecture !== "x64") {return { code: "unsupported-platform", selection };}
    return { code: null, selection };
}

function probeRefusal(result: ProcessResult, expected: RuntimeTuple, ownedRoot: string): Extract<RuntimeObservationResult, { outcome: "refused" }> | null {
        if (!result.facts.spawned && result.facts.group === "not-started" &&
            result.facts.directChild === "not-started") {
          return refusal(result.code ?? "spawn-failed", result.facts);
        }
        if (result.facts.group !== "empty-observed" || result.facts.streams !== "closed" ||
            result.facts.directChild !== "reaped") {
          const debt = liveDebt("liveness-uncertain", ownedRoot, result.facts);
          return refusal(result.code ?? "liveness-uncertain", result.facts, debt);
        }
        if (result.code) {return refusal(result.code, result.facts);}
        let output: string;
        try { output = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(result.output, "utf8")); }
        catch { return refusal("invalid-output", result.facts); }
        if (output !== `${expected.pnpmVersion}\n` || !result.handshake ||
            !sameRuntimeTuple(result.handshake, expected)) {return refusal("runtime-mismatch", result.facts);}
  return null;
}

function ownsRuntime(runtime: ManagedRuntimeHandle, image: RuntimeImage | null,
  handles: WeakMap<ManagedRuntimeHandle, RuntimeImage>): boolean {
  return image !== null && handles.has(runtime) && handles.get(runtime) === image;
}

type ObservationRequest = Parameters<ManagedRuntimeObservationPort["observe"]>[0];

/** One factory's private authority and lifecycle; no owner instance is exposed. */
class ManagedRuntimeScopeOwner implements NodeManagedRuntimeScope {
  private readonly supplied: ReturnType<typeof scopeFields>;
  private readonly handles = new WeakMap<ManagedRuntimeHandle, RuntimeImage>();
  private readonly installationRoots = new WeakMap<OwnedInstallationRoot, ManagedRuntimeAttempt>();
  private attempt: ManagedRuntimeAttempt | null = null;
  private attemptUsable = false;
  private attemptClosePromise: Promise<ManagedAttemptClose> | null = null;
  private installer: ManagedPnpmInstallation | null = null;
  private readonly installClosing = new AbortController();
  private selection: TrustedRuntimeSelection | null = null;
  private image: RuntimeImage | null = null;
  private closed = false;
  private busy = false;
  private ownedRoot: string | null = null;
  private ownedDirectory: OwnedDirectory | null = null;
  private retainedDebt: RuntimeDebt | null = null;
  private activeDone: Promise<void> | null = null;
  private finishActive: (() => void) | null = null;
  private readonly closing = new AbortController();
  private readonly root: string | null;
  private readonly scopeSignal: AbortSignal | undefined;
  private closePromise: Promise<RuntimeScopeClose> | null = null;

  constructor(input: ManagedRuntimeScopeInput) {
    this.supplied = scopeFields(input);
    this.root = typeof this.supplied?.root === "string" ? this.supplied.root : null;
    this.scopeSignal = this.supplied?.signal;
  }

  private isClosed(): boolean {
    return this.closed;
  }

  private unavailable(): boolean {
    return this.closed || this.busy;
  }

  private scopeAborted(): boolean {
    return this.scopeSignal?.aborted === true;
  }

  private begin(): void {
    this.busy = true;
    this.activeDone = new Promise((resolve) => {
      this.finishActive = resolve;
    });
  }

  private finish(): void {
    this.busy = false;
    this.finishActive?.();
    this.finishActive = null;
    this.activeDone = null;
  }

  private async doClose(): Promise<RuntimeScopeClose> {
    this.closed = true;
    this.closing.abort();
    if (this.activeDone) {await this.activeDone;}
    if (this.attempt) {
      this.attemptUsable = false;
      const result = await (this.attemptClosePromise ??= this.attempt.close());
      if (result.outcome === "debt") {this.retainedDebt ??= result.debt;}
      else {this.attempt = null; this.installer = null;}
    }
    if (this.retainedDebt) {return { outcome: "debt", debt: this.retainedDebt };}
    if (this.ownedRoot !== null) {
      const path = this.ownedRoot;
      if (!this.ownedDirectory || !await removeOwnedDirectory(this.ownedDirectory)) {
        const debt = liveDebt("cleanup-failed", path, emptyFacts);
        this.retainedDebt = debt;
        return { outcome: "debt", debt };
      }
      this.ownedRoot = null;
      this.ownedDirectory = null;
    }
    return { outcome: "closed" };
  }

  ownedInstallationRoot(): OwnedInstallationRoot | null {
    if (this.closed || !this.attempt || !this.attemptUsable) {return null;}
    const handle: OwnedInstallationRoot = Object.freeze({ kind: "managed-owned-installation-root" });
    this.installationRoots.set(handle, this.attempt);
    return handle;
  }

  async install(request: ManagedPnpmInstallInput): Promise<ManagedPnpmInstallResult> {
    const snapshot = snapshotInstallInput(request);
    if (!snapshot || this.unavailable() || !this.attempt || !this.attemptUsable || !this.installer ||
        !ownsRuntime(snapshot.runtime, this.image, this.handles) || this.installationRoots.get(snapshot.root) !== this.attempt) {
      return { outcome: "refused", code: "invalid-selection", facts: emptyFacts, debt: this.retainedDebt };
    }
    this.begin();
    try {
      const signal = AbortSignal.any([snapshot.signal, this.closing.signal, this.installClosing.signal,
        ...(this.scopeSignal ? [this.scopeSignal] : [])]);
      const result = await this.installer.install({ ...snapshot, signal });
      if (result.outcome === "refused" && result.debt) {
        this.retainedDebt = result.debt;
        this.closed = true;
        this.attemptUsable = false;
      }
      if (result.outcome === "installed" && signal.aborted) {
        return { outcome: "refused", code: "cancelled",
          facts: { ...result.facts, cancelled: true }, debt: null };
      }
      return result;
    } catch {
      return { outcome: "refused", code: "invalid-selection", facts: emptyFacts, debt: this.retainedDebt };
    } finally {this.finish();}
  }

  async acquireAttempt(request: ManagedAttemptInput): Promise<AttemptAcquisition> {
    const snapshot = snapshotAttemptInput(request);
    if (!snapshot || this.unavailable() || this.attempt || !this.image || !this.selection ||
        !ownsRuntime(snapshot.runtime, this.image, this.handles)) {
      return { outcome: "refused", code: "invalid-selection", debt: this.retainedDebt };
    }
    const { image, selection } = this;
    this.begin();
    try {
      const signal = AbortSignal.any([snapshot.signal, this.closing.signal,
        ...(this.scopeSignal ? [this.scopeSignal] : [])]);
      const cancelled = (): boolean => signal.aborted;
      await observeRuntimeImage(selection, image);
      if (cancelled()) {return { outcome: "refused", code: "cancelled", debt: null };}
      const result = await acquireManagedRuntimeAttempt({ ...snapshot, signal },
        { runtime: snapshot.runtime, image });
      if (result.outcome === "refused") {
        if (result.debt) {this.retainedDebt = result.debt; this.closed = true;}
        return result;
      }
      const owned = result.attempt as ManagedRuntimeAttempt;
      this.attempt = owned;
      this.installer = new ManagedPnpmInstallation({ selection, image, attempt: owned });
      if (cancelled()) {
        const close = await (this.attemptClosePromise ??= owned.close());
        if (close.outcome === "debt") {this.retainedDebt = close.debt; this.closed = true;}
        return { outcome: "refused", code: "cancelled", debt: this.retainedDebt };
      }
      this.attemptUsable = true;
      return { outcome: "acquired", attempt: Object.freeze({ ["token"]: owned.token,
        evidencePath: owned.evidencePath, ownedRoot: owned.ownedRoot,
        close: (): Promise<ManagedAttemptClose> => {
          if (this.attemptClosePromise) {return this.attemptClosePromise;}
          this.attemptUsable = false;
          this.installClosing.abort();
          this.attemptClosePromise = (async () => {
            if (this.activeDone) {await this.activeDone;}
            const close = await owned.close();
            if (close.outcome === "debt") {this.retainedDebt = close.debt; this.closed = true;}
            return close;
          })();
          return this.attemptClosePromise;
        } }) };
    } catch {return { outcome: "refused", code: "identity-changed", debt: this.retainedDebt };}
    finally {this.finish();}
  }

  async admit(): Promise<RuntimeAdmission> {
    if (this.unavailable() || this.image) {return { outcome: "refused", code: "invalid-selection", debt: this.retainedDebt };}
    const chosen = chooseRuntime(this.supplied, this.root);
    this.selection = chosen.selection;
    const invalid = chosen.code;
    if (invalid) {return { outcome: "refused", code: invalid, debt: null };}
    if (this.root === null || this.root === "") {return { outcome: "refused", code: "invalid-selection", debt: null };}
    if (this.scopeAborted()) {return { outcome: "refused", code: "cancelled", debt: null };}
    this.begin();
    try {
      this.image = await observeRuntimeImage(this.selection!);
      if (this.isClosed() || this.scopeAborted()) {return { outcome: "refused", code: "cancelled", debt: null };}
      if (!await validPrivateRoot(this.root, this.image)) {
        return { outcome: "refused", code: "invalid-selection", debt: null };
      }
      // The caller supplies an owned non-consumer parent; acquisition is deferred until admit.
      const acquired = await acquireOwnedDirectory(this.root);
      this.ownedRoot = acquired.path;
      this.ownedDirectory = acquired.binding;
      if (!this.ownedDirectory || this.ownedRoot === null) {
        if (this.ownedRoot !== null) {
          this.retainedDebt = liveDebt("cleanup-failed", this.ownedRoot, emptyFacts);
          this.closed = true;
          return { outcome: "refused", code: "cleanup-failed", debt: this.retainedDebt };
        }
        return { outcome: "refused", code: "invalid-selection", debt: null };
      }
      if (this.isClosed() || this.scopeAborted()) {
        if (!await removeOwnedDirectory(this.ownedDirectory)) {
          this.retainedDebt = liveDebt("cleanup-failed", this.ownedRoot, emptyFacts);
          this.closed = true;
          return { outcome: "refused", code: "cleanup-failed", debt: this.retainedDebt };
        }
        this.ownedRoot = null;
        this.ownedDirectory = null;
        return { outcome: "refused", code: "cancelled", debt: null };
      }
      const runtime: ManagedRuntimeHandle = Object.freeze({ kind: "managed-runtime-handle" });
      this.handles.set(runtime, this.image);
      return { outcome: "admitted", runtime };
    } catch { return { outcome: "refused", code: "identity-changed", debt: null }; }
    finally { this.finish(); }
  }

  async observe(request: ObservationRequest): Promise<RuntimeObservationResult> {
    const fields = observationFields(request);
    if (!fields || this.unavailable() || !this.image || this.ownedRoot === null || !this.selection ||
        !ownsRuntime(fields.runtime, this.image, this.handles)) {return refusal("invalid-selection", emptyFacts, this.retainedDebt);}
    const { image, selection, ownedRoot } = this;
    this.begin();
    let uncertainProcess = false;
    const requestAborted = (): boolean => fields.signal.aborted;
    const cancelled = (): boolean => requestAborted() || this.scopeAborted() || this.closing.signal.aborted;
    try {
      if (!await validOwnedDirectory(ownedRoot, this.ownedDirectory)) {
        this.retainedDebt = liveDebt("cleanup-failed", ownedRoot, emptyFacts);
        this.closed = true;
        return refusal("cleanup-failed", emptyFacts, this.retainedDebt);
      }
      if (!sameRuntimeTuple(fields.expected, selection.expected)) {return refusal("runtime-mismatch", emptyFacts);}
      if (cancelled()) {
        return refusal("cancelled", { ...emptyFacts, cancelled: true });
      }
      await observeRuntimeImage(selection, image);
      const controller = new AbortController();
      const abort = (): void => {controller.abort();};
      fields.signal.addEventListener("abort", abort, { once: true });
      this.scopeSignal?.addEventListener("abort", abort, { once: true });
      this.closing.signal.addEventListener("abort", abort, { once: true });
      if (cancelled()) {controller.abort();}
      let result: ProcessResult;
      try {
        uncertainProcess = true;
        result = await runManagedProbe({ image, expected: selection.expected,
          cwd: ownedRoot, kind: "pnpm-version", signal: controller.signal });
        uncertainProcess = false;
      }
      finally {
        fields.signal.removeEventListener("abort", abort);
        this.scopeSignal?.removeEventListener("abort", abort);
        this.closing.signal.removeEventListener("abort", abort);
      }
      return await this.completeObservation(result, selection, image, ownedRoot, cancelled);
    } catch {
      if (uncertainProcess) {
        this.retainedDebt = liveDebt("liveness-uncertain", ownedRoot, uncertainFacts);
        this.closed = true;
        return refusal("liveness-uncertain", uncertainFacts, this.retainedDebt);
      }
      return refusal("identity-changed", emptyFacts);
    }
    finally { this.finish(); }
  }

  private async completeObservation(result: ProcessResult, selection: TrustedRuntimeSelection,
    image: RuntimeImage, ownedRoot: string, cancelled: () => boolean): Promise<RuntimeObservationResult> {
    const rejected = probeRefusal(result, selection.expected, ownedRoot);
    if (rejected) {
      if (rejected.debt) { this.retainedDebt = rejected.debt; this.closed = true; }
      return rejected;
    }
    try { await observeRuntimeImage(selection, image); }
    catch { return refusal("identity-changed", result.facts); }
    if (this.isClosed() || cancelled()) {
      return refusal("cancelled", { ...result.facts, cancelled: true });
    }
    return { outcome: "observed", observation: {
      kind: "managed-runtime-observation", tuple: { ...selection.expected }, node: { ...image.node },
      pnpm: { manifest: { ...image.manifest }, entry: { ...image.entry }, packageTreeDigest: image.treeDigest },
      launcher: { kind: "direct-node" }, containment: "cooperative-posix-process-group"
    }, facts: result.facts };
  }

  close(): Promise<RuntimeScopeClose> {
    return this.closePromise ??= this.doClose();
  }
}

/** Factory-local authority and lifecycle. Assembly is inert. */
export function createNodeManagedRuntimeScope(input: ManagedRuntimeScopeInput): NodeManagedRuntimeScope {
  const owner = new ManagedRuntimeScopeOwner(input);
  return {
    ownedInstallationRoot: () => owner.ownedInstallationRoot(),
    install: request => owner.install(request),
    acquireAttempt: request => owner.acquireAttempt(request),
    admit: () => owner.admit(),
    observe: request => owner.observe(request),
    close: () => owner.close()
  };
}
