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
export interface CleanupStep {
  readonly tool: "oxlint" | "oxfmt";
  readonly operation: "write" | "check";
  readonly files: readonly string[];
  readonly result: ProcessRunResult;
}
interface CleanupDiagnostic {
  readonly filename: string;
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}
function isRuleDiagnostic(value: unknown): value is CleanupDiagnostic {
  return (
    typeof value === "object" &&
    value !== null &&
    "filename" in value &&
    typeof value.filename === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "code" in value &&
    typeof value.code === "string" &&
    /^[a-z][a-z0-9-]*\([a-z][a-z0-9-]*\)$/u.test(value.code) &&
    "severity" in value &&
    (value.severity === "error" || value.severity === "warning")
  );
}
/** Only ordinary native rule diagnostics may continue the cleanup pipeline. */
export function readCleanupDiagnostics(stdout: string): readonly CleanupDiagnostic[] | undefined {
  try {
    const output: unknown = JSON.parse(stdout);
    if (
      typeof output !== "object" ||
      output === null ||
      !("diagnostics" in output) ||
      !Array.isArray(output.diagnostics)
    ) {
      return undefined;
    }
    const diagnostics: readonly unknown[] = output.diagnostics;
    return diagnostics.every(isRuleDiagnostic) ? diagnostics : undefined;
  } catch {
    return undefined;
  }
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
function cleanupWindow(input: CleanupInput, started: number) {
  const budget = input.budgetMs ?? 300_000;
  if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 2_147_483_647) {
    throw new Error("TOOLCHAIN_INVALID_BUDGET");
  }
  return {
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(budget)]),
    deadline: started + budget,
  };
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
    if (
      !syntaxExtensions.has(path.extname(file)) ||
      ["*", "?", "{", "}", "[", "]"].some((character) => file.includes(character))
    ) {
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
  signal: AbortSignal,
  deadline: number,
): { changed: string[]; complete: boolean } {
  const changed: string[] = [];
  let complete = true;
  for (const [file, before] of snapshots) {
    if (signal.aborted || performance.now() >= deadline) {
      return { changed, complete: false };
    }
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

interface CleanupEvidence {
  readonly attempted: Set<string>;
  readonly steps: CleanupStep[];
  retainControl: boolean;
}
async function runOperations(
  input: {
    readonly config: string;
    readonly ignore: string;
    readonly files: readonly string[];
    readonly root: string;
    readonly signal: AbortSignal;
    readonly deadline: number;
  },
  evidence: CleanupEvidence,
  mode: "write" | "check",
): Promise<number> {
  const plan = operations(input.config, input.ignore).map((operation) => ({
    ...operation,
    groups: batches(input.files, [
      operation.executable.command,
      ...operation.executable.prefix,
      ...operation.args,
      "--",
    ]),
  }));
  let outcome = 0;
  for (const operation of plan) {
    if (operation.operation !== mode) {
      continue;
    }
    for (const files of operation.groups) {
      for (const file of files) {
        remaining(input.signal, input.deadline);
        snapshot(input.root, file);
      }
      if (operation.operation === "write") {
        for (const file of files) {
          evidence.attempted.add(file);
        }
      }
      let result: ProcessRunResult;
      try {
        result = await execute(
          operation.executable,
          [...operation.args, "--", ...files.map((file) => `./${file}`)],
          input.root,
          input.signal,
          { timeoutMs: remaining(input.signal, input.deadline) },
        );
      } catch (error) {
        evidence.retainControl = !isProcessRuntimeError(error) || error.incompleteCustody;
        throw error;
      }
      evidence.steps.push({ tool: operation.tool, operation: operation.operation, files, result });
      remaining(input.signal, input.deadline);
      if (operation.tool === "oxlint") {
        const diagnostics = readCleanupDiagnostics(result.stdout);
        if (
          diagnostics === undefined ||
          (result.exitCode !== 0 && result.exitCode !== 1) ||
          (result.exitCode === 1 && diagnostics.length === 0)
        ) {
          throw new Error("TOOLCHAIN_CLEANUP_LINT_OUTPUT");
        }
        if (result.exitCode === 1) {
          outcome = 1;
        }
      } else if (result.exitCode !== 0) {
        if (mode !== "check" || result.exitCode !== 1) {
          return 2;
        }
        outcome = 1;
      }
    }
  }
  return outcome;
}

// Native fixes can overlap within one declaration. Finish those edits before
// handing diagnostics back to the caller; never let conflicting policies loop.
async function stabilizeCleanup(
  input: Parameters<typeof runOperations>[0],
  evidence: CleanupEvidence,
): Promise<number> {
  for (let pass = 0; pass < 10; pass++) {
    const before = new Map<string, ReturnType<typeof snapshot>>();
    for (const file of input.files) {
      remaining(input.signal, input.deadline);
      before.set(file, snapshot(input.root, file));
    }
    const exitCode = await runOperations(input, evidence, "write");
    if (exitCode === 2) {
      return exitCode;
    }
    const observation = changedFiles(input.root, before, input.signal, input.deadline);
    if (!observation.complete) {
      throw new Error("TOOLCHAIN_CLEANUP_OBSERVATION");
    }
    if (observation.changed.length === 0) {
      return runOperations(input, evidence, "check");
    }
  }
  throw new Error("TOOLCHAIN_CLEANUP_NOT_STABLE");
}

/** Explicit writes only. The caller owns selection, protected files and exclusive source access. */
export async function fixFiles(input: CleanupInput): Promise<CleanupReport> {
  const started = performance.now();
  const evidence: CleanupEvidence = {
    attempted: new Set<string>(),
    steps: [],
    retainControl: false,
  };
  let requested: string[] = [];
  let snapshots = new Map<string, ReturnType<typeof snapshot>>();
  let root = input.cwd;
  let control: string | undefined;
  let completed = false;
  let validated = false;
  let exitCode = 2;
  let failure: string | undefined;
  let deadline = Number.POSITIVE_INFINITY;
  try {
    assertRuntime();
    const window = cleanupWindow(input, started);
    const signal = window.signal;
    deadline = window.deadline;
    remaining(signal, deadline);
    root = fs.realpathSync.native(input.cwd);
    const selected = selectFiles(input, root, signal, deadline);
    requested = selected.files;
    snapshots = selected.snapshots;
    validated = true;
    const config = cleanupConfig(input, root);
    control = fs.mkdtempSync(path.join(outsideTemporaryRoot(root), "stack-cleanup-"));
    const ignore = path.join(control, "empty.ignore");
    fs.writeFileSync(ignore, "", { flag: "wx", mode: 0o600 });
    exitCode = await stabilizeCleanup(
      { config, ignore, files: requested, root, signal, deadline },
      evidence,
    );
    completed = exitCode === 0;
    remaining(signal, deadline);
  } catch (error) {
    failure = failureMessage(error);
    exitCode = 2;
    completed = false;
  } finally {
    if (control !== undefined && !evidence.retainControl) {
      try {
        fs.unlinkSync(path.join(control, "empty.ignore"));
        fs.rmdirSync(control);
      } catch {
        evidence.retainControl = true;
        failure ??= "TOOLCHAIN_CLEANUP_CONTROL";
        exitCode = 2;
        completed = false;
      }
    }
  }
  const observation = changedFiles(root, snapshots, input.signal, deadline);
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
      attempted: [...evidence.attempted],
      changed: observation.changed,
      completed,
      sourceObservationComplete: validated && observation.complete && !evidence.retainControl,
      steps: evidence.steps,
      ...(failure === undefined ? {} : { failure }),
      ...(evidence.retainControl ? { retainedControlDirectory: control! } : {}),
    },
  };
}
