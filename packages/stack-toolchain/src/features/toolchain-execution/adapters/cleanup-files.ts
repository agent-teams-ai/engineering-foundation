import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isProcessRuntimeError, type ProcessRunResult } from "node-or-bun";
import { assertRuntime, execute } from "./commands.js";
import { validateLintConfiguration } from "./configuration.js";
import { resolveToolExecutable } from "./executables.js";
import { batches, observe, outsideTemporaryRoot, requestedFiles } from "./format-files.js";

export interface CleanupInput {
  readonly cwd: string;
  readonly files: readonly string[];
  readonly signal: AbortSignal;
  readonly budgetMs?: number;
  readonly lintConfigPath?: string;
}
export interface CleanupReport {
  readonly command: "fix";
  readonly exitCode: number;
  readonly durationMs: number;
  readonly details: {
    readonly schemaVersion: 1;
    readonly requested: readonly string[];
    readonly attempted: readonly string[];
    readonly changed: readonly string[];
    readonly completed: boolean;
    readonly sourceObservationComplete: boolean;
    readonly steps: readonly CleanupStep[];
    readonly failure?: string;
    readonly retainedControlDirectory?: string;
  };
}
interface CleanupStep {
  readonly tool: "oxlint" | "oxfmt";
  readonly operation: "write" | "check";
  readonly files: readonly string[];
  readonly result: ProcessRunResult;
}
const syntaxExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const preset = (name: string) =>
  fileURLToPath(new URL(`../../../../presets/${name}`, import.meta.url));

function remaining(signal: AbortSignal, deadline: number): number {
  signal.throwIfAborted();
  const value = Math.floor(deadline - performance.now());
  if (value <= 0) {
    throw new Error("TOOLCHAIN_DEADLINE");
  }
  return value;
}
function snapshot(root: string, file: string) {
  const result = observe(root, file);
  // A writer must also reject a link to a file outside the selected census.
  if (fs.lstatSync(path.join(root, file)).nlink !== 1) {
    throw new Error("TOOLCHAIN_CLEANUP_HARDLINK");
  }
  return result;
}
function selectFiles(input: CleanupInput, root: string, signal: AbortSignal, deadline: number) {
  const files = requestedFiles(input.files);
  const snapshots = new Map<string, ReturnType<typeof snapshot>>();
  let bytes = 0;
  for (const file of files) {
    remaining(signal, deadline);
    if (!syntaxExtensions.has(path.extname(file)) || /[*?{}\[\]]/u.test(file)) {
      throw new Error("TOOLCHAIN_CLEANUP_UNSUPPORTED");
    }
    const value = snapshot(root, file);
    bytes += value.bytes;
    if (bytes > 64 * 1024 * 1024) {
      throw new Error("TOOLCHAIN_CLEANUP_LIMIT");
    }
    snapshots.set(file, value);
  }
  return { files, snapshots };
}
function cleanupConfig(input: CleanupInput, root: string): string {
  if (input.lintConfigPath === undefined) {
    return preset("oxlint/cleanup-fix.json");
  }
  const [file] = requestedFiles([input.lintConfigPath]);
  observe(root, file!);
  const config = path.join(root, file!);
  validateLintConfiguration(config, true);
  return config;
}
function changedFiles(
  root: string,
  snapshots: ReadonlyMap<string, ReturnType<typeof snapshot>>,
): { changed: string[]; complete: boolean } {
  const changed: string[] = [];
  let complete = true;
  for (const [file, before] of snapshots) {
    try {
      if (snapshot(root, file).sha256 !== before.sha256) {
        changed.push(file);
      }
    } catch {
      complete = false;
    }
  }
  return { changed, complete };
}
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "TOOLCHAIN_CLEANUP_FAILED";
}

function operations(config: string, ignore: string) {
  const linter = resolveToolExecutable("oxlint");
  const formatter = resolveToolExecutable("oxfmt");
  const lintArgs = ["--format=json", "--no-ignore", "--disable-nested-config", "--config", config];
  const formatArgs = [
    "--disable-nested-config",
    "--config",
    preset("format.json"),
    "--ignore-path",
    ignore,
  ];
  return [
    { tool: "oxlint", operation: "write", executable: linter, args: ["--fix", ...lintArgs] },
    { tool: "oxfmt", operation: "write", executable: formatter, args: ["--write", ...formatArgs] },
    { tool: "oxlint", operation: "check", executable: linter, args: lintArgs },
    { tool: "oxfmt", operation: "check", executable: formatter, args: ["--check", ...formatArgs] },
  ] as const;
}

