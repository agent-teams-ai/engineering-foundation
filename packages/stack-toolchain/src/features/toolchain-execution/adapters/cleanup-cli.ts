import { fixFiles, readCleanupDiagnostics, type CleanupReport } from "./cleanup-files.js";

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

function writeRemainingDiagnostics(report: CleanupReport): void {
  const checks = report.details.steps.filter((step) => step.operation === "check");
  const selected = checks.length > 0 ? checks : report.details.steps.slice(-1);
  for (const step of selected) {
    const diagnostics =
      step.tool === "oxlint" ? readCleanupDiagnostics(step.result.stdout) : undefined;
    if (diagnostics !== undefined) {
      for (const diagnostic of diagnostics) {
        process.stderr.write(
          `${diagnostic.filename}: ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`,
        );
      }
    } else if (step.result.exitCode !== 0 || report.details.failure !== undefined) {
      process.stderr.write(step.result.stdout + step.result.stderr);
    }
  }
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
    writeRemainingDiagnostics(report);
    if (report.exitCode !== 0) {
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
