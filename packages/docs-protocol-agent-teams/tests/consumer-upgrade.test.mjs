import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalCallerWorkflow,
  canonicalDocsScripts,
  canonicalDocsScriptsDigest,
  canonicalManagedRoute,
  canonicalManagedState,
  digestBytes
} from "../dist/consumer-integration/application/policies/consumer-integration-assets.js";
import {
  createConsumerUpgradeUseCase
} from "../dist/consumer-integration/application/use-cases/upgrade-consumer-integration.js";
import {
  consumerIntegrationPlanningPorts
} from "../dist/consumer-integration/composition/consumer-integration-planner.js";
import {
  projectConsumerIntegrationProfileV1,
  projectPnpmWorkspaceCohortExclusionsV1
} from "../dist/consumer-integration/adapters/consumer-upgrade-file-projectors.js";
import {
  projectQualifiedCohortAuthority
} from "../dist/consumer-integration/adapters/github-cohort-authority-reader.js";
import {
  packageConsumerAssetCatalogReader
} from "../dist/consumer-integration/adapters/package-consumer-asset-catalog.js";
import {
  projectPnpmManifestCohortPinsV1
} from "../dist/consumer-integration/adapters/pnpm-manifest-adapter-v1.js";
import {
  foundationKnownFileTransaction
} from "../dist/consumer-integration/adapters/foundation-known-file-transaction.js";
import {
  nodeConsumerIntegrationInputReader
} from "../dist/consumer-integration/adapters/node-consumer-integration-repository.js";
import {
  NodeConsumerUpgradeSandbox
} from "../dist/consumer-integration/adapters/node-consumer-upgrade-sandbox.js";
import {
  fakeCorepackSource,
  foundationRoot,
  lockfileFor,
  packageRoot,
  runGit,
  cleanupOneCommandSandbox,
  sourceCohort,
  sourceManifest
} from "./consumer-upgrade-e2e-fixtures.mjs";

const REPOSITORY = {
  provider: "github",
  id: "999999999",
  nameWithOwner: "agent-teams-ai/docs-upgrade-sandbox"
};
const coreRoot = join(packageRoot, "..", "docs-protocol");
const repositoryMutationRoot = join(packageRoot, "..", "repository-mutation");


function fileObservation(bytes) {
  return { state: "file", bytes, mode: 0o644 };
}

function restoreEnvironment(name, value) {
  if (value === undefined) {delete process.env[name];}
  else {process.env[name] = value;}
}

function useGitHubRepositoryIdentity(repository) {
  const originalId = process.env.GITHUB_REPOSITORY_ID;
  const originalName = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY_ID = repository.id;
  process.env.GITHUB_REPOSITORY = repository.nameWithOwner;
  return () => {
    restoreEnvironment("GITHUB_REPOSITORY_ID", originalId);
    restoreEnvironment("GITHUB_REPOSITORY", originalName);
  };
}

function desired(cohort, schemaVersion = 2) {
  return {
    schemaVersion,
    repository: REPOSITORY,
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    governedDocsRoots: ["docs"],
    ...(schemaVersion === 2 ? { qualification: {
      contractPath: "architecture/foundation/docs-protocol-qualification.json",
      gateCommand: "pnpm docs:protocol:check"
    } } : {}),
    cohort
  };
}

function sourceSnapshot(source, catalog) {
  const scripts = canonicalDocsScripts(source.profilePath);
  const manifest = Buffer.from(`${JSON.stringify({
    name: "upgrade-source",
    private: true,
    packageManager: "pnpm@11.20.0",
    scripts,
    devDependencies: {
      "@agent-teams/docs-protocol": source.cohort.packages.docsProtocol.version,
      "@agent-teams/engineering-foundation":
        source.cohort.packages.engineeringFoundation.version
    }
  }, null, 2)}\n`);
  const route = Buffer.from(canonicalManagedRoute(source.skillPath));
  const skill = Buffer.from(readFileSync(join(packageRoot, "skills/docs/SKILL.md")));
  const caller = Buffer.from(canonicalCallerWorkflow(source.cohort));
  const managed = Buffer.from(canonicalManagedState(source, {
    skillDigest: digestBytes(skill),
    callerWorkflowDigest: digestBytes(caller),
    assetCatalogDigest: catalog.catalogDigest,
    transitionCatalogDigest: catalog.transitionCatalogDigest,
    agentsRouteDigest: digestBytes(route),
    docsScriptsDigest: canonicalDocsScriptsDigest(source.profilePath)
  }));
  return {
    integrationProfile: fileObservation(Buffer.from("{}\n")),
    lockfile: fileObservation(Buffer.from("lockfile\n")),
    packageManifest: fileObservation(manifest),
    agents: fileObservation(route),
    skill: fileObservation(skill),
    callerWorkflow: fileObservation(caller),
    managedState: fileObservation(managed)
  };
}

