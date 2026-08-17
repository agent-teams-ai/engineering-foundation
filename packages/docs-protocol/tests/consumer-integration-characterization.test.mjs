import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  describeCanonicalConsumerAssets,
  planConsumerIntegration
} from "../dist/consumer-integration/index.js";

const shapes = JSON.parse(await readFile(
  join(import.meta.dirname, "fixtures", "current-consumer-shapes.v1.json"),
  "utf8"
));

const absent = { state: "absent" };
const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const file = (bytes) => ({ state: "file", bytes, mode: 0o644 });
const decode = (value) => Buffer.from(value, "base64");

function cohort() {
  const provisional = {
    schemaVersion: 1,
    cohortId: "docs-2026-08-16-rc1",
    channel: "rc",
    recordDigest: `sha256:${"1".repeat(64)}`,
    qualificationEventDigest: `sha256:${"2".repeat(64)}`,
    eligibleAfter: "2026-08-16T00:00:00Z",
    upgradeFrom: [],
    rollbackTo: [],
    packages: {
      docsProtocol: { version: "0.2.0-rc.0", integrity: INTEGRITY },
      engineeringFoundation: { version: "0.18.0-rc.0", integrity: INTEGRITY }
    },
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: "1".repeat(40),
      blobSha: "2".repeat(40)
    },
    assets: {
      skillDigest: `sha256:${"0".repeat(64)}`,
      callerWorkflowDigest: `sha256:${"0".repeat(64)}`,
      assetCatalogDigest: `sha256:${"0".repeat(64)}`
    },
    schemas: { consumerIntegration: 1, managedState: 1, docsProtocol: 1 },
    runtime: {
      node: ">=24.18.0 <25", pnpm: ">=11.17.0 <12",
      runtimeClosureDigest: "sha256:09e935888b0ea01aa7dbfdc6101685ae9402a26a4e34fa8e124b40780cf0788a"
    }
  };
  return { ...provisional, assets: describeCanonicalConsumerAssets(provisional) };
}

function upgradedManifest(base64) {
  let source = decode(base64).toString("utf8");
  for (const [name, previous, next] of [
    ["@agent-teams/docs-protocol", "0.1.0-rc.1", "0.2.0-rc.0"],
    ["@agent-teams/engineering-foundation", "0.17.0-rc.0", "0.18.0-rc.0"]
  ]) {
    const before = `"${name}": "${previous}"`;
    assert.equal(source.split(before).length - 1, 1, `${name} fixture pin`);
    source = source.replace(before, `"${name}": "${next}"`);
  }
  return Buffer.from(source, "utf8");
}

function qualifiedLockfile(importerPaths) {
  const nested = importerPaths.filter((path) => path !== ".").map((path) => `  '${path}':
    dependencies:
      unrelated:
        specifier: 1.2.3
        version: 1.2.3
`).join("");
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

function invoke(root, args) {
  const { GITHUB_REPOSITORY: _repository, GITHUB_REPOSITORY_ID: _repositoryId, ...environment } = process.env;
  const result = spawnSync(process.execPath, [
    join(import.meta.dirname, "..", "dist", "cli.js"),
    "consumer",
    ...args,
    "--consumer",
    root,
    "--json"
  ], { encoding: "utf8", env: environment });
  return { status: result.status, stderr: result.stderr, envelope: JSON.parse(result.stdout) };
}

for (const shape of shapes.fixtures) {
  test(`characterizes and migrates ${shape.repository.nameWithOwner} without repo-specific compiler code`, async () => {
    const desired = {
      schemaVersion: 1,
      repository: shape.repository,
      integrationRoot: ".",
      packageManager: "pnpm",
      profilePath: "architecture/foundation/docs-protocol.yaml",
      skillPath: ".agents/skills/docs-authoring/SKILL.md",
      callerWorkflowPath: ".github/workflows/docs-protocol.yml",
      managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
      cohort: cohort()
    };
    const snapshot = {
      integrationProfile: file(Buffer.from("profile\n", "utf8")),
      lockfile: file(Buffer.from("lockfile\n", "utf8")),
      packageManifest: file(upgradedManifest(shape.files.packageJsonBase64)),
      agents: file(decode(shape.files.agentsBase64)),
      skill: file(decode(shape.files.skillBase64)),
      callerWorkflow: shape.callerKind === "standalone"
        ? file(decode(shape.files.callerWorkflowBase64))
        : absent,
      managedState: absent
    };
    const first = planConsumerIntegration({ desired, snapshot });
    const replay = planConsumerIntegration({ desired, snapshot });
    assert.deepEqual(replay, first);
    assert.equal(first.outcome, "change-required");
    assert.deepEqual(first.issues, []);
    assert.deepEqual(
      first.assets.filter(({ action }) => action !== "none").map(({ id, action }) => [id, action]),
      shape.callerKind === "standalone"
        ? [["skill", "replace"], ["caller-workflow", "replace"], ["agents-route", "replace"], ["managed-state", "create"]]
        : [["skill", "replace"], ["caller-workflow", "create"], ["agents-route", "replace"], ["managed-state", "create"]]
    );
    assert.equal(first.assets.find(({ id }) => id === "package-manifest").action, "none");
    assert.equal(first.assets.find(({ id }) => id === "skill").action, "replace");

    const root = await mkdtemp(join(tmpdir(), "docs-consumer-shape-e2e-"));
    assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
    await mkdir(join(root, "architecture", "foundation"), { recursive: true });
    await mkdir(join(root, ".agents", "skills", "docs-authoring"), { recursive: true });
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "package.json"), upgradedManifest(shape.files.packageJsonBase64)),
      writeFile(join(root, ".node-version"), "24.18.0\n"),
      writeFile(join(root, "pnpm-lock.yaml"), qualifiedLockfile(shape.lockImporterPaths)),
      writeFile(join(root, "AGENTS.md"), decode(shape.files.agentsBase64)),
      writeFile(join(root, ".agents", "skills", "docs-authoring", "SKILL.md"), decode(shape.files.skillBase64)),
      writeFile(
        join(root, "architecture", "foundation", "docs-consumer-integration.json"),
        `${JSON.stringify(desired, null, 2)}\n`
      ),
      ...(shape.callerKind === "standalone" ? [writeFile(
        join(root, ".github", "workflows", "docs-protocol.yml"),
        decode(shape.files.callerWorkflowBase64)
      )] : [])
    ]);
    const checked = invoke(root, ["check"]);
    assert.equal(checked.status, 1, checked.stderr);
    assert.equal(checked.envelope.outcome, "change-required");
    const planned = invoke(root, ["plan", "--to", desired.cohort.cohortId]);
    assert.equal(planned.status, 1, planned.stderr);
    assert.equal(planned.envelope.outcome, "change-required");
    const applied = invoke(root, ["apply", "--expect", planned.envelope.plan.planDigest]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.envelope.outcome, "applied");
    const current = invoke(root, ["check"]);
    assert.equal(current.status, 0, current.stderr);
    assert.equal(current.envelope.outcome, "current");
  });
}
