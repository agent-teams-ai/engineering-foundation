import { lstat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";

import type { PackageScriptRunner } from "../../../application/ports/changed-workflow.js";
import { FoundationError } from "../../../../../errors.js";
import type { ExecuteWorkflowProcess } from "../../../application/ports/process-execution.js";

export interface PnpmProcessEnvironment {
  readonly npmExecPath?: string;
  readonly pnpmHome?: string;
  readonly pathValue?: string;
}

interface PnpmInvocation {
  readonly command: string;
  readonly argsPrefix: readonly string[];
}

async function isRegularFile(path: string): Promise<boolean> {
  const metadata = await lstat(path).catch(() => null);
  return metadata !== null && metadata.isFile();
}

async function nodeEntrypoint(
  candidates: readonly (string | undefined)[]
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (
      candidate !== undefined &&
      isAbsolute(candidate) &&
      /\.(?:c|m)?js$/u.test(candidate) &&
      await isRegularFile(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

async function resolvePnpmInvocation(
  environment: PnpmProcessEnvironment
): Promise<PnpmInvocation> {
  const pnpmPackageEntrypoint =
    environment.pnpmHome === undefined
      ? undefined
      : resolve(environment.pnpmHome, "..", "pnpm", "bin", "pnpm.cjs");
  const entrypoint = await nodeEntrypoint([
    environment.npmExecPath,
    pnpmPackageEntrypoint
  ]);
  if (entrypoint !== undefined) {
    return { command: process.execPath, argsPrefix: [entrypoint] };
  }
  if (process.platform !== "win32") {
    return { command: "pnpm", argsPrefix: [] };
  }
  const executableCandidates = [
    ...(environment.pnpmHome === undefined
      ? []
      : [resolve(environment.pnpmHome, "pnpm.exe")]),
    ...(environment.pathValue === undefined
      ? []
      : environment.pathValue
          .split(delimiter)
          .filter((path) => path.length > 0)
          .map((path) => resolve(path, "pnpm.exe")))
  ];
  for (const candidate of executableCandidates) {
    if (await isRegularFile(candidate)) {
      return { command: candidate, argsPrefix: [] };
    }
  }
  throw new FoundationError(
    "PROCESS_FAILED",
    "Unable to resolve a shell-free pnpm entrypoint on Windows."
  );
}

export class PnpmPackageScriptRunner implements PackageScriptRunner {
  constructor(
    private readonly environment: PnpmProcessEnvironment,
    private readonly execute: ExecuteWorkflowProcess
  ) {}

  async run(input: {
    readonly consumerRoot: string;
    readonly script: string;
    readonly paths: readonly string[];
    readonly signal?: AbortSignal;
  }) {
    const args = [
      "run",
      input.script,
      ...(input.paths.length === 0 ? [] : ["--", ...input.paths])
    ];
    const invocation = await resolvePnpmInvocation(this.environment);
    return this.execute(
      invocation.command,
      [...invocation.argsPrefix, ...args],
      {
        cwd: input.consumerRoot,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      }
    );
  }
}