function rawRegistry(cohort, state = "RECOMMENDED", repositoryId = Number(REPOSITORY.id)) {
  return {
    schema_version: 1,
    cohorts: [{
      cohort_id: cohort.cohortId,
      channel: cohort.channel,
      record_digest: cohort.recordDigest,
      eligible_after: cohort.eligibleAfter,
      upgrade_from: cohort.upgradeFrom,
      rollback_to: cohort.rollbackTo,
      packages: [
        { name: "@agent-teams/docs-protocol", ...cohort.packages.docsProtocol },
        {
          name: "@agent-teams/engineering-foundation",
          ...cohort.packages.engineeringFoundation
        }
      ],
      reusable_workflow: {
        repository: cohort.workflow.repository,
        path: cohort.workflow.path,
        revision: cohort.workflow.revision,
        blob_sha: cohort.workflow.blobSha
      },
      assets: {
        skill: { digest: cohort.assets.skillDigest },
        caller_workflow: { rendered_digest: cohort.assets.callerWorkflowDigest },
        asset_catalog: { digest: cohort.assets.assetCatalogDigest },
        transition_catalog: { digest: cohort.assets.transitionCatalogDigest }
      },
      schemas: {
        consumer_integration: cohort.schemas.consumerIntegration,
        managed_state: cohort.schemas.managedState,
        docs_protocol: cohort.schemas.docsProtocol
      },
      runtime: cohort.runtime,
      runtime_closure: { digest: cohort.runtime.runtimeClosureDigest },
      canary_repositories: [{ repository_id: repositoryId }]
    }],
    events: [{
      sequence: 1,
      cohort_id: cohort.cohortId,
      state: "QUALIFIED",
      event_digest: cohort.qualificationEventDigest
    }, {
      sequence: 2,
      cohort_id: cohort.cohortId,
      state,
      event_digest: `sha256:${"9".repeat(64)}`
    }]
  };
}

test("projects the protected central authority without lifecycle metadata drift", async () => {
  const { cohort: source } = await sourceCohort();
  const target = {
    ...structuredClone(source),
    cohortId: "docs-target-successor",
    recordDigest: `sha256:${"6".repeat(64)}`,
    qualificationEventDigest: `sha256:${"7".repeat(64)}`,
    upgradeFrom: [source.cohortId],
    eligibleAfter: "2099-01-01T00:00:00Z"
  };
  const authority = projectQualifiedCohortAuthority({
    cohortId: target.cohortId,
    registry: rawRegistry(target),
    repository: REPOSITORY,
    revision: "8".repeat(40)
  });
  assert.deepEqual(authority.cohort, target);
  assert.equal(authority.revision, "8".repeat(40));
  assert.equal("lifecycleState" in authority.cohort, false);

  assert.throws(() => projectQualifiedCohortAuthority({
    cohortId: target.cohortId,
    registry: rawRegistry(target, "SUSPENDED"),
    repository: REPOSITORY,
    revision: "8".repeat(40)
  }), (error) => error?.code === "DOCS_CONSUMER_COHORT_NOT_SELECTABLE");
  assert.throws(() => projectQualifiedCohortAuthority({
    cohortId: target.cohortId,
    registry: rawRegistry(target, "CANARY", 123),
    repository: REPOSITORY,
    revision: "8".repeat(40)
  }), (error) => error?.code === "DOCS_CONSUMER_COHORT_NOT_SELECTABLE");
});

