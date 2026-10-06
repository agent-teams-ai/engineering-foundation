import type {
  ManagedAttemptInput, ManagedPnpmInstallInput, ProcessFacts
} from "./ports/managed-runtime.js";

export type ManagedAttemptPhase =
  | "acquired" | "spawning" | "running" | "stopping" | "terminated" | "debt";

const successors: Readonly<Record<ManagedAttemptPhase, readonly ManagedAttemptPhase[]>> = {
  acquired: ["spawning", "terminated", "debt"],
  spawning: ["running", "stopping", "debt"],
  running: ["stopping", "debt"],
  stopping: ["terminated", "debt"],
  terminated: ["spawning", "debt"],
  debt: []
};

export function permitsAttemptTransition(
  from: ManagedAttemptPhase, to: ManagedAttemptPhase
): boolean {
  return successors[from].includes(to);
}

export function hasNoManagedChild(facts: ProcessFacts): boolean {
  return !facts.spawned && facts.directChild === "not-started" &&
    facts.group === "not-started" && facts.streams === "not-started";
}

export function hasSettledManagedChild(facts: ProcessFacts): boolean {
  return facts.spawned && facts.directChild === "reaped" &&
    facts.group === "empty-observed" && facts.streams === "closed";
}

/** Finite facts permit a release attempt; they do not perform physical settlement. */
export function permitsAttemptRelease(
  phase: ManagedAttemptPhase, facts: ProcessFacts, hasChildIdentity: boolean
): boolean {
  if (phase === "acquired") {
    return !hasChildIdentity && hasNoManagedChild(facts);
  }
  return phase === "terminated" &&
    (hasChildIdentity ? hasSettledManagedChild(facts) : hasNoManagedChild(facts));
}

function dataFields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" ||
        Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    if (!required.every(key => Object.hasOwn(value, key)) ||
        keys.some(key => typeof key !== "string" || ![...required, ...optional].includes(key))) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (field === undefined || field.enumerable !== true || !Object.hasOwn(field, "value")) {
        return null;
      }
      snapshot[key as string] = field.value as unknown;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function signal(value: unknown): value is AbortSignal {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");
    return value instanceof AbortSignal && descriptor !== undefined && descriptor.get !== undefined &&
      typeof descriptor.get.call(value) === "boolean";
  } catch {
    return false;
  }
}

export function snapshotAttemptInput(value: unknown): ManagedAttemptInput | null {
  const fields = dataFields(value,
    ["externalRoot", "consumerRoot", "controllerBuildDigest", "role", "runtime", "signal"],
    ["preparationDigest"]);
  if (!fields || !signal(fields.signal) || typeof fields.externalRoot !== "string" ||
      typeof fields.consumerRoot !== "string" || typeof fields.controllerBuildDigest !== "string" ||
      (fields.role !== "source" && fields.role !== "target") ||
      fields.runtime === null || typeof fields.runtime !== "object" ||
      Object.hasOwn(fields, "preparationDigest") && typeof fields.preparationDigest !== "string") {
    return null;
  }
  const snapshot: ManagedAttemptInput = {
    externalRoot: fields.externalRoot,
    consumerRoot: fields.consumerRoot,
    controllerBuildDigest: fields.controllerBuildDigest,
    role: fields.role,
    runtime: fields.runtime as ManagedAttemptInput["runtime"],
    signal: fields.signal,
    ...(Object.hasOwn(fields, "preparationDigest") && typeof fields.preparationDigest === "string"
      ? { preparationDigest: fields.preparationDigest }
      : {})
  };
  return Object.freeze(snapshot);
}

export function snapshotInstallInput(value: unknown): ManagedPnpmInstallInput | null {
  const fields = dataFields(value, ["root", "runtime", "mode", "expectedManifestDigest",
    "expectedWorkspaceDigest", "expectedLockDigest", "signal"]);
  if (!fields || !signal(fields.signal) || fields.root === null || typeof fields.root !== "object" ||
      fields.runtime === null || typeof fields.runtime !== "object" ||
      (fields.mode !== "prepare" && fields.mode !== "frozen-offline") ||
      typeof fields.expectedManifestDigest !== "string" || typeof fields.expectedWorkspaceDigest !== "string" ||
      fields.expectedLockDigest !== null && typeof fields.expectedLockDigest !== "string") {
    return null;
  }
  const snapshot: ManagedPnpmInstallInput = {
    root: fields.root as ManagedPnpmInstallInput["root"],
    runtime: fields.runtime as ManagedPnpmInstallInput["runtime"],
    mode: fields.mode,
    expectedManifestDigest: fields.expectedManifestDigest,
    expectedWorkspaceDigest: fields.expectedWorkspaceDigest,
    expectedLockDigest: fields.expectedLockDigest,
    signal: fields.signal
  };
  return Object.freeze(snapshot);
}

/** This checkpoint admits a disposable single-project local-tarball fixture. */
export function permitsDisposableProject(manifest: unknown, workspace: unknown): boolean {
  const project = dataFields(manifest, ["name", "version", "private", "packageManager", "dependencies"], ["scripts"]);
  const layout = dataFields(workspace, ["packages"]);
  if (!project || !layout || project.private !== true || project.packageManager !== "pnpm@11.20.0" ||
      typeof project.name !== "string" || typeof project.version !== "string" ||
      !Array.isArray(layout.packages) || layout.packages.length !== 0) {
    return false;
  }
  const dependencies = project.dependencies;
  if (dependencies === null || typeof dependencies !== "object" ||
      Object.getPrototypeOf(dependencies) !== Object.prototype) {
    return false;
  }
  return Object.values(dependencies).every(value => typeof value === "string" &&
    /^file:\.\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.tgz$/.test(value) &&
    !value.slice(5).split("/").includes(".."));
}
