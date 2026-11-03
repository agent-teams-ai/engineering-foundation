import { fixFiles } from "./cleanup-files.js";

/** Requiring -- keeps options distinct from the caller's literal file census. */
export function parseCleanupArguments(args: readonly string[]) {
  let json = false;
  let lintConfigPath: string | undefined;
  let files: readonly string[] | undefined;
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--") {
      files = args.slice(index + 1);
      break;
    }
    if (value === "--json" && !json) {
      json = true;
    } else if (
      value === "--lint-config" &&
      lintConfigPath === undefined &&
      args[index + 1] !== undefined &&
      args[index + 1] !== "" &&
      !args[index + 1]!.startsWith("-")
    ) {
      lintConfigPath = args[++index]!;
    } else {
      throw new Error(`TOOLCHAIN_UNKNOWN_ARGUMENT:${value}`);
    }
  }
  if (files === undefined || files.length === 0) {
    throw new Error("TOOLCHAIN_CLEANUP_FILES_REQUIRED");
  }
  return { json, files, ...(lintConfigPath === undefined ? {} : { lintConfigPath }) };
}

export async function runCleanupCli(args: readonly string[], signal: AbortSignal): Promise<number> {
  const { json, ...options } = parseCleanupArguments(args);
  const report = await fixFiles({ cwd: process.cwd(), signal, ...options });
  if (json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...report })}\n`);
  } else {
    process.stdout.write(
      `fix: ${report.details.completed ? "completed" : "incomplete"}; ${report.details.changed.length} file(s) changed\n`,
    );
    if (report.exitCode !== 0) {
      const last = report.details.steps.at(-1);
      if (last !== undefined) {
        process.stderr.write(last.result.stdout + last.result.stderr);
      }
      if (report.details.failure !== undefined) {
        process.stderr.write(`${report.details.failure}\n`);
      }
      if (report.details.retainedControlDirectory !== undefined) {
        process.stderr.write(`Retained controls: ${report.details.retainedControlDirectory}\n`);
      }
      process.stderr.write("Writes may be partial; inspect the diff. No files were rolled back.\n");
    }
  }
  return report.exitCode;
}