test("projects profile, exact pins, and release-age exclusions while preserving consumer authority", async () => {
  const { cohort: source } = await sourceCohort();
  const target = {
    ...structuredClone(source),
    cohortId: "docs-target-files",
    recordDigest: `sha256:${"6".repeat(64)}`,
    qualificationEventDigest: `sha256:${"7".repeat(64)}`,
    upgradeFrom: [source.cohortId],
    packages: {
      docsProtocol: { ...source.packages.docsProtocol, version: "9.8.7" },
      engineeringFoundation: {
        ...source.packages.engineeringFoundation,
        version: "8.7.6"
      }
    }
  };
  const profile = desired(source);
  const projectedProfile = JSON.parse(Buffer.from(await projectConsumerIntegrationProfileV1({
    bytes: Buffer.from(`${JSON.stringify(profile, null, 2)}\n`),
    cohort: target
  })).toString("utf8"));
  assert.deepEqual(projectedProfile.cohort, target);
  assert.deepEqual(projectedProfile.qualification, profile.qualification);
  assert.deepEqual(projectedProfile.repository, profile.repository);

  const manifestSource = `{
    "name": "consumer",
    "private": true,
    "devDependencies": {
      "@agent-teams/docs-protocol": "${source.packages.docsProtocol.version}",
      "@agent-teams/engineering-foundation": "${source.packages.engineeringFoundation.version}",
      "keep": "1.0.0"
    }
  }\n`;
  const projectedManifest = Buffer.from(projectPnpmManifestCohortPinsV1({
    bytes: Buffer.from(manifestSource),
    cohort: target
  })).toString("utf8");
  assert.match(projectedManifest, /"@agent-teams\/docs-protocol": "9\.8\.7"/u);
  assert.match(projectedManifest, /"@agent-teams\/engineering-foundation": "8\.7\.6"/u);
  assert.match(projectedManifest, /"keep": "1\.0\.0"/u);

  const workspace = `packages:\n  - packages/*\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - "@agent-teams/engineering-foundation@${source.packages.engineeringFoundation.version}"\n  - "@agent-teams/docs-protocol@${source.packages.docsProtocol.version}"\n  - keep@1.0.0\n`;
  const projectedWorkspace = Buffer.from(projectPnpmWorkspaceCohortExclusionsV1({
    bytes: Buffer.from(workspace),
    cohort: target
  })).toString("utf8");
  assert.match(projectedWorkspace, /@agent-teams\/engineering-foundation@8\.7\.6/u);
  assert.match(projectedWorkspace, /@agent-teams\/docs-protocol@9\.8\.7/u);
  assert.match(projectedWorkspace, /keep@1\.0\.0/u);

  const noAgePolicy = "packages:\n  - packages/*\n";
  assert.equal(Buffer.from(projectPnpmWorkspaceCohortExclusionsV1({
    bytes: Buffer.from(noAgePolicy), cohort: target
  })).toString("utf8"), noAgePolicy);
});

test("coordinates staged proof, one Foundation publication, activation, and reverse rollback", async () => {
  const { cohort, catalog } = await sourceCohort();
  const current = desired(cohort, 1);
  const snapshot = sourceSnapshot(current, catalog);
  const target = {
    ...structuredClone(cohort),
    cohortId: "docs-target-coordinator",
    recordDigest: `sha256:${"6".repeat(64)}`,
    qualificationEventDigest: `sha256:${"7".repeat(64)}`,
    upgradeFrom: [cohort.cohortId]
  };
  const authority = {
    repository: "agent-teams-ai/.github",
    path: "governance/docs-qualified-cohorts.json",
    revision: "8".repeat(40),
    cohort: target
  };
  const calls = [];
  let activationFailure = false;
  const preimage = Buffer.from("before\n");
  const postimage = Buffer.from("after\n");
  const ports = {
    assets: { read: async () => catalog },
    authority: { read: async () => authority },
    input: { read: async () => ({ desired: current, root: "/consumer", snapshot }) },
    planning: consumerIntegrationPlanningPorts,
    sandbox: {
      prepare: async () => ({ operations: [{
        path: "package.json",
        precondition: {
          state: "known-file",
          acceptedPreimages: [{ bytes: preimage, mode: 0o644 }]
        },
        postimage: { bytes: postimage, mode: 0o644 }
      }] }),
      activateAndVerify: async () => {
        calls.push("activate");
        if (activationFailure) {throw new Error("activation failed");}
      },
      restoreAndVerify: async () => {calls.push("restore");}
    },
    transaction: {
      inspect: async () => ({ state: "idle" }),
      apply: async ({ plan }) => {
        calls.push(plan.operations[0].postimage.contentBase64);
        return {
          schemaVersion: 1,
          protocol: "foundation.replace-known-file/v1",
          planDigest: plan.planDigest,
          outcome: "applied",
          operations: [{
            path: "package.json",
            outcome: "replaced",
            resultDigest: plan.operations[0].postimage.digest
          }],
          receiptDigest: `sha256:${"9".repeat(64)}`
        };
      },
      recover: async () => {throw new Error("unused");}
    }
  };
  const upgrade = createConsumerUpgradeUseCase(ports);
  const result = await upgrade({ consumerRoot: "/consumer", to: target.cohortId });
  assert.equal(result.outcome, "upgraded");
  assert.equal(result.authority.revision, authority.revision);
  assert.deepEqual(calls.slice(-1), ["activate"]);

  calls.length = 0;
  activationFailure = true;
  await assert.rejects(
    upgrade({ consumerRoot: "/consumer", to: target.cohortId }),
    /activation failed/u
  );
  assert.equal(calls.length, 4);
  assert.equal(Buffer.from(calls[0], "base64").toString("utf8"), "after\n");
  assert.equal(calls[1], "activate");
  assert.equal(Buffer.from(calls[2], "base64").toString("utf8"), "before\n");
  assert.equal(calls[3], "restore");
});