/** Explicit writes only. The caller owns selection, protected files and exclusive source access. */
export async function fixFiles(input: CleanupInput): Promise<CleanupReport> {
  const started = performance.now();
  const attempted = new Set<string>();
  const steps: CleanupStep[] = [];
  let requested: string[] = [];
  let snapshots = new Map<string, ReturnType<typeof snapshot>>();
  let root = input.cwd;
  let control: string | undefined;
  let retainControl = false;
  let completed = false;
  let validated = false;
  let exitCode = 2;
  let failure: string | undefined;
  let deadline = Number.POSITIVE_INFINITY;
  try {
    assertRuntime();
    const budget = input.budgetMs ?? 300_000;
    if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 2_147_483_647) {
      throw new Error("TOOLCHAIN_INVALID_BUDGET");
    }
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(budget)]);
    deadline = started + budget;
    remaining(signal, deadline);
    root = fs.realpathSync(input.cwd);
    const selected = selectFiles(input, root, signal, deadline);
    requested = selected.files;
    snapshots = selected.snapshots;
    validated = true;
    const config = cleanupConfig(input, root);
    control = fs.mkdtempSync(path.join(outsideTemporaryRoot(root), "stack-cleanup-"));
    const ignore = path.join(control, "empty.ignore");
    fs.writeFileSync(ignore, "", { flag: "wx", mode: 0o600 });
    const plan = operations(config, ignore).map((operation) => ({
      ...operation,
      groups: batches(requested, [
        operation.executable.command,
        ...operation.executable.prefix,
        ...operation.args,
        "--",
      ]),
    }));
    exitCode = 0;
    for (const operation of plan) {
      for (const files of operation.groups) {
        for (const file of files) {
          remaining(signal, deadline);
          snapshot(root, file);
          if (operation.operation === "write") {
            attempted.add(file);
          }
        }
        let result: ProcessRunResult;
        try {
          result = await execute(
            operation.executable,
            [...operation.args, "--", ...files.map((file) => `./${file}`)],
            root,
            signal,
            { timeoutMs: remaining(signal, deadline) },
          );
        } catch (error) {
          retainControl = !isProcessRuntimeError(error) || error.incompleteCustody;
          throw error;
        }
        steps.push({ tool: operation.tool, operation: operation.operation, files, result });
        remaining(signal, deadline);
        if (result.exitCode !== 0) {
          exitCode = result.exitCode === 1 ? 1 : 2;
          break;
        }
      }
      if (exitCode !== 0) {
        break;
      }
    }
    completed = exitCode === 0;
    remaining(signal, deadline);
  } catch (error) {
    failure = failureMessage(error);
    exitCode = 2;
    completed = false;
  } finally {
    if (control !== undefined && !retainControl) {
      try {
        fs.unlinkSync(path.join(control, "empty.ignore"));
        fs.rmdirSync(control);
      } catch {
        retainControl = true;
        failure ??= "TOOLCHAIN_CLEANUP_CONTROL";
        exitCode = 2;
        completed = false;
      }
    }
  }
  const observation = changedFiles(root, snapshots);
  if (!observation.complete || input.signal.aborted || performance.now() >= deadline) {
    completed = false;
    exitCode = input.signal.aborted ? 130 : 2;
    failure ??= input.signal.aborted
      ? "TOOLCHAIN_CANCELLED"
      : performance.now() >= deadline
        ? "TOOLCHAIN_DEADLINE"
        : "TOOLCHAIN_CLEANUP_OBSERVATION";
  }
  return {
    command: "fix",
    exitCode,
    durationMs: performance.now() - started,
    details: {
      schemaVersion: 1,
      requested,
      attempted: [...attempted],
      changed: observation.changed,
      completed,
      sourceObservationComplete: validated && observation.complete && !retainControl,
      steps,
      ...(failure === undefined ? {} : { failure }),
      ...(retainControl ? { retainedControlDirectory: control! } : {}),
    },
  };
}
