import { lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";

import type { PackageScriptRunner } from "../../../application/ports/changed-workflow.js";
import { rejectWorkflowExecutor } from "../../../application/policies/workflow-input.js";
import type { ExecuteWorkflowProcess } from "../../../application/ports/process-execution.js";

export interface PnpmProcessEnvironment {
  readonly nodeExecutablePath?: string;
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
    if (candidate !== undefined && isAbsolute(candidate)) {
      const canonical = await realpath(candidate).catch(() => null);
      if (
        canonical !== null &&
        /\.(?:c|m)?js$/iu.test(canonical) &&
        await isRegularFile(canonical)
      ) {
        return canonical;
      }
    }
  }
  return undefined;
}

async function resolvePnpmInvocation(
  environment: PnpmProcessEnvironment
): Promise<PnpmInvocation> {
  if (
    process.platform !== "win32" &&
    environment.npmExecPath !== undefined &&
    isAbsolute(environment.npmExecPath)
  ) {
    // Same precedence as the quality-gate executor: an explicit native
    // npmExecPath wins, classified on the canonical executed target.
    const canonical = await realpath(environment.npmExecPath).catch(() => null);
    if (canonical !== null && await isRegularFile(canonical)) {
      if (!/\.(?:c|m)?js$/iu.test(canonical)) {
        return { command: canonical, argsPrefix: [] };
      }
    } else if (!/\.(?:c|m)?js$/iu.test(environment.npmExecPath)) {
      rejectWorkflowExecutor();
    }
  }
  const pnpmPackageEntrypoint =
    environment.pnpmHome === undefined
      ? undefined
      : resolve(environment.pnpmHome, "..", "pnpm", "bin", "pnpm.cjs");
  const entrypoint = await nodeEntrypoint([
    environment.npmExecPath,
    pnpmPackageEntrypoint
  ]);
  if (entrypoint !== undefined) {
    if (environment.nodeExecutablePath === undefined) {
      rejectWorkflowExecutor();
    }
    return { command: environment.nodeExecutablePath, argsPrefix: [entrypoint] };
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
  rejectWorkflowExecutor();
}

export class PnpmPackageScriptRunner implements PackageScriptRunner {
  constructor(
    private readonly environment: PnpmProcessEnvironment,
    private readonly execute: ExecuteWorkflowProcess
  ) {}

  async run(input: {
    readonly packageManager: "bun" | "pnpm";
    readonly consumerRoot: string;
    readonly script: string;
    readonly paths: readonly string[];
    readonly signal?: AbortSignal;
  }) {
    if (input.packageManager !== "pnpm") {
      rejectWorkflowExecutor();
    }
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
