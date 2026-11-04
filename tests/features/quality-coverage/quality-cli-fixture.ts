import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { QualityCoverageProfile } from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";
export { qualityFixtureReport as qualityReport } from "../../../scripts/quality-command-report.ts";

export type QualityFixtureProfile = Omit<QualityCoverageProfile, "compilerProjects">;

export interface QualityCliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type QualityFixturePut = (path: string, value: unknown) => Promise<void>;
export type QualityTextPut = (path: string, value: string) => Promise<void>;
export type QualityCliInvoke = (
  args: readonly string[],
  consumerRoot?: string,
) => Promise<QualityCliResult>;

/** Process failures are evidence only when the actual child returned JSON output. */
export async function runQualityCli(
  cli: string,
  consumerRoot: string,
  args: readonly string[],
): Promise<QualityCliResult> {
  try {
    return {
      code: 0,
      ...(await promisify(execFile)(
        process.execPath,
        [cli, ...args, "--consumer", consumerRoot, "--format", "json"],
        { cwd: consumerRoot, timeout: 30_000, maxBuffer: 1024 * 1024 },
      )),
    };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      typeof error.code !== "number" ||
      !("stdout" in error) ||
      typeof error.stdout !== "string" ||
      !("stderr" in error) ||
      typeof error.stderr !== "string"
    ) {
      throw error;
    }
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}
