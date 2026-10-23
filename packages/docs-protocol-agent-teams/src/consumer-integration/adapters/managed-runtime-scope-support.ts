import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { sameRuntimeTuple } from "../application/policies/managed-runtime-observation.js";
import {
  type AttemptAcquisition,
  type ManagedAttemptInput,
  type ManagedPnpmInstallInput,
  type ManagedPnpmInstallResult,
  type OwnedInstallationRoot,
  type ManagedRuntimeHandle,
  type ManagedRuntimeObservationPort,
  type ProcessFacts,
  type RuntimeDebt,
  type RuntimeObservationResult,
  type RuntimeRefusalCode,
  type RuntimeTuple,
} from "../application/ports/managed-runtime.js";
import {
  validateSelection,
  type RuntimeImage,
  type TrustedRuntimeSelection,
} from "./node-managed-runtime-identity.js";
import { type ProcessResult } from "./node-managed-runtime-process.js";
export interface ManagedRuntimeScopeInput {
  readonly privateRoot: string;
  readonly selection: TrustedRuntimeSelection;
  readonly signal: AbortSignal;
}
export type RuntimeAdmission =
  | { readonly outcome: "admitted"; readonly runtime: ManagedRuntimeHandle }
  | {
      readonly outcome: "refused";
      readonly code: RuntimeRefusalCode;
      readonly debt: RuntimeDebt | null;
    };
export type RuntimeScopeClose =
  | { readonly outcome: "closed" }
  | { readonly outcome: "debt"; readonly debt: RuntimeDebt };
export interface NodeManagedRuntimeScope extends ManagedRuntimeObservationPort {
  admit(): Promise<RuntimeAdmission>;
  acquireAttempt(input: ManagedAttemptInput): Promise<AttemptAcquisition>;
  ownedInstallationRoot(): OwnedInstallationRoot | null;
  install(input: ManagedPnpmInstallInput): Promise<ManagedPnpmInstallResult>;
  close(): Promise<RuntimeScopeClose>;
}
export const emptyFacts: ProcessFacts = {
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
export const uncertainFacts: ProcessFacts = {
  ...emptyFacts,
  directChild: "unconfirmed",
  group: "unconfirmed",
  streams: "unconfirmed",
};
export const liveDebt = (
  code: RuntimeDebt["code"],
  attemptId: string,
  facts: ProcessFacts,
): RuntimeDebt =>
  Object.freeze({ code, attemptId, evidencePath: null, facts: Object.freeze({ ...facts }) });
export const refusal = (
  code: RuntimeRefusalCode,
  facts: ProcessFacts,
  debt: RuntimeDebt | null = null,
): Extract<RuntimeObservationResult, { outcome: "refused" }> => ({
  outcome: "refused",
  code,
  facts,
  debt,
});
export async function validPrivateRoot(root: string, image: RuntimeImage): Promise<boolean> {
  try {
    const canonical = await realpath(root);
    const stat = await lstat(root);
    const nodeBin = dirname(image.nodePath);
    return (
      canonical === root &&
      stat.isDirectory() &&
      root !== image.rootPath &&
      !root.startsWith(`${image.rootPath}${sep}`) &&
      root !== nodeBin &&
      !root.startsWith(`${nodeBin}${sep}`)
    );
  } catch {
    return false;
  }
}
export interface OwnedDirectory {
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
    lstat(parent, { bigint: true }),
    lstat(path, { bigint: true }),
    realpath(parent),
    realpath(path),
  ]);
  if (
    !parentStat.isDirectory() ||
    !directoryStat.isDirectory() ||
    parentReal !== parent ||
    directoryReal !== path
  ) {
    throw new Error("owned-root-retargeted");
  }
  return {
    path,
    parent,
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino,
    device: directoryStat.dev,
    inode: directoryStat.ino,
  };
}
export async function removeOwnedDirectory(owned: OwnedDirectory): Promise<boolean> {
  try {
    const current = await bindOwnedDirectory(owned.path);
    if (!sameOwnedDirectory(current, owned)) {
      return false;
    }
    await rm(owned.path, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
function sameOwnedDirectory(current: OwnedDirectory, owned: OwnedDirectory): boolean {
  return (
    current.parent === owned.parent &&
    current.parentDevice === owned.parentDevice &&
    current.parentInode === owned.parentInode &&
    current.device === owned.device &&
    current.inode === owned.inode
  );
}
export async function validOwnedDirectory(
  path: string,
  owned: OwnedDirectory | null,
): Promise<boolean> {
  return (
    owned !== null &&
    (await bindOwnedDirectory(path).then(
      (current) => sameOwnedDirectory(current, owned),
      () => false,
    ))
  );
}
export async function acquireOwnedDirectory(
  root: string,
): Promise<{ path: string | null; binding: OwnedDirectory | null }> {
  let parent: OwnedDirectory;
  try {
    parent = await bindOwnedDirectory(root);
  } catch {
    return { path: null, binding: null };
  }
  let path: string | null = null;
  try {
    path = await mkdtemp(join(root, "managed-runtime-"));
    const binding = await bindOwnedDirectory(path);
    if (binding.parentDevice !== parent.device || binding.parentInode !== parent.inode) {
      return { path, binding: null };
    }
    return { path, binding };
  } catch {
    return { path, binding: null };
  }
}
export function observationFields(
  value: unknown,
): { runtime: ManagedRuntimeHandle; expected: RuntimeTuple; signal: AbortSignal } | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== 3
    ) {
      return null;
    }
    const runtime = Object.getOwnPropertyDescriptor(value, "runtime");
    const expected = Object.getOwnPropertyDescriptor(value, "expected");
    const signal = Object.getOwnPropertyDescriptor(value, "signal");
    if (
      !runtime ||
      !expected ||
      !signal ||
      !Object.hasOwn(runtime, "value") ||
      !Object.hasOwn(expected, "value") ||
      !Object.hasOwn(signal, "value") ||
      runtime.value === null ||
      typeof runtime.value !== "object" ||
      !(signal.value instanceof AbortSignal)
    ) {
      return null;
    }
    const expectedValue: unknown = expected.value;
    return {
      runtime: runtime.value as ManagedRuntimeHandle,
      expected: expectedValue as RuntimeTuple,
      signal: signal.value,
    };
  } catch {
    return null;
  }
}

