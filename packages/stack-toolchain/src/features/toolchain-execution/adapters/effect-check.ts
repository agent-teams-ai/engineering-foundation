import fs from "node:fs/promises";
import path from "node:path";
import { devNull } from "node:os";
import {
  createProcessExecutor,
  isProcessRuntimeError,
  type ProcessExecutor,
  type ProcessRunResult,
} from "node-or-bun";
import { createNodeProcessAdapter } from "node-or-bun/node";
import { assertRuntime } from "./commands.js";
import { assertCompleteProcessResult } from "./process.js";
import {
  admitEffectCompiler,
  effectHash,
  effectLocalPath,
  effectSourceInventory,
  parseEffectJson,
  readEffectFile,
  type EffectNativeTool,
  type EffectLiveCheck,
} from "./effect-files.js";
import {
  EffectCheckFailure,
  classifyEffectOutput,
  effectInputs,
  requireEffect,
  validateEffectConfiguration,
  validateEffectPolicy,
  type EffectCheckInput,
  type EffectCheckReport,
  type EffectCheckOutcome,
  type EffectProjectResult,
  type EffectToolVersions,
} from "../application/effect-policy.js";

export interface EffectCheckDependencies {
  readonly platform: string;
  readonly arch: string;
  readonly now: () => number;
  readonly admit: (root: string, live: EffectLiveCheck) => Promise<EffectNativeTool>;
  readonly execute: ProcessExecutor["run"];
}
const executor = createProcessExecutor(createNodeProcessAdapter());
const dependencies: EffectCheckDependencies = {
  platform: process.platform,
  arch: process.arch,
  now: () => performance.now(),
  admit: admitEffectCompiler,
  execute: (request) => executor.run(request),
};

export async function checkEffectProjects(input: EffectCheckInput): Promise<EffectCheckReport> {
  return checkEffectProjectsWith(input, dependencies);
}

interface EffectProjectAttempt {
  readonly project: string;
  sourceFiles: readonly string[];
}

async function checkEffectProject(
  attempt: EffectProjectAttempt,
  filename: string,
  execution: {
    readonly root: string;
    readonly tool: EffectNativeTool;
    readonly live: EffectLiveCheck;
    readonly invoke: (args: readonly string[]) => Promise<ProcessRunResult>;
  },
): Promise<EffectProjectResult> {
  const { root, tool, live, invoke } = execution;
  const leaf = await readEffectFile(filename, 1024 * 1024, live);
  validateEffectPolicy(parseEffectJson(leaf));
  const config = await invoke(["--showConfig", "--pretty", "false", "--project", filename]);
  if (config.exitCode !== 0 || config.signal !== null || config.stderr !== "") {
    throw new EffectCheckFailure("invalid-input", "EFFECT_CONFIG_PROBE");
  }
  const roots: string[] = [];
  for (const file of validateEffectConfiguration(parseEffectJson(Buffer.from(config.stdout)))) {
    live();
    const requested = path.resolve(path.dirname(filename), file);
    const canonical = await effectLocalPath(root, requested);
    requireEffect(requested === canonical, "EFFECT_SOURCE_ROOT_ALIAS");
    roots.push(canonical);
  }
  const checkFlags = [
    "--noEmit",
    "--pretty",
    "false",
    "--incremental",
    "true",
    "--tsBuildInfoFile",
    devNull,
    "--project",
    filename,
  ];
  const listed = await invoke(["--listFilesOnly", ...checkFlags]);
  if (listed.exitCode !== 0 || listed.signal !== null || listed.stderr !== "") {
    throw new EffectCheckFailure("execution-failed", "EFFECT_SOURCE_PROBE");
  }
  const inventory = await effectSourceInventory(listed.stdout, root, roots, tool, live);
  attempt.sourceFiles = inventory.sourceFiles;
  const checked = await invoke(checkFlags);
  const result = classifyEffectOutput(checked);
  const snapshots: readonly (readonly [string, string])[] = [
    [filename, effectHash(leaf)],
    ...inventory.hashes,
  ];
  for (const [file, hash] of snapshots) {
    requireEffect(
      effectHash(await readEffectFile(file, 4 * 1024 * 1024, live)) === hash,
      "EFFECT_INPUT_CHANGED",
    );
  }
  return {
    project: attempt.project,
    ...result,
    sourceFiles: attempt.sourceFiles,
    stdout: checked.stdout,
    stderr: checked.stderr,
  };
}

