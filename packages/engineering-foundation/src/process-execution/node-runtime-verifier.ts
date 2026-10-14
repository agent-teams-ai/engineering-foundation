import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

async function regularFile(path: string): Promise<boolean> {
  const metadata = await lstat(path).catch(() => null);
  return metadata?.isFile() === true;
}

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

async function verifyNode(path: string): Promise<boolean> {
  if (!isAbsolute(path) || !await regularFile(path)) {
    return false;
  }
  try {
    const observed = observeNodeIdentity(path);
    if (observed === null) {
      return false;
    }
    const match = /^(\d+)\.(\d+)\.\d+$/u.exec(observed.version);
    const major = match === null ? 0 : Number(match[1]);
    const minor = match === null ? 0 : Number(match[2]);
    return isActualNode(observed, path) && (major === 26 || (major === 24 && minor >= 18));
  } catch {
    return false;
  }
}

async function verifyBun(path: string): Promise<boolean> {
  if (!isAbsolute(path) || !await regularFile(path)) {
    return false;
  }
  const observation = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
  return observation.status === 0 && observation.stdout.trim() === "1.4.3";
}

export async function verifyAdmittedRuntimeExecutable(path: string): Promise<boolean> {
  if (/^node(?:\.exe)?$/iu.test(basename(path))) {
    return verifyNode(path);
  }
  if (/^bun(?:\.exe)?$/iu.test(basename(path))) {
    return verifyBun(path);
  }
  return false;
}

export function requireAdmittedNodeExecutable(
  environment: Readonly<Record<string, string | undefined>>,
  currentExecutablePath: string
): string {
  const explicit = environment["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"];
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
