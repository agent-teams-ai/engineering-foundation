import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const INTEGRITY = `sha512-${"A".repeat(86)}==`;
export const decode = (value: string) => Buffer.from(value, "base64");
export function upgradedManifest(base64: string) {
  let source = decode(base64).toString("utf8");
  for (const [name, previous, next] of [
    ["@agent-teams/docs-protocol", "0.1.0-rc.1", "0.2.0-rc.0"],
    ["@agent-teams/engineering-foundation", "0.17.0-rc.0", "0.18.0-rc.0"],
  ]) {
    const before = `"${name}": "${previous}"`;
    assert.equal(source.split(before).length - 1, 1, `${name} fixture pin`);
    source = source.replace(before, `"${name}": "${next}"`);
  }
  return Buffer.from(source, "utf8");
}

export function qualifiedLockfile(importerPaths: readonly string[]) {
  const nested = importerPaths
    .filter((path) => path !== ".")
    .map(
      (path) => `  '${path}':
    dependencies:
      unrelated:
        specifier: 1.2.3
        version: 1.2.3
`,
    )
    .join("");
  return `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      '@agent-teams/docs-protocol':
        specifier: 0.2.0-rc.0
        version: 0.2.0-rc.0
      '@agent-teams/engineering-foundation':
        specifier: 0.18.0-rc.0
        version: 0.18.0-rc.0
${nested}packages:
  '@agent-teams/docs-protocol@0.2.0-rc.0':
    resolution: {integrity: ${INTEGRITY}}
  '@agent-teams/engineering-foundation@0.18.0-rc.0':
    resolution: {integrity: ${INTEGRITY}}
snapshots:
  '@agent-teams/docs-protocol@0.2.0-rc.0':
    dependencies:
      '@agent-teams/engineering-foundation': 0.18.0-rc.0
  '@agent-teams/engineering-foundation@0.18.0-rc.0': {}
  unrelated@1.2.3: {}
`;
}

export function invoke(root: string, args: readonly string[]) {
  const {
    GITHUB_REPOSITORY: _repository,
    GITHUB_REPOSITORY_ID: _repositoryId,
    ...environment
  } = process.env;
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "..", "dist", "cli.js"), ...args, "--consumer", root, "--json"],
    { encoding: "utf8", env: environment },
  );
  return {
    status: result.status,
    stderr: result.stderr,
    envelope: JSON.parse(result.stdout) as {
      plan: { planDigest: string; outcome: string };
      outcome: string;
    },
  };
}

export function assertAppliedAndCurrent(root: string, planned: ReturnType<typeof invoke>) {
  const applied = invoke(root, ["apply", "--expect", planned.envelope.plan.planDigest]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.envelope.plan.outcome, "current");
  const checked = invoke(root, ["check"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.envelope.outcome, "current");
}
