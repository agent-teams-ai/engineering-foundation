import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import {
  isActualNodeIdentity,
  isSupportedNodeIdentity,
  observeNodeIdentity,
  type NodeIdentity
} from "../packages/engineering-foundation/src/process-execution/node-runtime-verifier.ts";

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

function requiredNodeObservation(path: string): NodeIdentity {
  const observed = observeNodeIdentity(path);
  if (observed === null) {
    throw new Error(`Node executable returned invalid identity: ${path}`);
  }
  return observed;
}

export async function verifyQualificationNode(path: string): Promise<string> {
  if (!isAbsolute(path) || !await isRegularFile(path)) {
    throw new Error(`Node executable is unavailable: ${path}`);
  }
  const observed = requiredNodeObservation(path);
  if (
    !isActualNodeIdentity(observed, path) ||
    observed.version !== "26.11.1" ||
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
  const observed = requiredNodeObservation(path);
  if (!isSupportedNodeIdentity(observed, path)) {
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
