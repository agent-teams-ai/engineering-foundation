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
import { loadPackageConsumerAssetCatalog } from
  "../dist/consumer-integration/adapters/package-consumer-asset-catalog.js";
import {
  canonicalManagedRoute,
  canonicalManagedState,
  digestBytes
} from "../dist/consumer-integration/application/policies/consumer-integration-assets.js";

const INTEGRITY = `sha512-${"A".repeat(86)}==`;

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
      callerWorkflowDigest: `sha256:${"0".repeat(64)}`
    },
    schemas: { consumerIntegration: 1, managedState: 1, docsProtocol: 1 },
    runtime: {
      node: ">=24.18.0 <25", pnpm: ">=11.17.0 <12",
      runtimeClosureDigest: "sha256:a8d6c781ed2db0eddcb24f8b3a8e4a3e41b423a7f18a645e78e1c02f8d287293"
    }
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
  const initialized = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
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
    writeFile(join(root, ".node-version"), "24.18.0\n"),
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
  assert.equal(wrongRepository.status, 1, wrongRepository.stderr);
  assert.equal(
    JSON.parse(wrongRepository.stdout).issues[0].code,
    "DOCS_CONSUMER_REPOSITORY_ID_MISMATCH"
  );

  const duplicateJson = spawnSync(process.execPath, [
    join(import.meta.dirname, "..", "dist", "cli.js"),
    "consumer", "check", "--consumer", root, "--json", "--json"
  ], { encoding: "utf8", env: { ...process.env, NO_PROXY: "*" } });
  assert.equal(duplicateJson.status, 2, duplicateJson.stderr);
  assert.equal(JSON.parse(duplicateJson.stdout).issues[0].code, "DOCS_CONSUMER_CLI_INVALID");

  const invalidFlag = spawnSync(process.execPath, [
    join(import.meta.dirname, "..", "dist", "cli.js"),
    "consumer", "check", "--consumer", root, "--unknown", "--json"
  ], { encoding: "utf8", env: { ...process.env, NO_PROXY: "*" } });
  assert.equal(invalidFlag.status, 2, invalidFlag.stderr);
  assert.equal(JSON.parse(invalidFlag.stdout).issues[0].code, "DOCS_CONSUMER_CLI_INVALID");

  const missingRoot = spawnSync(process.execPath, [
    join(import.meta.dirname, "..", "dist", "cli.js"),
    "consumer", "check", "--consumer", join(root, "missing"), "--json"
  ], { encoding: "utf8", env: { ...process.env, NO_PROXY: "*" } });
  assert.equal(missingRoot.status, 3, missingRoot.stderr);
  const missingRootIssue = JSON.parse(missingRoot.stdout).issues[0];
  assert.equal(missingRootIssue.code, "DOCS_CONSUMER_EXECUTION_FAILURE");
  assert.doesNotMatch(missingRootIssue.message, new RegExp(root.replaceAll("/", "\\/"), "u"));

  await mkdir(join(root, "nested"));
  await assert.rejects(
    checkConsumerIntegration({ consumerRoot: join(root, "nested") }),
    (error) => error?.code === "DOCS_CONSUMER_GIT_ROOT_INVALID"
  );
  await mkdir(join(root, "packages", "nested"), { recursive: true });
  await writeFile(join(root, "packages", "nested", "AGENTS.md"), "# Nested\n");
  await assert.rejects(
    checkConsumerIntegration({ consumerRoot: root }),
    (error) => error?.code === "DOCS_CONSUMER_NESTED_AGENTS_UNSUPPORTED"
  );
  const integrationProfilePath = join(
    root,
    "architecture",
    "foundation",
    "docs-consumer-integration.json"
  );
  const scoped = JSON.parse(await readFile(integrationProfilePath, "utf8"));
  scoped.governedDocsRoots = ["docs"];
  await writeFile(integrationProfilePath, `${JSON.stringify(scoped, null, 2)}\n`);
  assert.equal((await checkConsumerIntegration({ consumerRoot: root })).outcome, "current");
});

