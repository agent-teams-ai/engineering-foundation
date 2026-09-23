import { isAbsolute, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import {
  assertNotCancelled,
  type ManagedProcessExecutor, type ManagedProcessResult, type QualityToolSession
} from "../api.js";
import { parseOxlintDiagnostics, parseOxlintSelection } from "./oxlint-output.js";

export interface OxlintSessionInput {
  readonly consumerRoot: string;
  readonly nodeExecutable: string;
  readonly oxlintEntrypoint: string;
  readonly compilerEntrypoint: string;
  readonly configPath: string;
  readonly sourceRoots: readonly string[];
  readonly projects: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

function assertToolSuccess(result: ManagedProcessResult): void {
  if (result.exitCode !== 0 || result.signal !== null || result.stderr.trim().length !== 0) {
    throw new Error("Quality tool prerequisite failed; no valid execution evidence was produced.");
  }
}

// Windows limits a process command line to roughly 32K characters. Keep ample
// room for the executable, flags and environment while retaining explicit file
// selection. The same bound is used for selection and lint so both observations
// cover the identical source universe.
const MAX_SOURCE_ARGUMENT_LENGTH = 8_000;

function sourceBatches(paths: readonly string[]): readonly (readonly string[])[] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const path of paths) {
    if (path.length > MAX_SOURCE_ARGUMENT_LENGTH) { throw new Error("Quality source path exceeds the command argument limit."); }
    const nextLength = length + path.length + (batch.length === 0 ? 0 : 1);
    if (batch.length > 0 && nextLength > MAX_SOURCE_ARGUMENT_LENGTH) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(path);
    length += path.length + (batch.length === 1 ? 0 : 1);
  }
  if (batch.length > 0) { batches.push(batch); }
  return batches;
}

/** Entrypoints have already been bound to the pinned consumer toolchain by preparation. */
export function createOxlintSession(input: OxlintSessionInput, executor: ManagedProcessExecutor): QualityToolSession {
  const lintArgs = [input.oxlintEntrypoint, "--config", input.configPath,
    "--deny-warnings", "--disable-nested-config", "--no-ignore", "--threads", "1", "--format", "json"];
  const run = (args: readonly string[], signal?: AbortSignal) => executor.run({
    command: input.nodeExecutable, args, cwd: input.consumerRoot,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    timeoutMs: 120_000, strictUtf8: true, ...(signal === undefined ? {} : { signal })
  });
  const assertExplicitTargets = (): void => {
    if (input.sourceRoots.length === 0) {
      throw new Error("Quality tool received no explicit source targets; refusing cwd scan.");
    }
  };
  const runSourceBatches = async <T>(
    signal: AbortSignal | undefined,
    execute: (paths: readonly string[], signal?: AbortSignal) => Promise<T>
  ): Promise<readonly T[]> => {
    assertNotCancelled(signal);
    const results: T[] = [];
    for (const batch of sourceBatches(input.sourceRoots)) {
      assertNotCancelled(signal);
      const result = await execute(batch, signal);
      assertNotCancelled(signal);
      results.push(result);
    }
    return results;
  };
  return {
    async explicitUnknown() { throw new Error("Explicit unknown scan requires the consumer source reader."); },
    async select(signal) {
      assertExplicitTargets();
      const results = await runSourceBatches(signal, async (paths, batchSignal) => {
        const result = await run([...lintArgs, "--debug", "files", ...paths], batchSignal);
        assertToolSuccess(result);
        return parseOxlintSelection(result.stdout);
      });
      return [...new Set(results.flat())].toSorted();
    },
    async typeContext(signal) {
      const root = await realpath(input.consumerRoot);
      const paths = new Set<string>();
      for (const project of input.projects) {
        assertNotCancelled(signal);
        const result = await run([input.compilerEntrypoint, "--project", project,
          "--noEmit", "--incremental", "false", "--composite", "false", "--listFiles", "--pretty", "false"], signal);
        assertNotCancelled(signal);
        assertToolSuccess(result);
        for (const line of result.stdout.trim().split(/\r?\n/u)) {
          if (!isAbsolute(line)) { throw new Error("Compiler returned malformed project evidence."); }
          // Compiler output and consumer cwd can name different aliases of the same root.
          const path = relative(root, await realpath(line)).split(sep).join("/");
          if (path !== ".." && !path.startsWith("../") && !isAbsolute(path) && !path.startsWith("node_modules/")) {
            paths.add(path);
          }
        }
      }
      return [...paths].toSorted();
    },
    async lint(signal) {
      assertExplicitTargets();
      const results = await runSourceBatches(signal, async (paths, batchSignal) => {
        const result = await run([...lintArgs, ...paths], batchSignal);
        if (result.signal !== null || result.stderr.trim().length !== 0) {
          throw new Error("Oxlint did not produce valid lint evidence.");
        }
        return parseOxlintDiagnostics(result.stdout, result.exitCode);
      });
      return {
        files: results.reduce((total, result) => total + result.files, 0),
        diagnostics: results.flatMap((result) => result.diagnostics)
      };
    }
  };
}
