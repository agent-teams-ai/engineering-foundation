import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createProcessExecutor } from "node-or-bun";
import { createNodeProcessAdapter } from "node-or-bun/node";
import { loadConfiguration } from "./configuration.js";
import {
  resolveExecutables,
  resolveToolExecutable,
  resolveCompilerExecutable,
  resolveTsgolintExecutable,
} from "./executables.js";
import { createCheckerRunner, type CheckerExecutable } from "./process.js";
import { typecheck } from "../application/typecheck.js";

export interface CommandInput {
  readonly command: "typecheck" | "lint" | "format:check" | "compile" | "doctor";
  readonly cwd: string;
  readonly configPath?: string;
  readonly signal: AbortSignal;
  readonly budgetMs?: number;
  readonly compileArgs?: readonly string[];
}
export interface CommandReport {
  readonly command: CommandInput["command"];
  readonly status: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly details: unknown;
  readonly versions: unknown;
}
const executor = createProcessExecutor(createNodeProcessAdapter());
async function execute(
  executable: CheckerExecutable,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  env?: Readonly<Record<string, string>>,
) {
  const result = await executor.run({
    command: executable.command,
    args: [...executable.prefix, ...args],
    cwd,
    signal,
    timeoutMs: 300_000,
    strictUtf8: true,
    ...(env === undefined ? {} : { environment: env }),
  });
  if (
    !result.facts.outputBounded ||
    result.facts.incompleteCustody ||
    result.facts.lateFailureCodes.length > 0
  ) {
    throw new Error("TOOLCHAIN_INCOMPLETE_PROCESS_RESULT");
  }
  return result;
}
async function doctor(input: CommandInput): Promise<Record<string, unknown>> {
  const executables = resolveExecutables();
  const versions: Record<string, unknown> = {};
  for (const [engine, executable] of Object.entries(executables)) {
    if (executable === null) {
      versions[engine] = { available: false };
      continue;
    }
    const result = await execute(executable, ["--version"], input.cwd, input.signal);
    versions[engine] = {
      available: result.exitCode === 0,
      version: result.stdout.trim(),
      stderr: result.stderr,
    };
  }
  return versions;
}
async function compile(input: CommandInput, executable: CheckerExecutable | null) {
  if (executable === null) {
    throw new Error("TOOLCHAIN_COMPILER_UNAVAILABLE");
  }
  const args = input.compileArgs ?? [];
  const validProject = args[0] === "--project" && args.length === 2;
  const validBuild = args[0] === "--build" && args.length >= 2;
  if ((!validProject && !validBuild) || args.slice(1).some((arg) => arg.startsWith("-"))) {
    throw new Error("TOOLCHAIN_COMPILE_ARGUMENTS");
  }
  return execute(executable, args, input.cwd, input.signal);
}
async function check(
  input: CommandInput,
  config: Awaited<ReturnType<typeof loadConfiguration>>,
  started: number,
) {
  const remaining = (input.budgetMs ?? 300_000) - (performance.now() - started);
  if (remaining <= 0) {
    throw new Error("TOOLCHAIN_DEADLINE");
  }
  const executables = resolveExecutables();
  const result = await typecheck(
    { projects: config.projects, signal: input.signal, budgetMs: remaining },
    {
      run: createCheckerRunner({ cwd: config.root, executables, now: () => performance.now() }),
      now: () => performance.now(),
    },
  );
  return result;
}
function checkExit(
  result: Awaited<ReturnType<typeof typecheck>>,
  callerSignal: AbortSignal,
): number {
  if (result.status !== "failed") {
    return 0;
  }
  if (result.code === "TOOLCHAIN_DIAGNOSTICS") {
    return 1;
  }
  return result.code === "TOOLCHAIN_CANCELLED" && callerSignal.aborted ? 130 : 2;
}
function assertRuntime(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (
    process.release.name !== "node" ||
    "bun" in process.versions ||
    !((major === 24 && minor! >= 18) || major === 26)
  ) {
    throw new Error("TOOLCHAIN_UNSUPPORTED_NODE_RUNTIME");
  }
}
async function lint(input: CommandInput, config: Awaited<ReturnType<typeof loadConfiguration>>) {
  const executable = resolveToolExecutable("oxlint");
  const invoke = (scope: typeof config.lint, typed: boolean) =>
    execute(
      executable,
      [
        ...(typed ? ["--type-aware"] : []),
        "--disable-nested-config",
        "--config",
        scope.config,
        "--",
        ...scope.paths,
      ],
      config.root,
      input.signal,
      typed ? { OXLINT_TSGOLINT_PATH: resolveTsgolintExecutable() } : undefined,
    );
  if (config.lint.syntax === undefined) {
    const result = await invoke(config.lint, true);
    return { exitCode: result.exitCode === 0 ? 0 : 1, details: result };
  }
  const lanes: { readonly name: "syntax" | "typed"; readonly result: unknown }[] = [];
  let lane: "syntax" | "typed" = "syntax";
  try {
    for (const name of ["syntax", "typed"] as const) {
      lane = name;
      input.signal.throwIfAborted();
      const result = await invoke(
        name === "syntax" ? config.lint.syntax : config.lint,
        name === "typed",
      );
      lanes.push({ name, result });
      if (result.exitCode !== 0) {
        return { exitCode: 1, details: { lanes } };
      }
    }
    return { exitCode: 0, details: { lanes } };
  } catch (error) {
    lanes.push({
      name: lane,
      result: { message: error instanceof Error ? error.message : String(error) },
    });
    throw Object.assign(new Error("TOOLCHAIN_LINT_LANE_FAILED", { cause: error }), { lanes });
  }
}
function failureDetails(error: unknown): { readonly message: string; readonly lanes?: unknown } {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && "lanes" in error ? { lanes: error.lanes } : {}),
  };
}
export async function runCommand(input: CommandInput): Promise<CommandReport> {
  const started = performance.now();
  const originalSignal = input.signal;
  const report = (status: string, exitCode: number, details: unknown): CommandReport => ({
    command: input.command,
    status,
    exitCode,
    durationMs: performance.now() - started,
    details,
    versions,
  });
  let versions: unknown = null;
  try {
    assertRuntime();
    const budget = input.budgetMs ?? 300_000;
    if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 2_147_483_647) {
      throw new Error("TOOLCHAIN_INVALID_BUDGET");
    }
    const callerSignal = input.signal;
    input = { ...input, signal: AbortSignal.any([callerSignal, AbortSignal.timeout(budget)]) };
    input.signal.throwIfAborted();
    versions = JSON.parse(
      fs.readFileSync(new URL("../../../../toolchain-manifest.json", import.meta.url), "utf8"),
    ) as unknown;
    if (input.command === "doctor") {
      const details = await doctor(input);
      const required = details["typescript"] as { available: boolean };
      return report(required.available ? "passed" : "failed", required.available ? 0 : 2, details);
    }
    if (input.command === "compile") {
      const result = await compile(input, resolveCompilerExecutable());
      return report(
        result.exitCode === 0 ? "passed" : "failed",
        result.exitCode === 0 ? 0 : 1,
        result,
      );
    }
    const config = await loadConfiguration({
      cwd: input.cwd,
      signal: input.signal,
      ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
    });
    if (input.command === "typecheck") {
      const result = await check(input, config, started);
      return report(result.status, checkExit(result, originalSignal), result);
    }
    if (input.command === "lint") {
      const result = await lint(input, config);
      return report(result.exitCode === 0 ? "passed" : "failed", result.exitCode, result.details);
    }
    const executable = resolveToolExecutable("oxfmt");
    const args = [
      "--check",
      "--config",
      fileURLToPath(new URL("../../../../presets/format.json", import.meta.url)),
      "--disable-nested-config",
      "--",
      ...config.format.paths,
    ];
    const result = await execute(executable, args, config.root, input.signal);
    return report(
      result.exitCode === 0 ? "passed" : "failed",
      result.exitCode === 0 ? 0 : 1,
      result,
    );
  } catch (error) {
    return report("failed", originalSignal.aborted ? 130 : 2, failureDetails(error));
  }
}
