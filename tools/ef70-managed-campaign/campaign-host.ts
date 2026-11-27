import assert from "node:assert/strict";
import { row, text, type Row } from "./campaign-io.ts";

/** Admits actual caller identity and the recorded nonsecret environment selection. */
export function hostedEnvironment(bootstrap: Row): {
  environment: NodeJS.ProcessEnv;
  harnessRevision: string;
} {
  assert.equal(process.env["GITHUB_ACTIONS"], "true");
  assert.equal(process.env["GITHUB_REPOSITORY"], "agent-teams-ai/extension-foundation");
  assert.equal(process.env["GITHUB_REPOSITORY_ID"], "1333298097");
  assert.equal(process.env["GITHUB_REF"], "refs/heads/docs/coordinated-module-foundation-20261126");
  assert.equal(process.env["GITHUB_EVENT_NAME"], "push");
  assert.equal(bootstrap["hostRepository"], process.env["GITHUB_REPOSITORY"]);
  assert.equal(String(bootstrap["hostRepositoryId"]), process.env["GITHUB_REPOSITORY_ID"]);
  assert.equal(bootstrap["hostRevision"], process.env["GITHUB_SHA"]);
  const harnessRevision = text(bootstrap["harnessRevision"], "actual producer harness revision");
  assert(/^[0-9a-f]{40}$/u.test(harnessRevision) && harnessRevision !== "0".repeat(40));
  assert.equal(harnessRevision, process.env["EF70_HARNESS_REVISION"]);
  const selectedEnvironment = row(bootstrap["environment"], "explicit environment");
  const permitted = new Set([
    "PATH",
    "COREPACK_HOME",
    "pnpm_config_store_dir",
    "TMPDIR",
    "npm_config_cache",
    "PNPM_MAX_WORKERS",
    "NODE_OPTIONS",
    "EF70_CAMPAIGN_ROOT",
    "EF70_COMPILER_GUARD_LOG",
    "AGENT_TEAMS_DOCS_UPGRADE_NODE24_EXECUTABLE",
    "AGENT_TEAMS_DOCS_UPGRADE_NODE26_EXECUTABLE",
    "AGENT_TEAMS_DOCS_UPGRADE_COREPACK_ENTRYPOINT",
  ]);
  const selected: Record<string, string> = {};
  for (const [key, value] of Object.entries(selectedEnvironment)) {
    assert(permitted.has(key), `Unexpected recorded environment key: ${key}`);
    selected[key] = text(value, key);
  }
  return { environment: { ...process.env, ...selected }, harnessRevision };
}
