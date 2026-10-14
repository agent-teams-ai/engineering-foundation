import { spawnSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";

export type RepositoryRuntimeProfile = "bun" | "node";

export interface RuntimeExecutables {
  readonly profile: RepositoryRuntimeProfile;
  readonly node: string;
  readonly bun?: string;
}

export async function isRegularFile(path: string): Promise<boolean> {
  const metadata = await stat(path).catch(() => null);
  return metadata?.isFile() === true;
}

export async function firstExisting(
  candidates: readonly (string | undefined)[]
): Promise<string> {
  for (const candidate of candidates) {
    if (candidate !== undefined && isAbsolute(candidate) && await isRegularFile(candidate)) {
      return candidate;
    }
  }
  throw new Error("No admitted runtime executable was found.");
}

function pathCandidates(name: string): readonly string[] {
  return (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((path) => path.length > 0)
    .map((path) => resolve(path, process.platform === "win32" ? `${name}.exe` : name));
}

function observeNode(path: string): {
  readonly execPath: string;
  readonly version: string;
  readonly releaseName: string;
} {
  const observation = spawnSync(path, [
    "-p",
    "JSON.stringify({execPath:process.execPath,version:process.versions.node,releaseName:process.release.name})"
  ], { encoding: "utf8", timeout: 10_000 });
  if (observation.status !== 0) {
    throw new Error(`Node executable did not run: ${path}`);
  }
  try {
    const parsed = JSON.parse(observation.stdout) as {
      readonly execPath?: unknown;
      readonly version?: unknown;
      readonly releaseName?: unknown;
    };
    if (
      typeof parsed.execPath !== "string" ||
      typeof parsed.version !== "string" ||
      typeof parsed.releaseName !== "string"
    ) {
      throw new Error("Malformed Node observation.");
    }
    return {
      execPath: parsed.execPath,
      version: parsed.version,
      releaseName: parsed.releaseName
    };
  } catch (error) {
    throw new Error(`Node executable returned invalid identity: ${path}`, { cause: error });
  }
}

function supportedPublicNode(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 26 || (major === 24 && minor >= 18);
}

export async function verifyQualificationNode(path: string): Promise<string> {
  if (!isAbsolute(path) || !await isRegularFile(path)) {
    throw new Error(`Node executable is unavailable: ${path}`);
  }
  const observed = observeNode(path);
  if (
    observed.releaseName !== "node" ||
    observed.version !== "26.11.1" ||
    await realpath(observed.execPath) !== await realpath(path) ||
    !/(?:^|[\\/])node(?:\.exe)?$/u.test(observed.execPath)
  ) {
    throw new Error(`Executable is not admitted Node 26.11.1: ${path}`);
  }
  return path;
}

export async function verifySupportedNode(path: string): Promise<string> {
  if (!isAbsolute(path) || !await isRegularFile(path)) {
    throw new Error(`Node executable is unavailable: ${path}`);
  }
  const observed = observeNode(path);
  if (
    observed.releaseName !== "node" ||
    !supportedPublicNode(observed.version) ||
    await realpath(observed.execPath) !== await realpath(path) ||
    !/(?:^|[\\/])node(?:\.exe)?$/u.test(observed.execPath)
  ) {
    throw new Error(`Executable is not a supported public Node runtime: ${path}`);
  }
  return path;
}

export async function verifyBun(path: string): Promise<string> {
  if (!isAbsolute(path) || !await isRegularFile(path)) {
    throw new Error(`Bun executable is unavailable: ${path}`);
  }
  const observation = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (observation.status !== 0 || observation.stdout.trim() !== "1.4.3") {
    throw new Error(`Executable is not admitted Bun 1.4.3: ${path}`);
  }
  return path;
}

export async function resolveQualificationExecutables(
  profile: RepositoryRuntimeProfile
): Promise<RuntimeExecutables> {
  const node = await verifyQualificationNode(await firstExisting([
    process.env["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"],
    process.versions["bun"] === undefined ? process.execPath : undefined,
    ...pathCandidates("node")
  ]));
  if (profile === "node") {
    return { profile, node };
  }
  const bun = await verifyBun(await firstExisting([
    process.env["AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE"],
    ...pathCandidates("bun")
  ]));
  return { profile, node, bun };
}
