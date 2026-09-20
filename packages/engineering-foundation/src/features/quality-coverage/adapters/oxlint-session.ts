import { isAbsolute, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import type { QualityToolSession, ManagedProcessExecutor, ManagedProcessResult } from "../api.js";
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
    if (input.sourceRoots.length === 0) { throw new Error("Quality tool received no explicit source targets; refusing cwd scan."); }
  };
  return {
    async select(signal) {
      assertExplicitTargets();
      const result = await run([...lintArgs, "--debug", "files", ...input.sourceRoots], signal);
      assertToolSuccess(result);
      return parseOxlintSelection(result.stdout);
    },
    async typeContext(signal) {
      const root = await realpath(input.consumerRoot);
      const paths = new Set<string>();
      for (const project of input.projects) {
        const result = await run([input.compilerEntrypoint, "--project", project,
          "--noEmit", "--incremental", "false", "--composite", "false", "--listFiles", "--pretty", "false"], signal);
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
      const result = await run([...lintArgs, ...input.sourceRoots], signal);
      if (result.signal !== null || result.stderr.trim().length !== 0) {
        throw new Error("Oxlint did not produce valid lint evidence.");
      }
      return parseOxlintDiagnostics(result.stdout, result.exitCode);
    }
  };
}
