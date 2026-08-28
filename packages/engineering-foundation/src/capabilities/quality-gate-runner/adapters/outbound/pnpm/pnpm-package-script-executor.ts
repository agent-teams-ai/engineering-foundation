import { lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";

import { FoundationError } from "../../../../../errors.js";
import {
  executeManagedProcess,
  ProcessCancellationError,
  ProcessTimeoutError
} from "../../../../../process-execution/node-process-runner.js";
import type {
  ManagedProcessResult,
  ProcessRequest
} from "../../../../../process-execution/types.js";
import {
  PackageScriptCancellationError,
  PackageScriptTimeoutError,
  type PackageScriptExecutor
} from "../../../application/ports/package-script-executor.js";

export interface QualityGatePnpmEnvironment {
  readonly npmExecPath?: string;
  readonly pnpmHome?: string;
  readonly pathValue?: string;
}

export interface QualityGateManagedProcessExecutor {
  run(request: ProcessRequest): Promise<ManagedProcessResult>;
}

const nodeManagedProcessExecutor: QualityGateManagedProcessExecutor = {
  run: executeManagedProcess
};

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
        /\.(?:c|m)?js$/u.test(canonical) &&
        await isRegularFile(canonical)
      ) {
        return canonical;
      }
    }
  }
  return undefined;
}

async function resolvePnpmInvocation(
  environment: QualityGatePnpmEnvironment
): Promise<PnpmInvocation> {
  const homeEntrypoint = environment.pnpmHome === undefined
    ? undefined
    : resolve(environment.pnpmHome, "..", "pnpm", "bin", "pnpm.cjs");
  const pathEntrypoints = environment.pathValue === undefined
    ? []
    : environment.pathValue.split(delimiter)
        .filter((path) => path.length > 0)
        .map((path) => resolve(path, process.platform === "win32" ? "pnpm.exe" : "pnpm"));
  const entrypoint = await nodeEntrypoint([
    environment.npmExecPath,
    homeEntrypoint,
    ...pathEntrypoints
  ]);
  if (entrypoint !== undefined) {
    return { command: process.execPath, argsPrefix: [entrypoint] };
  }
  if (process.platform !== "win32") {
    return { command: "pnpm", argsPrefix: [] };
  }
  const candidates = [
    ...(environment.pnpmHome === undefined
      ? []
      : [resolve(environment.pnpmHome, "pnpm.exe")]),
    ...(environment.pathValue === undefined
      ? []
      : environment.pathValue.split(delimiter)
          .filter((path) => path.length > 0)
          .map((path) => resolve(path, "pnpm.exe")))
  ];
  for (const candidate of candidates) {
    if (await isRegularFile(candidate)) {
      return { command: candidate, argsPrefix: [] };
    }
  }
  throw new FoundationError(
    "PROCESS_FAILED",
    "Unable to resolve a shell-free pnpm entrypoint on Windows."
  );
}

export class PnpmQualityGateScriptExecutor implements PackageScriptExecutor {
  constructor(
    private readonly environment: QualityGatePnpmEnvironment,
    private readonly processExecutor: QualityGateManagedProcessExecutor =
      nodeManagedProcessExecutor
  ) {}

  async run(input: {
    readonly consumerRoot: string;
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
    readonly scriptId: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }) {
    const invocation = await resolvePnpmInvocation(this.environment);
    try {
      const result = await this.processExecutor.run({
        command: invocation.command,
        args: [...invocation.argsPrefix, "run", input.scriptId],
        cwd: input.consumerRoot,
        ...(input.environment === undefined
          ? {}
          : { environment: input.environment }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      return {
        ...result,
        exitCode: result.signal === null ? result.exitCode : null
      };
    } catch (error) {
      if (error instanceof ProcessCancellationError) {
        throw new PackageScriptCancellationError({ cause: error });
      }
      if (error instanceof ProcessTimeoutError) {
        throw new PackageScriptTimeoutError(error.timeoutMs, { cause: error });
      }
      throw error;
    }
  }
}