test("upgrades one disposable consumer end to end without authority or lockfile prework", {
  skip: process.platform === "win32"
}, async () => {
  const disposable = await mkdtemp(join(tmpdir(), "docs-one-command-e2e-"));
  const consumerRoot = join(disposable, "consumer");
  const fakeBin = join(disposable, "bin");
  await Promise.all([
    mkdir(join(consumerRoot, "architecture", "foundation"), { recursive: true }),
    mkdir(join(consumerRoot, ".agents", "skills", "docs-authoring"), {
      recursive: true
    }),
    mkdir(join(consumerRoot, ".github", "workflows"), { recursive: true }),
    mkdir(fakeBin, { recursive: true })
  ]);
  const { cohort: packageCohort, catalog } = await sourceCohort();
  const prior = catalog.directTargetBundles.find(({ cohort: candidate }) =>
    candidate.cohortId === "docs-2026-08-25-stable3"
  );
  assert.ok(prior, "the released package must bundle the stable3 migration source");
  const current = desired(prior.cohort);
  const target = {
    ...structuredClone(packageCohort),
    cohortId: "docs-one-command-target",
    recordDigest: `sha256:${"6".repeat(64)}`,
    qualificationEventDigest: `sha256:${"7".repeat(64)}`,
    eligibleAfter: "2099-01-01T00:00:00Z",
    upgradeFrom: [prior.cohort.cohortId]
  };
  const authority = Object.freeze({
    repository: "agent-teams-ai/.github",
    path: "governance/docs-qualified-cohorts.json",
    revision: "8".repeat(40),
    cohort: target
  });
  const route = Buffer.from(canonicalManagedRoute(current.skillPath));
  const managedState = canonicalManagedState(current, {
    skillDigest: digestBytes(prior.skill),
    callerWorkflowDigest: digestBytes(prior.callerWorkflow),
    assetCatalogDigest: prior.cohort.assets.assetCatalogDigest,
    transitionCatalogDigest: prior.cohort.assets.transitionCatalogDigest,
    agentsRouteDigest: digestBytes(route),
    docsScriptsDigest: canonicalDocsScriptsDigest(current.profilePath)
  });
  const profilePath = join(
    consumerRoot,
    "architecture",
    "foundation",
    "docs-consumer-integration.json"
  );
  const fakeCorepack = join(fakeBin, "corepack");
  await Promise.all([
    writeFile(profilePath, `${JSON.stringify(current, null, 2)}\n`),
    writeFile(
      join(consumerRoot, "package.json"),
      `${JSON.stringify(sourceManifest(prior.cohort, current.profilePath), null, 2)}\n`
    ),
    writeFile(join(consumerRoot, "pnpm-lock.yaml"), lockfileFor(prior.cohort)),
    writeFile(join(consumerRoot, ".node-version"), "24.18.0\n"),
    writeFile(join(consumerRoot, "AGENTS.md"), route),
    writeFile(join(consumerRoot, current.skillPath), prior.skill),
    writeFile(join(consumerRoot, current.callerWorkflowPath), prior.callerWorkflow),
    writeFile(join(consumerRoot, current.managedStatePath), managedState),
    writeFile(join(consumerRoot, "pnpm-workspace.yaml"), `packages: []
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - "@agent-teams/docs-protocol@${prior.cohort.packages.docsProtocol.version}"
  - "@agent-teams/engineering-foundation@${prior.cohort.packages.engineeringFoundation.version}"
  - "unrelated@1.0.0"
`),
    writeFile(fakeCorepack, fakeCorepackSource())
  ]);
  await chmod(fakeCorepack, 0o755);
  runGit(consumerRoot, ["init", "-q"]);
  runGit(consumerRoot, ["config", "user.email", "sandbox@example.invalid"]);
  runGit(consumerRoot, ["config", "user.name", "Docs Upgrade Sandbox"]);
  runGit(consumerRoot, ["add", "--all"]);
  runGit(consumerRoot, ["commit", "-qm", "test: seed disposable docs consumer"]);

  const originalPath = process.env.PATH, originalDocs = process.env.DOCS_UPGRADE_TEST_DOCS_PACKAGE, originalFoundation = process.env.DOCS_UPGRADE_TEST_FOUNDATION_PACKAGE, originalManaged = process.env.DOCS_UPGRADE_TEST_MANAGED_PACKAGE, originalRepositoryMutation = process.env.DOCS_UPGRADE_TEST_REPOSITORY_MUTATION_PACKAGE;
  const restoreGitHubIdentity = useGitHubRepositoryIdentity(REPOSITORY);
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
  process.env.DOCS_UPGRADE_TEST_DOCS_PACKAGE = coreRoot;
  process.env.DOCS_UPGRADE_TEST_FOUNDATION_PACKAGE = foundationRoot;
  process.env.DOCS_UPGRADE_TEST_MANAGED_PACKAGE = packageRoot;
  process.env.DOCS_UPGRADE_TEST_REPOSITORY_MUTATION_PACKAGE = repositoryMutationRoot;
  try {
    const upgrade = createConsumerUpgradeUseCase({
      assets: packageConsumerAssetCatalogReader,
      authority: { read: async () => authority },
      input: nodeConsumerIntegrationInputReader,
      planning: consumerIntegrationPlanningPorts,
      sandbox: new NodeConsumerUpgradeSandbox(),
      transaction: foundationKnownFileTransaction
    });
    const dirtyPath = join(consumerRoot, "uncommitted.txt");
    await writeFile(dirtyPath, "must block\n");
    await assert.rejects(
      upgrade({ consumerRoot, to: target.cohortId }),
      (error) => error?.code === "DOCS_CONSUMER_UPGRADE_DIRTY_WORKTREE"
    );
    await rm(dirtyPath);
    const execution = await upgrade({
      consumerRoot,
      to: target.cohortId
    });
    assert.deepEqual(
      [execution.outcome, execution.authority.revision],
      ["upgraded", authority.revision]
    );
    const [profile, manifest, lockfile, workspace] = await Promise.all([
      readFile(profilePath, "utf8").then(JSON.parse),
      readFile(join(consumerRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(join(consumerRoot, "pnpm-lock.yaml"), "utf8"),
      readFile(join(consumerRoot, "pnpm-workspace.yaml"), "utf8")
    ]);
    assert.deepEqual(profile.cohort, target);
    assert.equal(
      manifest.devDependencies["@agent-teams/docs-protocol"],
      target.packages.docsProtocol.version
    );
    assert.equal(
      manifest.devDependencies["@agent-teams/engineering-foundation"],
      target.packages.engineeringFoundation.version
    );
    assert.deepEqual(manifest.untouched, { retained: true });
    assert.match(lockfile, new RegExp(`specifier: ${target.packages.docsProtocol.version}`, "u"));
    assert.match(
      workspace,
      new RegExp(`@agent-teams/docs-protocol@${target.packages.docsProtocol.version}`, "u")
    );
    assert.ok(!workspace.includes(`@agent-teams/docs-protocol@${prior.cohort.packages.docsProtocol.version}`));
    assert.match(workspace, /unrelated@1\.0\.0/u);
    let authorityReads = 0;
    const replay = createConsumerUpgradeUseCase({
      assets: packageConsumerAssetCatalogReader,
      authority: { read: async () => {
        authorityReads += 1;
        return authority;
      } },
      input: nodeConsumerIntegrationInputReader,
      planning: consumerIntegrationPlanningPorts,
      sandbox: new NodeConsumerUpgradeSandbox(),
      transaction: foundationKnownFileTransaction
    });
    const repeated = await replay({ consumerRoot, to: target.cohortId });
    assert.equal(repeated.outcome, "current");
    assert.equal(authorityReads, 0);
  } finally {
      await cleanupOneCommandSandbox({ disposable, originalPath, originalDocs, originalFoundation, originalManaged, originalRepositoryMutation, restoreGitHubIdentity });
  }
});
