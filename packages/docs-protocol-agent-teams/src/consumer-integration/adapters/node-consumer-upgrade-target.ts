import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";

interface ProcessResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

type Execute = (
  executable: string,
  args: readonly string[],
  cwd: string,
  allowedExitCodes?: readonly number[]
) => Promise<ProcessResult>;

function parseExecution(result: ProcessResult): Record<string, unknown> {
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  throw new ConsumerIntegrationNodeError(
    "DOCS_CONSUMER_UPGRADE_TARGET_INVALID",
    "Target Docs Protocol CLI did not return one JSON execution envelope."
  );
}

async function invoke(
  root: string,
  args: readonly string[],
  execute: Execute,
  owner: "managed-target" | "historical-source" = "managed-target"
) {
  const packageName = owner === "historical-source" ? "docs-protocol" : "docs-protocol-agent-teams";
  const cli = join(root, "node_modules", "@agent-teams", packageName, "dist", "cli.js");
  const metadata = await lstat(cli);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_TARGET_INVALID",
      "Installed target Docs Protocol CLI is not one regular package file."
    );
  }
  const result = await execute(
    process.execPath,
    [cli, ...args, "--consumer", root, "--json"],
    root,
    [0, 1]
  );
  const execution = parseExecution(result);
  if (result.code !== 0 && ["current", "applied"].includes(String(execution["outcome"]))) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_TARGET_INVALID",
      "An installed CLI with a nonzero exit cannot report successful activation."
    );
  }
  return execution;
}

export async function assertInstalledIntegrationCurrent(
  root: string,
  execute: Execute
): Promise<void> {
  if ((await invoke(root, ["check"], execute))["outcome"] !== "current") {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_TARGET_BLOCKED",
      "Target Docs Protocol check did not converge in the disposable repository."
    );
  }
}

export async function assertInstalledHistoricalIntegrationCurrent(
  root: string,
  execute: Execute
): Promise<void> {
  const result = await invoke(root, ["consumer", "check"], execute, "historical-source");
  if (result["outcome"] !== "current") {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_SOURCE_NOT_CURRENT",
      "Restored historical Docs Protocol check did not converge."
    );
  }
}

export async function applyTargetIntegration(
  root: string,
  cohortId: string,
  execute: Execute
): Promise<void> {
  const plan = await invoke(root, ["plan", "--to", cohortId], execute);
  if (plan["outcome"] === "change-required") {
    const value = plan["plan"];
    const digest = typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)["planDigest"] : undefined;
    if (typeof digest !== "string") {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UPGRADE_TARGET_INVALID",
        "Target Docs Protocol Plan did not expose one exact digest."
      );
    }
    const applied = await invoke(root, ["apply", "--expect", digest], execute);
    if (applied["outcome"] !== "applied" && applied["outcome"] !== "current") {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UPGRADE_TARGET_BLOCKED",
        "Target Docs Protocol apply did not converge in the disposable repository."
      );
    }
  } else if (plan["outcome"] !== "current") {
    const issues = Array.isArray(plan["issues"])
      ? JSON.stringify(plan["issues"]).slice(0, 4000) : "no bounded issue detail";
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_TARGET_BLOCKED",
      `Target Docs Protocol rejected the projected Cohort in the disposable repository: ${issues}`
    );
  }
  await assertInstalledIntegrationCurrent(root, execute);
}
