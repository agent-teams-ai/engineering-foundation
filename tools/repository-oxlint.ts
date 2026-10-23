import { execFile, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { withoutGitRepositorySelectors } from "./git-environment.ts";

const execute = promisify(execFile);
const MAX_ARGUMENT_BYTES = 8_000;

export interface RepositoryOxlintInput {
  readonly node: string;
  readonly entry: string;
  readonly args: readonly string[];
  readonly targets: readonly string[];
  readonly sourceRoot: string;
  readonly consumerRoot: string;
  readonly environment: NodeJS.ProcessEnv;
}

function batches(paths: readonly string[]): readonly (readonly string[])[] {
  const result: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path, "utf8") + 1;
    if (size > MAX_ARGUMENT_BYTES) {
      throw new Error("Oxlint source path exceeds the command argument budget.");
    }
    if (bytes + size > MAX_ARGUMENT_BYTES && batch.length > 0) {
      result.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(path);
    bytes += size;
  }
  if (batch.length > 0) {
    result.push(batch);
  }
  return result;
}

function selectedPaths(stdout: string): readonly string[] {
  if (stdout.length === 0) {
    return [];
  }
  if (!stdout.endsWith("\n")) {
    throw new Error("Oxlint returned malformed file selection.");
  }
  const paths = stdout
    .replace(/\r?\n$/u, "")
    .split(/\r?\n/u)
    .map((path) => path.replaceAll("\\", "/"));
  if (
    new Set(paths).size !== paths.length ||
    paths.some(
      (path) =>
        isAbsolute(path) ||
        path.includes(":") ||
        [...path].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        path.split("/").some((part) => part === "" || part === "." || part === ".."),
    )
  ) {
    throw new Error("Oxlint returned unsafe or duplicate selected paths.");
  }
  return paths.toSorted();
}

async function select(
  input: RepositoryOxlintInput,
  cwd: string,
  targets: readonly string[],
): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const batch of batches(targets)) {
    const result = await execute(
      input.node,
      [input.entry, ...input.args, "--debug", "files", "--", ...batch],
      {
        cwd,
        env: withoutGitRepositorySelectors(input.environment),
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (result.stderr.length !== 0) {
      throw new Error("Oxlint selection did not produce clean evidence.");
    }
    paths.push(...selectedPaths(result.stdout));
  }
  return [...new Set(paths)].toSorted();
}

/** The pinned CLI selects source files; explicit names bypass only ancestor traversal. */
export async function runRepositoryOxlint(input: RepositoryOxlintInput): Promise<number> {
  if (input.targets.length === 0) {
    throw new Error("Oxlint requires explicit source targets.");
  }
  const paths = await select(input, input.sourceRoot, input.targets);
  if (paths.length === 0) {
    throw new Error("Oxlint selected zero source files; refusing an empty lint run.");
  }
  const projected = await select(input, input.consumerRoot, paths);
  if (JSON.stringify(paths) !== JSON.stringify(projected)) {
    throw new Error("Oxlint source and projection selections differ.");
  }
  let status = 0;
  for (const batch of batches(paths)) {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(input.node, [input.entry, ...input.args, "--", ...batch], {
        cwd: input.consumerRoot,
        env: withoutGitRepositorySelectors(input.environment),
        stdio: "inherit",
        shell: false,
      });
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => {
        if (signal !== null) {
          reject(new Error(`Oxlint terminated by ${signal}.`));
        } else {
          resolve(exitCode ?? 1);
        }
      });
    });
    if (code !== 0) {
      status = code;
    }
  }
  return status;
}
