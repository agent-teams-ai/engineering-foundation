import { spawnSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { verifyRepositoryRuntimeExecutable } from "../packages/engineering-foundation/src/process-execution/node-runtime-verifier.ts";

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

export async function firstExisting(candidates: readonly (string | undefined)[]): Promise<string> {
  for (const candidate of candidates) {
    if (candidate !== undefined && isAbsolute(candidate) && (await isRegularFile(candidate))) {
      return realpath(candidate);
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

function runtimeVersion(path: string, kind: RepositoryRuntimeProfile): string | null {
  const observation = spawnSync(
    path,
    ["-p", kind === "node" ? "process.versions.node" : "process.versions.bun"],
    {
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024,
    },
  );
  return observation.status === 0 ? observation.stdout.trim() : null;
}

export async function verifyQualificationNode(path: string): Promise<string> {
  if (
    !(await verifyRepositoryRuntimeExecutable(path, "node")) ||
    runtimeVersion(path, "node") !== "26.11.1"
  ) {
    throw new Error(`Executable is not admitted Node 26.11.1: ${path}`);
  }
  return path;
}

export async function verifySupportedNode(path: string): Promise<string> {
  if (!(await verifyRepositoryRuntimeExecutable(path, "node"))) {
    throw new Error(`Executable is not a supported public Node runtime: ${path}`);
  }
  return path;
}

export async function verifyBun(path: string): Promise<string> {
  if (
    !(await verifyRepositoryRuntimeExecutable(path, "bun")) ||
    runtimeVersion(path, "bun") !== "1.4.3"
  ) {
    throw new Error(`Executable is not admitted Bun 1.4.3: ${path}`);
  }
  return path;
}

export async function resolveQualificationExecutables(
  profile: RepositoryRuntimeProfile,
): Promise<RuntimeExecutables> {
  const explicitNode = process.env["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"];
  const node = await verifyQualificationNode(
    explicitNode ??
      (await firstExisting([
        process.versions["bun"] === undefined ? process.execPath : undefined,
        ...pathCandidates("node"),
      ])),
  );
  if (profile === "node") {
    return { profile, node };
  }
  const explicitBun = process.env["AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE"];
  const bun = await verifyBun(explicitBun ?? (await firstExisting(pathCandidates("bun"))));
  return { profile, node, bun };
}