export async function checkEffectProjectsWith(
  rawInput: EffectCheckInput,
  ports: EffectCheckDependencies,
): Promise<EffectCheckReport> {
  const started = ports.now();
  let input: Required<EffectCheckInput> | undefined;
  let versions: EffectToolVersions | null = null;
  const projects: EffectProjectResult[] = [];
  let activeProject: EffectProjectAttempt | undefined;
  let last: Pick<ProcessRunResult, "stdout" | "stderr"> = { stdout: "", stderr: "" };
  const report = (outcome: EffectCheckOutcome, reason?: string): EffectCheckReport => ({
    schemaVersion: 1,
    command: "effect:check",
    status: outcome === "passed" ? "passed" : "failed",
    exitCode:
      outcome === "passed" ? 0 : outcome === "diagnostics" ? 1 : outcome === "cancelled" ? 130 : 2,
    durationMs: ports.now() - started,
    versions,
    details: {
      outcome,
      selected: input?.projects ?? [],
      projects,
      unattempted:
        input?.projects.filter((project) => !projects.some((item) => item.project === project)) ??
        [],
      ...(reason === undefined ? {} : { reason, ...last }),
    },
  });
  try {
    input = effectInputs(rawInput);
    assertRuntime();
    const { signal: callerSignal, budgetMs } = input;
    const deadline = started + budgetMs;
    const live = (): void => {
      if (callerSignal.aborted) {
        throw new EffectCheckFailure("cancelled", "EFFECT_CANCELLED");
      }
      if (ports.now() >= deadline) {
        throw new EffectCheckFailure("execution-failed", "EFFECT_DEADLINE");
      }
    };
    live();
    if (ports.platform !== "linux" || ports.arch !== "x64") {
      throw new EffectCheckFailure("tool-unavailable", "EFFECT_UNSUPPORTED_PLATFORM");
    }
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(budgetMs)]);
    const root = await fs.realpath(input.cwd);
    requireEffect((await fs.stat(root)).isDirectory(), "EFFECT_ROOT");
    const tool = await ports.admit(root, live);
    versions = tool.versions;
    const invoke = async (args: readonly string[]): Promise<ProcessRunResult> => {
      live();
      const result = await ports.execute({
        command: tool.executable,
        args,
        cwd: root,
        signal,
        timeoutMs: Math.max(1, Math.floor(deadline - ports.now())),
        strictUtf8: true,
      });
      last = { stdout: result.stdout, stderr: result.stderr };
      assertCompleteProcessResult(result);
      live();
      return result;
    };
    const version = await invoke(["--version"]);
    if (
      version.exitCode !== 0 ||
      version.signal !== null ||
      version.stderr !== "" ||
      version.stdout.trim() !== tool.reportedVersion
    ) {
      throw new EffectCheckFailure("tool-incompatible", "EFFECT_REPORTED_VERSION");
    }
    const seenProjects = new Set<string>();
    for (const project of input.projects) {
      activeProject = { project, sourceFiles: [] };
      last = { stdout: "", stderr: "" };
      const filename = await effectLocalPath(root, path.join(root, project));
      requireEffect(!seenProjects.has(filename), "EFFECT_PROJECT_DUPLICATE");
      seenProjects.add(filename);
      projects.push(
        await checkEffectProject(activeProject, filename, { root, tool, live, invoke }),
      );
      activeProject = undefined;
    }
    live();
    return report(
      projects.some((project) => project.status === "diagnostics") ? "diagnostics" : "passed",
    );
  } catch (error) {
    if (isProcessRuntimeError(error) && error.output !== null) {
      last = error.output;
    }
    const outcome =
      input?.signal.aborted === true
        ? "cancelled"
        : error instanceof EffectCheckFailure
          ? error.outcome
          : "execution-failed";
    const reason =
      outcome === "cancelled"
        ? "EFFECT_CANCELLED"
        : isProcessRuntimeError(error)
          ? `EFFECT_PROCESS_${error.code.toUpperCase()}`
          : error instanceof Error
            ? error.message
            : "EFFECT_EXECUTION_FAILED";
    if (activeProject !== undefined) {
      projects.push({
        project: activeProject.project,
        status: "failed",
        sourceFiles: activeProject.sourceFiles,
        diagnosticCodes: [],
        ...last,
        reason,
      });
    }
    return report(outcome, reason);
  }
}
