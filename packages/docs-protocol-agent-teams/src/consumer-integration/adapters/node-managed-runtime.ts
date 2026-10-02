import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { sameRuntimeTuple } from "../application/policies/managed-runtime-observation.js";
import type { ManagedRuntimeHandle, ManagedRuntimeObservationPort, ProcessFacts,
  RuntimeDebt, RuntimeObservationResult, RuntimeRefusalCode, RuntimeTuple } from "../application/ports/managed-runtime.js";
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

/** Factory-local authority and lifecycle. Assembly is inert. */
export function createNodeManagedRuntimeScope(input: ManagedRuntimeScopeInput): NodeManagedRuntimeScope {
  const supplied = scopeFields(input);
  const handles = new WeakMap<ManagedRuntimeHandle, RuntimeImage>();
  let selection: TrustedRuntimeSelection | null = null;
  let image: RuntimeImage | null = null;
  let closed = false, busy = false, ownedRoot: string | null = null;
  let ownedDirectory: OwnedDirectory | null = null;
  let retainedDebt: RuntimeDebt | null = null;
  let activeDone: Promise<void> | null = null;
  let finishActive: (() => void) | null = null;
  const closing = new AbortController();
  const isClosed = (): boolean => closed;
  const unavailable = (): boolean => closed || busy;
  const scopeAborted = (): boolean => scopeSignal?.aborted === true;
  const closeAborted = (): boolean => closing.signal.aborted;
  const begin = (): void => { busy = true; activeDone = new Promise((resolve) => { finishActive = resolve; }); };
  const finish = (): void => { busy = false; finishActive?.(); finishActive = null; activeDone = null; };
  const root = typeof supplied?.root === "string" ? supplied.root : null;
  const scopeSignal = supplied?.signal;
  let closePromise: Promise<RuntimeScopeClose> | null = null;
  const doClose = async (): Promise<RuntimeScopeClose> => {
    closed = true;
    closing.abort();
    if (activeDone) {await activeDone;}
    if (retainedDebt) {return { outcome: "debt", debt: retainedDebt };}
    if (ownedRoot !== null) {
      const path = ownedRoot;
      if (!ownedDirectory || !await removeOwnedDirectory(ownedDirectory)) {
        const debt = liveDebt("cleanup-failed", path, emptyFacts);
        retainedDebt = debt;
        return { outcome: "debt", debt };
      }
      ownedRoot = null;
      ownedDirectory = null;
    }
    return { outcome: "closed" };
  };
  return {
    async admit(): Promise<RuntimeAdmission> {
      if (unavailable() || image) {return { outcome: "refused", code: "invalid-selection", debt: retainedDebt };}
      const chosen = chooseRuntime(supplied, root);
      selection = chosen.selection;
      const invalid = chosen.code;
      if (invalid) {return { outcome: "refused", code: invalid, debt: null };}
      if (root === null || root === "") {return { outcome: "refused", code: "invalid-selection", debt: null };}
      if (scopeAborted()) {return { outcome: "refused", code: "cancelled", debt: null };}
      begin();
      try {
        image = await observeRuntimeImage(selection!);
        if (isClosed() || scopeAborted()) {return { outcome: "refused", code: "cancelled", debt: null };}
        if (!await validPrivateRoot(root, image)) {
          return { outcome: "refused", code: "invalid-selection", debt: null };
        }
        // The caller supplies an owned non-consumer parent; acquisition is deferred until admit.
        const acquired = await acquireOwnedDirectory(root);
        ownedRoot = acquired.path;
        ownedDirectory = acquired.binding;
        if (!ownedDirectory || ownedRoot === null) {
          if (ownedRoot !== null) {
            retainedDebt = liveDebt("cleanup-failed", ownedRoot, emptyFacts);
            closed = true;
            return { outcome: "refused", code: "cleanup-failed", debt: retainedDebt };
          }
          return { outcome: "refused", code: "invalid-selection", debt: null };
        }
        if (isClosed() || scopeAborted()) {
          if (!await removeOwnedDirectory(ownedDirectory)) {
            retainedDebt = liveDebt("cleanup-failed", ownedRoot, emptyFacts);
            closed = true;
            return { outcome: "refused", code: "cleanup-failed", debt: retainedDebt };
          }
          ownedRoot = null;
          ownedDirectory = null;
          return { outcome: "refused", code: "cancelled", debt: null };
        }
        const runtime: ManagedRuntimeHandle = Object.freeze({ kind: "managed-runtime-handle" });
        handles.set(runtime, image);
        return { outcome: "admitted", runtime };
      } catch { return { outcome: "refused", code: "identity-changed", debt: null }; }
      finally { finish(); }
    },
    async observe(request): Promise<RuntimeObservationResult> {
      const fields = observationFields(request);
      if (!fields || unavailable() || !image || ownedRoot === null || !selection ||
          !ownsRuntime(fields.runtime, image, handles)) {return refusal("invalid-selection", emptyFacts, retainedDebt);}
      begin();
      let uncertainProcess = false;
      const requestAborted = (): boolean => fields.signal.aborted;
      const cancelled = (): boolean => requestAborted() || scopeAborted() || closeAborted();
      try {
        if (!await validOwnedDirectory(ownedRoot, ownedDirectory)) {
          retainedDebt = liveDebt("cleanup-failed", ownedRoot, emptyFacts);
          closed = true;
          return refusal("cleanup-failed", emptyFacts, retainedDebt);
        }
        if (!sameRuntimeTuple(fields.expected, selection.expected)) {return refusal("runtime-mismatch", emptyFacts);}
        if (cancelled()) {
          return refusal("cancelled", { ...emptyFacts, cancelled: true });
        }
        await observeRuntimeImage(selection, image);
        const controller = new AbortController();
        const abort = (): void => {controller.abort();};
        fields.signal.addEventListener("abort", abort, { once: true });
        scopeSignal?.addEventListener("abort", abort, { once: true });
        closing.signal.addEventListener("abort", abort, { once: true });
        if (cancelled()) {controller.abort();}
        let result;
        try {
          uncertainProcess = true;
          result = await runManagedProbe({ image, expected: selection.expected,
            cwd: ownedRoot, kind: "pnpm-version", signal: controller.signal });
          uncertainProcess = false;
        }
        finally {
          fields.signal.removeEventListener("abort", abort);
          scopeSignal?.removeEventListener("abort", abort);
          closing.signal.removeEventListener("abort", abort);
        }
        const rejected = probeRefusal(result, selection.expected, ownedRoot);
        if (rejected) {
          if (rejected.debt) { retainedDebt = rejected.debt; closed = true; }
          return rejected;
        }
        try { await observeRuntimeImage(selection, image); }
        catch { return refusal("identity-changed", result.facts); }
        if (isClosed() || cancelled()) {
          return refusal("cancelled", { ...result.facts, cancelled: true });
        }
        return { outcome: "observed", observation: {
          kind: "managed-runtime-observation", tuple: { ...selection.expected }, node: { ...image.node },
          pnpm: { manifest: { ...image.manifest }, entry: { ...image.entry }, packageTreeDigest: image.treeDigest },
          launcher: { kind: "direct-node" }, containment: "cooperative-posix-process-group"
        }, facts: result.facts };
      } catch {
        if (uncertainProcess) {
          retainedDebt = liveDebt("liveness-uncertain", ownedRoot, uncertainFacts);
          closed = true;
          return refusal("liveness-uncertain", uncertainFacts, retainedDebt);
        }
        return refusal("identity-changed", emptyFacts);
      }
      finally { finish(); }
    },
    close(): Promise<RuntimeScopeClose> { return closePromise ??= doClose(); }
  };
}
