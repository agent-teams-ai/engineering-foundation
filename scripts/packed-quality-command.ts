import { runCommand } from "./pack-test-support.mjs";
import { qualityFixtureRecord } from "./quality-command-report.ts";
import assert from "node:assert/strict";

export async function runQualityCommand(
  args: readonly string[],
  root: string,
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  try {
    const value: unknown = await runCommand(process.execPath, [...args], root);
    const result = qualityFixtureRecord(value);
    const stdout = result["stdout"];
    const stderr = result["stderr"];
    assert.ok(typeof stdout === "string" && typeof stderr === "string");
    return { code: 0, stdout, stderr };
  } catch (error) {
    const result = qualityFixtureRecord(error);
    const code = result["code"];
    const stdout = result["stdout"];
    const stderr = result["stderr"];
    if (
      typeof code !== "number" ||
      !Number.isInteger(code) ||
      typeof stdout !== "string" ||
      typeof stderr !== "string"
    ) {
      throw error;
    }
    return { code, stdout, stderr };
  }
}
