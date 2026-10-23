import { lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";

import { rejectQualityGateExecutor } from "../../../application/policies/quality-gate-input.js";
import type { QualityGateManagedProcessExecutor } from "../../../application/ports/managed-process-executor.js";
export type { QualityGateManagedProcessExecutor } from "../../../application/ports/managed-process-executor.js";
import type { PackageScriptExecutor } from "../../../application/ports/package-script-executor.js";
import { runPackageScriptProcess } from "../package-script-process.js";

export interface QualityGatePnpmEnvironment {
  readonly childEnvironment: Readonly<NodeJS.ProcessEnv>;
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
  candidates: readonly (string | undefined)[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (candidate !== undefined && isAbsolute(candidate)) {
      const canonical = await realpath(candidate).catch(() => null);
      if (
        canonical !== null &&
        /\.(?:c|m)?js$/iu.test(canonical) &&
        (await isRegularFile(canonical))
      ) {
        return canonical;
      }
    }
  }
  return undefined;
}

async function resolvePnpmInvocation(
  environment: QualityGatePnpmEnvironment,
): Promise<PnpmInvocation> {
  if (
    process.platform !== "win32" &&
    environment.npmExecPath !== undefined &&
    isAbsolute(environment.npmExecPath)
  ) {
    const canonical = await realpath(environment.npmExecPath).catch(() => null);
    if (canonical !== null && (await isRegularFile(canonical))) {
      // Classify JS-vs-native on the canonical executed target, never the
      // unresolved spelling, so an explicit native npmExecPath is never ignored.
      if (!/\.(?:c|m)?js$/iu.test(canonical)) {
        return { command: canonical, argsPrefix: [] };
      }
    } else if (!/\.(?:c|m)?js$/iu.test(environment.npmExecPath)) {
      rejectQualityGateExecutor();
    }
  }
  const homeEntrypoint =
    environment.pnpmHome === undefined
      ? undefined
      : resolve(environment.pnpmHome, "..", "pnpm", "bin", "pnpm.cjs");
  const pathEntrypoints =
    environment.pathValue === undefined
      ? []
      : environment.pathValue
          .split(delimiter)
          .filter((path) => path.length > 0)
          .map((path) => resolve(path, process.platform === "win32" ? "pnpm.exe" : "pnpm"));
  const entrypoint = await nodeEntrypoint([
    environment.npmExecPath,
    homeEntrypoint,
    ...pathEntrypoints,
  ]);
  if (entrypoint !== undefined) {
    if (environment.nodeExecutablePath === undefined) {
      rejectQualityGateExecutor();
    }
    return { command: environment.nodeExecutablePath, argsPrefix: [entrypoint] };
  }
  if (process.platform !== "win32") {
    return { command: "pnpm", argsPrefix: [] };
  }
  const candidates = [
    ...(environment.pnpmHome === undefined ? [] : [resolve(environment.pnpmHome, "pnpm.exe")]),
    ...(environment.pathValue === undefined
      ? []
      : environment.pathValue
          .split(delimiter)
          .filter((path) => path.length > 0)
          .map((path) => resolve(path, "pnpm.exe"))),
  ];
  for (const candidate of candidates) {
    if (await isRegularFile(candidate)) {
      return { command: candidate, argsPrefix: [] };
    }
  }
  rejectQualityGateExecutor();
}

export class PnpmQualityGateScriptExecutor implements PackageScriptExecutor {
  constructor(
    private readonly environment: QualityGatePnpmEnvironment,
    private readonly processExecutor: QualityGateManagedProcessExecutor,
  ) {}

  async run(input: {
    readonly packageManager: "bun" | "pnpm";
    readonly consumerRoot: string;
    readonly scriptId: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }) {
    if (input.packageManager !== "pnpm") {
      rejectQualityGateExecutor();
    }
    const invocation = await resolvePnpmInvocation(this.environment);
    return runPackageScriptProcess(this.processExecutor, {
      command: invocation.command,
      args: [...invocation.argsPrefix, "run", input.scriptId],
      cwd: input.consumerRoot,
      environment: this.environment.childEnvironment,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
}
