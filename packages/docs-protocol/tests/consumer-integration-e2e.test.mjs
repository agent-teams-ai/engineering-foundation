import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  applyConsumerIntegration,
  checkConsumerIntegration,
  describeCanonicalConsumerAssets,
  planNodeConsumerIntegration
} from "../dist/consumer-integration/index.js";

function cohort() {
  const provisional = {
    schemaVersion: 1,
    cohortId: "docs-2026-08-16-rc1",
    channel: "rc",
    packages: {
      docsProtocol: { version: "0.2.0-rc.0", integrity: "sha512-ZG9jcw==" },
      engineeringFoundation: { version: "0.18.0-rc.0", integrity: "sha512-Zm91bmRhdGlvbg==" }
    },
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: "1".repeat(40),
      blobSha: "2".repeat(40)
    },
    assets: {
      skillDigest: `sha256:${"0".repeat(64)}`,
      callerWorkflowDigest: `sha256:${"0".repeat(64)}`
    },
    schemas: { consumerIntegration: 1, managedState: 1, docsProtocol: 1 },
    runtime: { node: ">=24.18.0 <25", pnpm: ">=11.17.0 <12" }
  };
  return { ...provisional, assets: describeCanonicalConsumerAssets(provisional) };
}

function sandboxRepository() {
  return {
    id: process.env.GITHUB_REPOSITORY_ID ?? "999999999",
    nameWithOwner: process.env.GITHUB_REPOSITORY ?? "agent-teams-ai/docs-protocol-sandbox"
  };
}

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "docs-consumer-e2e-"));
  await mkdir(join(root, "architecture", "foundation"), { recursive: true });
  const scripts = Object.fromEntries(
    ["check", "doctor", "find", "info", "new", "recover"].map((command) => [
      `docs:${command}`,
      `agent-teams-docs ${command} --consumer . --profile architecture/foundation/docs-protocol.yaml`
    ])
  );
  const manifest = {
    name: "sandbox-consumer",
    private: true,
    packageManager: "pnpm@11.20.0",
    scripts,
    devDependencies: {
      "@agent-teams/docs-protocol": "0.2.0-rc.0",
      "@agent-teams/engineering-foundation": "0.18.0-rc.0"
    },
    untouched: { keep: true }
  };
  const desired = {
    schemaVersion: 1,
    repository: {
      provider: "github",
      ...sandboxRepository()
    },
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    cohort: cohort()
  };
  await Promise.all([
    writeFile(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(root, "pnpm-lock.yaml"), `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      '@agent-teams/docs-protocol':
        specifier: 0.2.0-rc.0
        version: 0.2.0-rc.0(supports-color@8.1.1)
      '@agent-teams/engineering-foundation':
        specifier: 0.18.0-rc.0
        version: 0.18.0-rc.0(supports-color@8.1.1)
packages:
  '@agent-teams/docs-protocol@0.2.0-rc.0':
    resolution:
      integrity: sha512-ZG9jcw==
  '@agent-teams/engineering-foundation@0.18.0-rc.0':
    resolution:
      integrity: sha512-Zm91bmRhdGlvbg==
snapshots:
  '@agent-teams/docs-protocol@0.2.0-rc.0(supports-color@8.1.1)':
    dependencies:
      '@agent-teams/engineering-foundation': 0.18.0-rc.0(supports-color@8.1.1)
  '@agent-teams/engineering-foundation@0.18.0-rc.0(supports-color@8.1.1)': {}
`),
    writeFile(join(root, "AGENTS.md"), "# Sandbox agents\n"),
    writeFile(
      join(root, "architecture", "foundation", "docs-consumer-integration.json"),
      `${JSON.stringify(desired, null, 2)}\n`
    )
  ]);
  return root;
}

test("plans, applies, verifies, and repeats the full consumer lifecycle offline", async () => {
  const root = await sandbox();
  const protectedPaths = [
    "package.json",
    "pnpm-lock.yaml",
    "architecture/foundation/docs-consumer-integration.json"
  ];
  const before = await Promise.all(protectedPaths.map(async (path) => ({
    path,
    bytes: await readFile(join(root, path)),
    mtimeNs: (await stat(join(root, path), { bigint: true })).mtimeNs
  })));
  const checked = await checkConsumerIntegration({ consumerRoot: root });
  assert.equal(checked.outcome, "change-required");
  const planned = await planNodeConsumerIntegration({
    consumerRoot: root,
    to: cohort().cohortId
  });
  assert.equal(planned.outcome, "change-required");
  assert.equal(planned.plan.planDigest, checked.plan.planDigest);
  for (const evidence of before) {
    assert.deepEqual(await readFile(join(root, evidence.path)), evidence.bytes);
    assert.equal((await stat(join(root, evidence.path), { bigint: true })).mtimeNs, evidence.mtimeNs);
  }
  const stale = await applyConsumerIntegration({
    consumerRoot: root,
    expect: `sha256:${"0".repeat(64)}`
  });
  assert.equal(stale.outcome, "blocked");
  assert.equal(stale.issues[0].code, "DOCS_CONSUMER_STALE_PLAN");
  const applied = await applyConsumerIntegration({
    consumerRoot: root,
    expect: planned.plan.planDigest
  });
  assert.equal(applied.outcome, "applied");
  assert.equal(applied.plan.outcome, "current");
  const packageAfter = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.deepEqual(packageAfter.untouched, { keep: true });
  assert.deepEqual(
    await readFile(join(root, "pnpm-lock.yaml")),
    before.find(({ path }) => path === "pnpm-lock.yaml").bytes
  );
  assert.match(await readFile(join(root, "AGENTS.md"), "utf8"), /agent-teams-docs:route\/v1/u);
  const second = await applyConsumerIntegration({
    consumerRoot: root,
    expect: planned.plan.planDigest
  });
  assert.equal(second.outcome, "blocked");
  assert.equal(second.issues[0].code, "DOCS_CONSUMER_STALE_PLAN");
  const currentPlan = await planNodeConsumerIntegration({
    consumerRoot: root,
    to: cohort().cohortId
  });
  const managedMtimes = await Promise.all(currentPlan.plan.assets.map(async ({ path }) => ({
    path,
    mtimeNs: (await stat(join(root, path), { bigint: true })).mtimeNs
  })));
  const replay = await applyConsumerIntegration({
    consumerRoot: root,
    expect: currentPlan.plan.planDigest
  });
  assert.equal(replay.outcome, "current");
  for (const evidence of managedMtimes) {
    assert.equal((await stat(join(root, evidence.path), { bigint: true })).mtimeNs, evidence.mtimeNs);
  }

  const cli = spawnSync(process.execPath, [
    join(import.meta.dirname, "..", "dist", "cli.js"),
    "consumer", "check", "--consumer", root, "--json"
  ], { encoding: "utf8", env: { ...process.env, NO_PROXY: "*" } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, "");
  assert.equal(JSON.parse(cli.stdout).outcome, "current");

  const wrongRepository = spawnSync(process.execPath, [
    join(import.meta.dirname, "..", "dist", "cli.js"),
    "consumer", "check", "--consumer", root, "--json"
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: sandboxRepository().nameWithOwner,
      GITHUB_REPOSITORY_ID: "123",
      NO_PROXY: "*"
    }
  });
  assert.equal(wrongRepository.status, 2, wrongRepository.stderr);
  assert.equal(
    JSON.parse(wrongRepository.stdout).issues[0].code,
    "DOCS_CONSUMER_REPOSITORY_ID_MISMATCH"
  );
});
