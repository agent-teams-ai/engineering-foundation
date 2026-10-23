export const INTEGRITY = `sha512-${"A".repeat(86)}==`;
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
export function sandboxRepository() {
  return {
    id: process.env.GITHUB_REPOSITORY_ID ?? "999999999",
    nameWithOwner: process.env.GITHUB_REPOSITORY ?? "agent-teams-ai/docs-protocol-sandbox",
  };
}

export async function createConsumerSandbox(cohortValue: unknown) {
  const root = await mkdtemp(join(tmpdir(), "docs-consumer-e2e-"));
  const initialized = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  await mkdir(join(root, "architecture", "foundation"), { recursive: true });
  const scripts = Object.fromEntries(
    ["check", "doctor", "find", "info", "new", "recover"].map((command) => [
      `docs:${command}`,
      `agent-teams-docs ${command} --consumer . --profile architecture/foundation/docs-protocol.yaml`,
    ]),
  );
  const manifest = {
    name: "sandbox-consumer",
    private: true,
    packageManager: "pnpm@11.20.0",
    scripts,
    devDependencies: {
      "@agent-teams/docs-protocol": "0.2.0-rc.0",
      "@agent-teams/engineering-foundation": "0.18.0-rc.0",
    },
    untouched: { keep: true },
  };
  const desired = {
    schemaVersion: 1,
    repository: {
      provider: "github",
      ...sandboxRepository(),
    },
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    cohort: cohortValue,
  };
  await Promise.all([
    writeFile(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(root, ".node-version"), "24.18.0\n"),
    writeFile(
      join(root, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      '@agent-teams/docs-protocol':
        specifier: 0.2.0-rc.0
        version: 0.2.0-rc.0(supports-color@8.1.1)
      '@agent-teams/engineering-foundation':
        specifier: 0.18.0-rc.0
        version: 0.18.0-rc.0(supports-color@8.1.1)
  packages/platform-app:
    dependencies:
      unrelated:
        specifier: 1.2.3
        version: 1.2.3
packages:
  '@agent-teams/docs-protocol@0.2.0-rc.0':
    resolution:
      integrity: ${INTEGRITY}
  '@agent-teams/engineering-foundation@0.18.0-rc.0':
    resolution:
      integrity: ${INTEGRITY}
snapshots:
  '@agent-teams/docs-protocol@0.2.0-rc.0(supports-color@8.1.1)':
    dependencies:
      '@agent-teams/engineering-foundation': 0.18.0-rc.0(supports-color@8.1.1)
  '@agent-teams/engineering-foundation@0.18.0-rc.0(supports-color@8.1.1)': {}
`,
    ),
    writeFile(join(root, "AGENTS.md"), "# Sandbox agents\n"),
    writeFile(
      join(root, "architecture", "foundation", "docs-consumer-integration.json"),
      `${JSON.stringify(desired, null, 2)}\n`,
    ),
  ]);
  return root;
}