export function scopeFields(input: ManagedRuntimeScopeInput) {
  try {
    if (Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== 3) {
      return null;
    }
    const root = Object.getOwnPropertyDescriptor(input, "privateRoot");
    const selected = Object.getOwnPropertyDescriptor(input, "selection");
    const signal = Object.getOwnPropertyDescriptor(input, "signal");
    if (
      !root ||
      !selected ||
      !signal ||
      !Object.hasOwn(root, "value") ||
      !Object.hasOwn(selected, "value") ||
      !Object.hasOwn(signal, "value") ||
      !(signal.value instanceof AbortSignal)
    ) {
      return null;
    }
    return {
      root: root.value as unknown,
      selection: selected.value as unknown,
      signal: signal.value,
    };
  } catch {
    return null;
  }
}

export function chooseRuntime(
  supplied: ReturnType<typeof scopeFields>,
  root: string | null,
): {
  code: RuntimeRefusalCode | null;
  selection: TrustedRuntimeSelection | null;
} {
  let selection: TrustedRuntimeSelection | null = null;
  if (!supplied) {
    return { code: "invalid-selection", selection };
  }
  try {
    const launcher = Object.getOwnPropertyDescriptor(supplied.selection, "launcher");
    if (launcher && Object.hasOwn(launcher, "value") && launcher.value === "corepack") {
      return { code: "unsupported-launcher", selection };
    }
  } catch {
    return { code: "invalid-selection", selection };
  }
  selection = validateSelection(supplied.selection);
  if (!selection || typeof root !== "string" || resolvePath(root) !== root || root.includes("\0")) {
    return { code: "invalid-selection", selection };
  }
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    selection.expected.platform !== "linux" ||
    selection.expected.architecture !== "x64"
  ) {
    return { code: "unsupported-platform", selection };
  }
  return { code: null, selection };
}

export function probeRefusal(
  result: ProcessResult,
  expected: RuntimeTuple,
  ownedRoot: string,
): Extract<RuntimeObservationResult, { outcome: "refused" }> | null {
  if (
    !result.facts.spawned &&
    result.facts.group === "not-started" &&
    result.facts.directChild === "not-started"
  ) {
    return refusal(result.code ?? "spawn-failed", result.facts);
  }
  if (
    result.facts.group !== "empty-observed" ||
    result.facts.streams !== "closed" ||
    result.facts.directChild !== "reaped"
  ) {
    const debt = liveDebt("liveness-uncertain", ownedRoot, result.facts);
    return refusal(result.code ?? "liveness-uncertain", result.facts, debt);
  }
  if (result.code) {
    return refusal(result.code, result.facts);
  }
  let output: string;
  try {
    output = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(result.output, "utf8"));
  } catch {
    return refusal("invalid-output", result.facts);
  }
  if (
    output !== `${expected.pnpmVersion}\n` ||
    !result.handshake ||
    !sameRuntimeTuple(result.handshake, expected)
  ) {
    return refusal("runtime-mismatch", result.facts);
  }
  return null;
}

export function ownsRuntime(
  runtime: ManagedRuntimeHandle,
  image: RuntimeImage | null,
  handles: WeakMap<ManagedRuntimeHandle, RuntimeImage>,
): boolean {
  return image !== null && handles.has(runtime) && handles.get(runtime) === image;
}

export type ObservationRequest = Parameters<ManagedRuntimeObservationPort["observe"]>[0];

/** One factory's private authority and lifecycle; no owner instance is exposed. */
