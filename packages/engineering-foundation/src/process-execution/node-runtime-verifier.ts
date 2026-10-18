import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import type { RepositoryRuntimeProfile } from "./application/runtime-selection.js";

export const NODE_EXECUTABLE_ENVIRONMENT_VARIABLE =
  "AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE";

interface RuntimeIdentity {
  readonly execPath: string;
  readonly version: string;
  readonly releaseName: string;
  readonly bunVersion: string | null;
  readonly hasBunGlobal: boolean;
}

const runtimeIdentityArguments = [
  "-p",
  "JSON.stringify({execPath:process.execPath,version:process.versions.node,releaseName:process.release.name,bunVersion:Object.prototype.hasOwnProperty.call(process.versions,\"bun\")?process.versions.bun:null,hasBunGlobal:typeof globalThis.Bun!==\"undefined\"})"
] as const;

function observeRuntimeIdentity(path: string): RuntimeIdentity | null {
  const observation = spawnSync(path, runtimeIdentityArguments, {
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024
  });
  if (observation.status !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(observation.stdout) as Partial<RuntimeIdentity>;
    if (
      typeof parsed.execPath !== "string" ||
      typeof parsed.version !== "string" ||
      typeof parsed.releaseName !== "string" ||
      (parsed.bunVersion !== null && typeof parsed.bunVersion !== "string") ||
      typeof parsed.hasBunGlobal !== "boolean"
    ) {
      return null;
    }
    return {
      execPath: parsed.execPath,
      version: parsed.version,
      releaseName: parsed.releaseName,
      bunVersion: parsed.bunVersion ?? null,
      hasBunGlobal: parsed.hasBunGlobal
    };
  } catch {
    return null;
  }
}

function isActualNode(identity: RuntimeIdentity, path: string): boolean {
  return identity.releaseName === "node" &&
    identity.bunVersion === null &&
    !identity.hasBunGlobal &&
    /^node(?:\.exe)?$/iu.test(basename(identity.execPath)) &&
    realpathSync(identity.execPath) === realpathSync(path);
}

function isSupportedNode(identity: RuntimeIdentity, path: string): boolean {
  const match = /^(\d+)\.(\d+)\.\d+$/u.exec(identity.version);
  const major = match === null ? 0 : Number(match[1]);
  const minor = match === null ? 0 : Number(match[2]);
  return isActualNode(identity, path) &&
    (major === 26 || (major === 24 && minor >= 18));
}

/** Host identity check for the explicitly selected, closed repository runtime. */
export async function verifyRepositoryRuntimeExecutable(
  path: string,
  runtime: RepositoryRuntimeProfile
): Promise<boolean> {
  if (!isAbsolute(path)) {
    return false;
  }
  const metadata = await lstat(path).catch(() => null);
  if (metadata?.isFile() !== true) {
    return false;
  }
  const identity = observeRuntimeIdentity(path);
  if (identity === null) {
    return false;
  }
  try {
    if (runtime === "node") {
      return isSupportedNode(identity, path);
    }
    return identity.hasBunGlobal && identity.bunVersion !== null &&
      /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(identity.bunVersion) &&
      realpathSync(identity.execPath) === realpathSync(path);
  } catch {
    return false;
  }
}

/**
 * Verifies the narrow Node executable used by the Windows managed bootstrap.
 * Profile selection remains elsewhere; this is a Host custody precondition.
 */
export function requireAdmittedNodeExecutable(
  environment: Readonly<Record<string, string | undefined>>,
  currentExecutablePath: string
): string {
  const explicit = environment[NODE_EXECUTABLE_ENVIRONMENT_VARIABLE];
  const candidate = explicit ?? currentExecutablePath;
  const observed = isAbsolute(candidate) ? observeRuntimeIdentity(candidate) : null;
  if (observed === null) {
    throw new Error("An explicit admitted Node executable is required.");
  }
  try {
    if (!isSupportedNode(observed, candidate)) {
      throw new Error("The selected executable is not a supported public Node runtime.");
    }
    return candidate;
  } catch (error) {
    throw new Error("A supported public Node executable is required.", { cause: error });
  }
}