test("upgrades exact qualified rc9 assets through the package-owned bundle", async () => {
  const root = await sandbox();
  const catalog = await loadPackageConsumerAssetCatalog();
  const prior = catalog.directTargetBundles.find((entry) =>
    entry.cohort.cohortId === "docs-2026-08-17-rc9"
  );
  assert.ok(prior);

  const profilePath = join(root, "architecture", "foundation", "docs-consumer-integration.json");
  const target = JSON.parse(await readFile(profilePath, "utf8"));
  target.cohort = {
    ...target.cohort,
    cohortId: "docs-2026-08-18-rc1",
    upgradeFrom: [prior.cohort.cohortId]
  };
  target.cohort.assets = describeCanonicalConsumerAssets(target.cohort);
  const priorDesired = { ...target, cohort: prior.cohort };
  const priorState = canonicalManagedState(priorDesired, {
    skillDigest: digestBytes(prior.skill),
    callerWorkflowDigest: digestBytes(prior.callerWorkflow),
    assetCatalogDigest: prior.cohort.assets.assetCatalogDigest,
    transitionCatalogDigest: prior.cohort.assets.transitionCatalogDigest,
    agentsRouteDigest: prior.agentsRouteDigest,
    docsScriptsDigest: prior.docsScriptsDigest
  });

  await Promise.all([
    mkdir(join(root, ".agents", "skills", "docs-authoring"), { recursive: true }),
    mkdir(join(root, ".github", "workflows"), { recursive: true }),
    writeFile(profilePath, `${JSON.stringify(target, null, 2)}\n`),
    writeFile(join(root, "AGENTS.md"), `# Agents\n\n${canonicalManagedRoute(target.skillPath)}\n`),
    writeFile(join(root, target.managedStatePath), priorState)
  ]);
  await Promise.all([
    writeFile(join(root, target.skillPath), prior.skill),
    writeFile(join(root, target.callerWorkflowPath), prior.callerWorkflow)
  ]);

  await writeFile(join(root, target.callerWorkflowPath), Buffer.concat([
    Buffer.from(prior.callerWorkflow),
    Buffer.from("# tampered\n")
  ]));
  const blocked = await planNodeConsumerIntegration({
    consumerRoot: root,
    to: target.cohort.cohortId
  });
  assert.equal(blocked.outcome, "blocked");
  assert.ok(blocked.plan.issues.some(({ code }) => code === "DOCS_CONSUMER_UNKNOWN_MANAGED_ASSET"));

  await writeFile(join(root, target.callerWorkflowPath), prior.callerWorkflow);
  const planned = await planNodeConsumerIntegration({
    consumerRoot: root,
    to: target.cohort.cohortId
  });
  assert.equal(planned.outcome, "change-required");
  assert.deepEqual(planned.plan.issues, []);
  const applied = await applyConsumerIntegration({
    consumerRoot: root,
    expect: planned.plan.planDigest
  });
  assert.equal(applied.outcome, "applied");
  assert.equal(applied.plan.outcome, "current");
});

test("keeps the public plan byte-free and fails stale profile authority before mutation", async () => {
  const root = await sandbox();
  const planned = await planNodeConsumerIntegration({
    consumerRoot: root,
    to: cohort().cohortId
  });
  const agentsBefore = await readFile(join(root, "AGENTS.md"));
  const serialized = JSON.stringify(planned);
  assert.doesNotMatch(serialized, /mutationPlan|acceptedPreimages|contentBase64/u);
  assert.ok(Buffer.byteLength(serialized) < 64 * 1024);
  const profilePath = join(root, "architecture", "foundation", "docs-consumer-integration.json");
  await writeFile(profilePath, `${await readFile(profilePath, "utf8")}x`);
  await assert.rejects(
    applyConsumerIntegration({ consumerRoot: root, expect: planned.plan.planDigest })
  );
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), agentsBefore);
  await assert.rejects(readFile(join(root, ".agents", "skills", "docs-authoring", "SKILL.md")), /ENOENT/u);
});

