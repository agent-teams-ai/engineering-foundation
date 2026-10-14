import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

export const NODE_EXECUTABLE_ENVIRONMENT_VARIABLE =
  "AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE";

interface NodeIdentity {
  readonly execPath: string;
  readonly version: string;
  readonly releaseName: string;
  readonly bunVersion: string | null;
  readonly hasBunGlobal: boolean;
}

const nodeIdentityArguments = [
  "-p",
  "JSON.stringify({execPath:process.execPath,version:process.versions.node,releaseName:process.release.name,bunVersion:Object.prototype.hasOwnProperty.call(process.versions,\"bun\")?process.versions.bun:null,hasBunGlobal:typeof globalThis.Bun!==\"undefined\"})"
] as const;

function observeNodeIdentity(path: string): NodeIdentity | null {
  const observation = spawnSync(path, nodeIdentityArguments, {
    encoding: "utf8",
    timeout: 10_000
  });
  if (observation.status !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(observation.stdout) as Partial<NodeIdentity>;
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

function isActualNode(identity: NodeIdentity, path: string): boolean {
  return identity.releaseName === "node" &&
    identity.bunVersion === null &&
    !identity.hasBunGlobal &&
    /^node(?:\.exe)?$/iu.test(basename(identity.execPath)) &&
    realpathSync(identity.execPath) === realpathSync(path);
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
  const observed = isAbsolute(candidate) ? observeNodeIdentity(candidate) : null;
  if (observed === null) {
    throw new Error("An explicit admitted Node executable is required.");
  }
  try {
    const match = /^(\d+)\.(\d+)\.\d+$/u.exec(observed.version);
    const major = match === null ? 0 : Number(match[1]);
    const minor = match === null ? 0 : Number(match[2]);
    if (
      !isActualNode(observed, candidate) ||
      !(major === 26 || (major === 24 && minor >= 18))
    ) {
      throw new Error("The selected executable is not a supported public Node runtime.");
    }
    return candidate;
  } catch (error) {
    throw new Error("A supported public Node executable is required.", { cause: error });
  }
}
