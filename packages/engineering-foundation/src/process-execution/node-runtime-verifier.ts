import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

async function regularFile(path: string): Promise<boolean> {
  const metadata = await lstat(path).catch(() => null);
  return metadata?.isFile() === true;
}

async function verifyNode(path: string): Promise<boolean> {
  if (!isAbsolute(path) || !await regularFile(path)) {
    return false;
  }
  const observation = spawnSync(path, ["-p", "JSON.stringify({execPath:process.execPath,version:process.versions.node})"], {
    encoding: "utf8",
    timeout: 10_000
  });
  if (observation.status !== 0) {
    return false;
  }
  try {
    const observed = JSON.parse(observation.stdout) as { readonly execPath: string; readonly version: string };
    return observed.version === "26.11.1" &&
      await realpath(observed.execPath) === await realpath(path) &&
      /^node(?:\.exe)?$/iu.test(basename(observed.execPath));
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
  const observation = isAbsolute(candidate)
    ? spawnSync(candidate, ["-p", "JSON.stringify({execPath:process.execPath,version:process.versions.node})"], {
        encoding: "utf8",
        timeout: 10_000
      })
    : undefined;
  if (observation?.status !== 0) {
    throw new Error("An explicit admitted Node executable is required.");
  }
  try {
    const observed = JSON.parse(observation?.stdout ?? "") as { readonly execPath: string; readonly version: string };
    if (
      observed.version !== "26.11.1" ||
      realpathSync(observed.execPath) !== realpathSync(candidate) ||
      !/^node(?:\.exe)?$/iu.test(basename(observed.execPath))
    ) {
      throw new Error("The selected executable is not admitted Node 26.11.1.");
    }
    return candidate;
  } catch (error) {
    throw new Error("An explicit admitted Node executable is required.", { cause: error });
  }
}