test("fails closed for nested integration units, lockfiles, pnpmfile hooks, and non-dev pins", async () => {
  const nestedLock = await sandbox();
  await writeFile(join(nestedLock, ".gitignore"), "packages/\n");
  await mkdir(join(nestedLock, "packages", "app"), { recursive: true });
  await writeFile(join(nestedLock, "packages", "app", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await assert.rejects(
    checkConsumerIntegration({ consumerRoot: nestedLock }),
    (error) => error?.code === "DOCS_CONSUMER_NESTED_LOCKFILE_UNSUPPORTED"
  );

  const secondProfile = await sandbox();
  await mkdir(join(secondProfile, "packages", "app", "architecture", "foundation"), { recursive: true });
  await writeFile(
    join(secondProfile, "packages", "app", "architecture", "foundation", "docs-consumer-integration.json"),
    "{}\n"
  );
  await assert.rejects(
    checkConsumerIntegration({ consumerRoot: secondProfile }),
    (error) => error?.code === "DOCS_CONSUMER_MULTIPLE_INTEGRATION_UNITS"
  );

  const pnpmfile = await sandbox();
  await writeFile(join(pnpmfile, ".pnpmfile.cjs"), "module.exports = {};\n");
  await assert.rejects(
    checkConsumerIntegration({ consumerRoot: pnpmfile }),
    (error) => error?.code === "DOCS_CONSUMER_PNPMFILE_UNSUPPORTED"
  );

  const optionalPin = await sandbox();
  const manifestPath = join(optionalPin, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.optionalDependencies = { "@agent-teams/docs-protocol": "0.2.0-rc.0" };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const checked = await checkConsumerIntegration({ consumerRoot: optionalPin });
  assert.equal(checked.outcome, "blocked");
  assert.ok(checked.issues.some(({ code }) => code === "DOCS_CONSUMER_NON_DEV_DEPENDENCY"));
});

test("accepts a registry-bound consumer transitive while preserving exact cohort roots", async () => {
  const root = await sandbox();
  const lockPath = join(root, "pnpm-lock.yaml");
  const source = await readFile(lockPath, "utf8");
  const changed = source
    .replace("snapshots:\n", `  transitive-runtime@1.0.0:\n    resolution:\n      integrity: sha512-${"B".repeat(86)}==\nsnapshots:\n`)
    .replace(
      "      '@agent-teams/engineering-foundation': 0.18.0-rc.0(supports-color@8.1.1)\n",
      "      '@agent-teams/engineering-foundation': 0.18.0-rc.0(supports-color@8.1.1)\n      transitive-runtime: 1.0.0\n"
    )
    .replace(
      "  '@agent-teams/engineering-foundation@0.18.0-rc.0(supports-color@8.1.1)': {}\n",
      "  '@agent-teams/engineering-foundation@0.18.0-rc.0(supports-color@8.1.1)': {}\n  transitive-runtime@1.0.0: {}\n"
  );
  await writeFile(lockPath, changed);
  assert.equal((await checkConsumerIntegration({ consumerRoot: root })).outcome, "change-required");

  await writeFile(lockPath, changed.replace(
    "      transitive-runtime: 1.0.0\n",
    "      transitive-runtime: file:vendor/transitive-runtime\n"
  ));
  await assert.rejects(
    checkConsumerIntegration({ consumerRoot: root }),
    (error) => error?.code === "DOCS_CONSUMER_RUNTIME_CLOSURE_MISMATCH"
  );
});

test("commits only immutable Cohort binding evidence", async () => {
  const root = await sandbox();
  const planned = await planNodeConsumerIntegration({ consumerRoot: root, to: cohort().cohortId });
  await applyConsumerIntegration({ consumerRoot: root, expect: planned.plan.planDigest });
  const state = JSON.parse(await readFile(
    join(root, "architecture", "foundation", "docs-protocol-managed-state.json"),
    "utf8"
  ));
  assert.equal(Object.hasOwn(state.cohortAuthority, "lifecycleState"), false);
  assert.equal(Object.hasOwn(state, "canaryRepositoryIds"), false);

  const profilePath = join(root, "architecture", "foundation", "docs-consumer-integration.json");
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  profile.cohort.lifecycleState = "RECOMMENDED";
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  await assert.rejects(checkConsumerIntegration({ consumerRoot: root }), /additional properties/u);
});
