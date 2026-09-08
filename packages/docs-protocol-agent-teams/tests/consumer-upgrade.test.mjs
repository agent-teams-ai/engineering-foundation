import { assertConsumerUpgradeExecutionSchema } from "../dist/consumer-integration/adapters/consumer-integration-schema-validator.js";
/* oxlint-disable max-lines, max-lines-per-function -- Disposable E2E keeps setup and cleanup local. */
import assert from "node:assert/strict";
import { registerRestorationSelectionTests } from "./consumer-restoration-selection-cases.mjs";
import { registerRestorationFinalizationTests } from "./consumer-restoration-finalization-cases.mjs";
import { registerConsumerRestorationTests } from "./consumer-restoration-cases.mjs";
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
  describeCanonicalConsumerAssets,
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
} from "../dist/consumer-integration/composition/known-file-transaction.js";
import {
  computePnpmRuntimeClosureDigestV2
} from "../dist/consumer-integration/adapters/pnpm-runtime-closure-v2.js";
import {
  nodeConsumerIntegrationInputReader
} from "../dist/consumer-integration/adapters/node-consumer-integration-repository.js";
import {
  NodeConsumerUpgradeSandbox
} from "../dist/consumer-integration/adapters/node-consumer-upgrade-sandbox.js";
import {
  assertInstalledHistoricalIntegrationCurrent,
  assertInstalledIntegrationCurrent
} from "../dist/consumer-integration/adapters/node-consumer-upgrade-target.js";
import {
  fakeCorepackSource,
  historicalDocsCheckFixtureSource,
  foundationRoot,
  lockfileFor,
  packageRoot,
  runGit,
  cleanupOneCommandSandbox,
  documentAuthoringRoot,
  lockfileForV2,
  lockfileObjectForV2,
  repositoryMutationRoot,
  sourceCohort,
  sourceManifest,
  sourceManifestV2
} from "./consumer-upgrade-e2e-fixtures.mjs";

const REPOSITORY = {
  provider: "github",
  id: "999999999",
  nameWithOwner: "agent-teams-ai/docs-upgrade-sandbox"
};
const coreRoot = join(packageRoot, "..", "docs-protocol");
const V2_INTEGRITY = `sha512-${"A".repeat(86)}==`;

test("historical recovery selects only the explicit source CLI without adapter fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-historical-check-"));
  const docsRoot = join(root, "node_modules", "@agent-teams", "docs-protocol");
  try {
    await mkdir(join(docsRoot, "dist"), { recursive: true });
    await writeFile(join(docsRoot, "dist", "cli.js"), "// historical fixture\n");
    const calls = [];
    await assertInstalledHistoricalIntegrationCurrent(root, async (...args) => {
      calls.push(args);
      return { code: 0, stdout: '{"outcome":"current"}', stderr: "" };
    });
    assert.deepEqual(calls, [[
      process.execPath,
      [join(docsRoot, "dist", "cli.js"), "consumer", "check", "--consumer", root, "--json"],
      root,
      [0, 1]
    ]]);
    await assert.rejects(assertInstalledIntegrationCurrent(root, async () => {
      throw new Error("managed target must not fall back to the historical CLI");
    }), (error) => error?.code === "ENOENT");
    await assert.rejects(assertInstalledHistoricalIntegrationCurrent(root, async () => ({
      code: 1, stdout: '{"outcome":"blocked"}', stderr: ""
    })), (error) => error?.code === "DOCS_CONSUMER_UPGRADE_SOURCE_NOT_CURRENT");
    await assert.rejects(assertInstalledHistoricalIntegrationCurrent(root, async () => ({
      code: 1, stdout: '{"outcome":"current"}', stderr: ""
    })), /nonzero exit/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


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

function cohortV2(cohortId, options = {}) {
  const version = options.version ?? "1.0.0";
  const coordinate = { version, integrity: V2_INTEGRITY };
  const provisional = {
    schemaVersion: 2,
    cohortId,
    channel: "stable",
    recordDigest: `sha256:${"1".repeat(64)}`,
    qualificationEventDigest: `sha256:${"2".repeat(64)}`,
    eligibleAfter: "2026-09-04T00:00:00Z",
    upgradeFrom: options.upgradeFrom ?? [],
    rollbackTo: options.rollbackTo ?? [],
    packages: {
      repositoryMutation: { ...coordinate },
      documentAuthoring: { ...coordinate },
      docsProtocol: { ...coordinate },
      docsProtocolAgentTeams: { ...coordinate },
      engineeringFoundation: { ...coordinate }
    },
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: options.workflowRevision ?? "3".repeat(40),
      blobSha: "4".repeat(40)
    },
    assets: {},
    schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 },
    runtime: {
      node: ">=24.18.0 <25",
      pnpm: ">=11.17.0 <12",
      runtimeClosureDigest: options.runtimeClosureDigest ?? `sha256:${"9".repeat(64)}`
    }
  };
  return { ...provisional, assets: describeCanonicalConsumerAssets(provisional) };
}

function desiredV3(cohort) {
  return {
    schemaVersion: 3,
    repository: REPOSITORY,
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    governedDocsRoots: ["docs"],
    qualification: {
      contractPath: "architecture/foundation/docs-protocol-qualification.json",
      gateCommand: "pnpm docs:protocol:check"
    },
    cohort
  };
}

function sourceSnapshotV3(source) {
  const route = Buffer.from(canonicalManagedRoute(source.skillPath));
  const skill = Buffer.from(readFileSync(join(packageRoot, "skills/docs/SKILL.md")));
  const caller = Buffer.from(canonicalCallerWorkflow(source.cohort));
  const manifest = Buffer.from(`${JSON.stringify({
    name: "upgrade-source-v3",
    private: true,
    scripts: canonicalDocsScripts(source.profilePath),
    devDependencies: {
      "@agent-teams/docs-protocol": source.cohort.packages.docsProtocol.version,
      "@agent-teams/docs-protocol-agent-teams":
        source.cohort.packages.docsProtocolAgentTeams.version,
      "@agent-teams/engineering-foundation":
        source.cohort.packages.engineeringFoundation.version
    }
  }, null, 2)}\n`);
  const managed = Buffer.from(canonicalManagedState(source, {
    skillDigest: digestBytes(skill),
    callerWorkflowDigest: digestBytes(caller),
    assetCatalogDigest: source.cohort.assets.assetCatalogDigest,
    transitionCatalogDigest: source.cohort.assets.transitionCatalogDigest,
    agentsRouteDigest: digestBytes(route),
    docsScriptsDigest: canonicalDocsScriptsDigest(source.profilePath)
  }));
  return {
    integrationProfile: fileObservation(Buffer.from(`${JSON.stringify(source)}\n`)),
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
      evidence_references: [],
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
        consumer_plan: 1,
        managed_state: cohort.schemas.managedState,
        foundation_plan: 1,
        foundation_journal: 1,
        foundation_receipt: 1,
        foundation_envelope: 5,
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
    generation: 1,
    registry: rawRegistry(target),
    repository: REPOSITORY,
    revision: "8".repeat(40)
  });
  assert.deepEqual(authority.cohort, target);
  assert.equal(authority.revision, "8".repeat(40));
  assert.equal("lifecycleState" in authority.cohort, false);

  assert.throws(() => projectQualifiedCohortAuthority({
    cohortId: target.cohortId,
    generation: 1,
    registry: rawRegistry(target, "SUSPENDED"),
    repository: REPOSITORY,
    revision: "8".repeat(40)
  }), (error) => error?.code === "DOCS_CONSUMER_COHORT_NOT_SELECTABLE");
  assert.throws(() => projectQualifiedCohortAuthority({
    cohortId: target.cohortId,
    generation: 1,
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
    input: { read: async () => ({
      desired: current,
      repositoryHead: "a".repeat(40),
      root: "/consumer",
      snapshot
    }) },
    planning: consumerIntegrationPlanningPorts,
    sandbox: {
      prepareV1: async () => ({ operations: [{
        path: "package.json",
        precondition: {
          state: "known-file",
          acceptedPreimages: [{ bytes: preimage, mode: 0o644 }]
        },
        postimage: { bytes: postimage, mode: 0o644 }
      }] }),
      activateAndVerifyV1: async () => {
        calls.push("activate");
        if (activationFailure) {throw new Error("activation failed");}
      },
      restoreAndVerifyV1: async () => {calls.push("restore");},
      prepareV2: async () => {throw new Error("unused");},
      activateAndVerifyV2: async () => {throw new Error("unused");},
      restoreAndVerifyV2: async () => {throw new Error("unused");}
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
  const result = await upgrade({ consumerRoot: "/consumer", targetGeneration: 1, to: target.cohortId });
  assert.equal(result.outcome, "upgraded");
  assert.equal(result.authority.revision, authority.revision);
  assert.deepEqual(calls.slice(-1), ["activate"]);

  calls.length = 0;
  activationFailure = true;
  await assert.rejects(
    upgrade({ consumerRoot: "/consumer", targetGeneration: 1, to: target.cohortId }),
    /activation failed/u
  );
  assert.equal(calls.length, 4);
  assert.equal(Buffer.from(calls[0], "base64").toString("utf8"), "after\n");
  assert.equal(calls[1], "activate");
  assert.equal(Buffer.from(calls[2], "base64").toString("utf8"), "before\n");
  assert.equal(calls[3], "restore");

  let crossGenerationStaged = false;
  let crossGenerationActivated = false;
  let crossGenerationActivationFailure = false;
  const coordinate = target.packages.docsProtocol;
  const crossGenerationAuthority = {
    ...authority,
    cohort: {
      ...target,
      schemaVersion: 2,
      packages: {
        repositoryMutation: coordinate,
        documentAuthoring: coordinate,
        docsProtocol: coordinate,
        docsProtocolAgentTeams: coordinate,
        engineeringFoundation: target.packages.engineeringFoundation
      },
      schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 }
    }
  };
  const crossGeneration = createConsumerUpgradeUseCase({
    ...ports,
    authority: { read: async () => crossGenerationAuthority },
    sandbox: {
      ...ports.sandbox,
      prepareV1ToV2: async () => {
        crossGenerationStaged = true;
        return { operations: [{
          path: "package.json",
          precondition: {
            state: "known-file",
            acceptedPreimages: [{ bytes: preimage, mode: 0o644 }]
          },
          postimage: { bytes: postimage, mode: 0o644 }
        }] };
      },
      activateAndVerifyV2: async () => {
        crossGenerationActivated = true;
        if (crossGenerationActivationFailure) {throw new Error("v2 activation interrupted");}
      }
    }
  });
  const missingGeneration = await crossGeneration({
    consumerRoot: "/consumer",
    to: crossGenerationAuthority.cohort.cohortId
  });
  assert.equal(missingGeneration.issues[0].code, "DOCS_CONSUMER_TARGET_GENERATION_REQUIRED");

  const discriminatorMismatch = await crossGeneration({
    consumerRoot: "/consumer",
    targetGeneration: 1,
    to: crossGenerationAuthority.cohort.cohortId
  });
  assert.equal(discriminatorMismatch.issues[0].code,
    "DOCS_CONSUMER_COHORT_GENERATION_MISMATCH");
  assert.equal(crossGenerationStaged, false);

  const forbidden = await createConsumerUpgradeUseCase({
    ...ports,
    authority: { read: async () => ({
      ...crossGenerationAuthority,
      cohort: { ...crossGenerationAuthority.cohort, upgradeFrom: [] }
    }) }
  })({
    consumerRoot: "/consumer",
    targetGeneration: 2,
    to: crossGenerationAuthority.cohort.cohortId
  });
  assert.equal(forbidden.issues[0].code, "DOCS_CONSUMER_COHORT_TRANSITION_FORBIDDEN");

  const migration = await crossGeneration({
    consumerRoot: "/consumer",
    targetGeneration: 2,
    to: crossGenerationAuthority.cohort.cohortId
  });
  assert.equal(migration.outcome, "upgraded");
  assert.equal(crossGenerationStaged, true);
  assert.equal(crossGenerationActivated, true);

  crossGenerationActivationFailure = true;
  calls.length = 0;
  await assert.rejects(crossGeneration({
    consumerRoot: "/consumer",
    targetGeneration: 2,
    to: crossGenerationAuthority.cohort.cohortId
  }), /v2 activation interrupted/u);
  assert.equal(calls.length, 3);
  assert.equal(Buffer.from(calls[0], "base64").toString("utf8"), "after\n");
  assert.equal(Buffer.from(calls[1], "base64").toString("utf8"), "before\n");
  assert.equal(calls[2], "restore");

  let authorityRead = 0;
  let appliedAfterAuthorityChange = false;
  const interrupted = createConsumerUpgradeUseCase({
    ...ports,
    authority: { read: async () => {
      authorityRead += 1;
      return authorityRead === 1 ? crossGenerationAuthority : {
        ...crossGenerationAuthority,
        cohort: {
          ...crossGenerationAuthority.cohort,
          recordDigest: `sha256:${"a".repeat(64)}`
        }
      };
    } },
    sandbox: {
      ...ports.sandbox,
      prepareV1ToV2: async () => ({ operations: [{
        path: "package.json",
        precondition: {
          state: "known-file",
          acceptedPreimages: [{ bytes: preimage, mode: 0o644 }]
        },
        postimage: { bytes: postimage, mode: 0o644 }
      }] })
    },
    transaction: {
      ...ports.transaction,
      apply: async () => {appliedAfterAuthorityChange = true; throw new Error("must not apply");}
    }
  });
  const interruptedResult = await interrupted({
    consumerRoot: "/consumer",
    targetGeneration: 2,
    to: crossGenerationAuthority.cohort.cohortId
  });
  assert.equal(interruptedResult.issues[0].code, "DOCS_CONSUMER_AUTHORITY_CHANGED");
  assert.equal(appliedAfterAuthorityChange, false);
});

test("keeps an exact V1 Cohort current when the repository has an unborn HEAD", async () => {
  const { cohort, catalog } = await sourceCohort();
  const current = desired(cohort, 1);
  const snapshot = sourceSnapshot(current, catalog);
  let authorityReads = 0;
  let staged = false;
  const upgrade = createConsumerUpgradeUseCase({
    assets: { read: async () => catalog },
    authority: { read: async () => {
      authorityReads += 1;
      throw new Error("same-Cohort no-op must not read authority");
    } },
    input: { read: async () => ({
      desired: current,
      root: "/unborn-consumer",
      snapshot
    }) },
    planning: consumerIntegrationPlanningPorts,
    sandbox: {
      prepareV1: async () => {staged = true; throw new Error("must not stage");},
      activateAndVerifyV1: async () => {throw new Error("must not activate");},
      restoreAndVerifyV1: async () => {throw new Error("must not restore");},
      prepareV2: async () => {throw new Error("must not stage");},
      activateAndVerifyV2: async () => {throw new Error("must not activate");},
      restoreAndVerifyV2: async () => {throw new Error("must not restore");}
    },
    transaction: {
      inspect: async () => ({ state: "idle" }),
      apply: async () => {throw new Error("must not mutate");},
      recover: async () => {throw new Error("must not recover");}
    }
  });
  const result = await upgrade({ consumerRoot: "/unborn-consumer", targetGeneration: 1, to: cohort.cohortId });
  assert.deepEqual(result, {
    schemaVersion: 1,
    command: "consumer.upgrade",
    outcome: "current",
    issues: []
  });
  assert.equal(authorityReads, 0);
  assert.equal(staged, false);
});

test("leaves one coherent target when a mixed receipt proves concurrent satisfaction", async () => {
  const { cohort, catalog } = await sourceCohort();
  const current = desired(cohort, 1);
  const snapshot = sourceSnapshot(current, catalog);
  const target = cohortV2("docs-target-mixed-receipt", {
    upgradeFrom: [cohort.cohortId]
  });
  const authority = {
    repository: "agent-teams-ai/.github",
    path: "governance/docs-qualified-cohorts.json",
    revision: "8".repeat(40),
    cohort: target
  };
  const packageBefore = Buffer.from("package-before\n");
  const packageAfter = Buffer.from("package-after\n");
  const lockBefore = Buffer.from("lock-before\n");
  const lockAfter = Buffer.from("lock-after\n");
  const submitted = [];
  const filesystem = new Map([
    ["package.json", packageBefore.toString("utf8")],
    ["pnpm-lock.yaml", lockAfter.toString("utf8")]
  ]);
  let restored = false;
  const upgrade = createConsumerUpgradeUseCase({
    assets: { read: async () => catalog },
    authority: { read: async () => authority },
    input: { read: async () => ({
      desired: current,
      repositoryHead: "a".repeat(40),
      root: "/mixed-consumer",
      snapshot
    }) },
    planning: consumerIntegrationPlanningPorts,
    sandbox: {
      prepareV1: async () => {throw new Error("unused");},
      activateAndVerifyV1: async () => {throw new Error("unused");},
      prepareV1ToV2: async () => ({ operations: [{
        path: "package.json",
        precondition: {
          state: "known-file",
          acceptedPreimages: [{ bytes: packageBefore, mode: 0o644 }]
        },
        postimage: { bytes: packageAfter, mode: 0o644 }
      }, {
        path: "pnpm-lock.yaml",
        precondition: {
          state: "known-file",
          acceptedPreimages: [{ bytes: lockBefore, mode: 0o644 }]
        },
        postimage: { bytes: lockAfter, mode: 0o644 }
      }] }),
      activateAndVerifyV2: async () => {throw new Error("mixed activation failed");},
      restoreAndVerifyV1: async () => {restored = true;},
      prepareV2: async () => {throw new Error("unused");},
      restoreAndVerifyV2: async () => {throw new Error("unused");}
    },
    transaction: {
      inspect: async () => ({ state: "idle" }),
      apply: async ({ plan }) => {
        submitted.push(plan);
        for (const operation of plan.operations) {
          filesystem.set(
            operation.path,
            Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8")
          );
        }
        return {
          schemaVersion: 1,
          protocol: "agent-teams.repository-mutation.known-file/v1",
          planDigest: plan.planDigest,
          outcome: "applied",
          operations: plan.operations.length === 2 ? [{
            path: "package.json",
            outcome: "replaced",
            resultDigest: plan.operations[0].postimage.digest
          }, {
            path: "pnpm-lock.yaml",
            outcome: "already-satisfied",
            resultDigest: plan.operations[1].postimage.digest
          }] : [{
            path: "package.json",
            outcome: "replaced",
            resultDigest: plan.operations[0].postimage.digest
          }],
          receiptDigest: `sha256:${"9".repeat(64)}`
        };
      },
      recover: async () => {throw new Error("unused");}
    }
  });
  await assert.rejects(
    upgrade({ consumerRoot: "/mixed-consumer", targetGeneration: 2, to: target.cohortId }),
    /mixed activation failed/u
  );
  assert.equal(submitted.length, 1, "mixed ownership must not start a reverse transaction");
  assert.equal(filesystem.get("package.json"), "package-after\n");
  assert.equal(filesystem.get("pnpm-lock.yaml"), "lock-after\n");
  assert.equal(restored, false);
});

test("coordinates a profile-v3 rollback with exact source HEAD and managed preimages", async () => {
  const targetId = "docs-v2-rollback-target";
  const current = desiredV3(cohortV2("docs-v2-current", {
    rollbackTo: [targetId],
    upgradeFrom: [targetId]
  }));
  const snapshot = sourceSnapshotV3(current);
  const target = cohortV2(targetId, {
    version: "0.9.0",
    workflowRevision: "5".repeat(40)
  });
  const authority = {
    repository: "agent-teams-ai/.github",
    path: "governance/docs-qualified-cohorts.json",
    revision: "8".repeat(40),
    cohort: target
  };
  let prepared;
  let activated = false;
  const preimage = Buffer.from("before-v3\n");
  const postimage = Buffer.from("after-v3\n");
  const upgrade = createConsumerUpgradeUseCase({
    assets: { read: async () => {throw new Error("V3 must not read the V1 catalog");} },
    authority: { read: async () => authority },
    input: { read: async () => ({
      desired: current,
      repositoryHead: "a".repeat(40),
      root: "/consumer-v3",
      snapshot
    }) },
    planning: consumerIntegrationPlanningPorts,
    sandbox: {
      prepareV1: async () => {throw new Error("unused");},
      activateAndVerifyV1: async () => {throw new Error("unused");},
      restoreAndVerifyV1: async () => {throw new Error("unused");},
      prepareV2: async (options) => {
        prepared = options;
        return { operations: [{
          path: "package.json",
          precondition: {
            state: "known-file",
            acceptedPreimages: [{ bytes: preimage, mode: 0o644 }]
          },
          postimage: { bytes: postimage, mode: 0o644 }
        }] };
      },
      activateAndVerifyV2: async () => {activated = true;},
      restoreAndVerifyV2: async () => {throw new Error("unused");}
    },
    transaction: {
      inspect: async () => ({ state: "idle" }),
      apply: async ({ plan }) => ({
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
      }),
      recover: async () => {throw new Error("unused");}
    }
  });

  const result = await upgrade({ consumerRoot: "/consumer-v3", targetGeneration: 2, to: targetId });
  assert.equal(result.outcome, "upgraded");
  assert.equal(activated, true);
  assert.equal(prepared.expectedSourceRevision, "a".repeat(40));
  assert.equal(prepared.expectedSourceSnapshot, snapshot);
  assert.deepEqual(
    Object.values(prepared.managedPreimages).map(({ path }) => path).toSorted(),
    [current.callerWorkflowPath, current.managedStatePath, current.skillPath].toSorted()
  );
  for (const proof of Object.values(prepared.managedPreimages)) {
    assert.equal(proof.mode, 0o644);
    assert.match(proof.digest, /^sha256:[0-9a-f]{64}$/u);
  }
});

for (const [sourceCohortId, sourceProfileVersion, historicalTransitionDigest] of [
  ["docs-2026-08-31-stable10", 1, "ffce6fbb813ccbdbba3ba1dca6b22219672fbcc8bd08a0f0aca37bf8bed38e21"],
  ["docs-2026-08-31-stable10", 2, "ffce6fbb813ccbdbba3ba1dca6b22219672fbcc8bd08a0f0aca37bf8bed38e21"],
  ["docs-2026-08-28-stable8", 2, "7f8df2679785c9495a73c99362987e5d2ae63e120f4bf76801b2ad72d3b66ed4"],
  ["docs-2026-08-28-stable9.1", 2, "ffce6fbb813ccbdbba3ba1dca6b22219672fbcc8bd08a0f0aca37bf8bed38e21"]
]) {
test(`migrates one disposable profile-v${sourceProfileVersion} consumer from ${sourceCohortId} explicitly to Cohort v2`, {
  skip: process.platform === "win32"
}, async () => {
  const disposable = await mkdtemp(join(tmpdir(), "docs-one-command-e2e-"));
  const consumerRoot = join(disposable, "consumer");
  const fakeBin = join(disposable, "bin");
  const historicalDocsRoot = join(disposable, "historical-docs");
  await Promise.all([
    mkdir(join(historicalDocsRoot, "dist"), { recursive: true }),
    mkdir(join(consumerRoot, "architecture", "foundation"), { recursive: true }),
    mkdir(join(consumerRoot, ".agents", "skills", "docs-authoring"), {
      recursive: true
    }),
    mkdir(join(consumerRoot, ".github", "workflows"), { recursive: true }),
    mkdir(fakeBin, { recursive: true })
  ]);
  const { catalog } = await sourceCohort();
  const prior = catalog.directTargetBundles.find(({ cohort: candidate }) =>
    candidate.cohortId === sourceCohortId
  );
  assert.ok(prior, `the released package must bundle the ${sourceCohortId} migration source`);
  assert.deepEqual(catalog.currentSourceExecutors, []);
  assert.equal(
    prior.cohort.assets.transitionCatalogDigest,
    `sha256:${historicalTransitionDigest}`
  );
  assert.notEqual(prior.cohort.assets.transitionCatalogDigest, catalog.transitionCatalogDigest);
  assert.deepEqual(prior.cohort.rollbackTo, []);
  const current = desired(prior.cohort, sourceProfileVersion);
  const [docsManifest, managedManifest, foundationManifest, mutationManifest, authoringManifest] =
    await Promise.all([
      readFile(join(coreRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(join(packageRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(join(foundationRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(join(repositoryMutationRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(join(documentAuthoringRoot, "package.json"), "utf8").then(JSON.parse)
    ]);
  let target = cohortV2("docs-one-command-v2-target", {
    upgradeFrom: [prior.cohort.cohortId]
  });
  target = {
    ...target,
    packages: {
      repositoryMutation: { version: mutationManifest.version, integrity: V2_INTEGRITY },
      documentAuthoring: { version: authoringManifest.version, integrity: V2_INTEGRITY },
      docsProtocol: { version: docsManifest.version, integrity: V2_INTEGRITY },
      docsProtocolAgentTeams: { version: managedManifest.version, integrity: V2_INTEGRITY },
      engineeringFoundation: { version: foundationManifest.version, integrity: V2_INTEGRITY }
    }
  };
  target = {
    ...target,
    assets: describeCanonicalConsumerAssets(target),
    runtime: {
      ...target.runtime,
      runtimeClosureDigest: computePnpmRuntimeClosureDigestV2(lockfileObjectForV2(target), target)
    }
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
    writeFile(fakeCorepack, fakeCorepackSource(historicalDocsRoot)),
    writeFile(join(consumerRoot, ".gitignore"), "node_modules/\n"),
    writeFile(join(historicalDocsRoot, "package.json"), '{"type":"commonjs"}\n'),
    writeFile(join(historicalDocsRoot, "dist", "cli.js"), historicalDocsCheckFixtureSource())
  ]);
  await chmod(fakeCorepack, 0o755);
  runGit(consumerRoot, ["init", "-q"]);
  runGit(consumerRoot, ["config", "user.email", "sandbox@example.invalid"]);
  runGit(consumerRoot, ["config", "user.name", "Docs Upgrade Sandbox"]);
  runGit(consumerRoot, ["add", "--all"]);
  runGit(consumerRoot, ["commit", "-qm", "test: seed disposable docs consumer"]);

  const originalPath = process.env.PATH;
  const originalDocs = process.env.DOCS_UPGRADE_TEST_DOCS_PACKAGE;
  const originalFoundation = process.env.DOCS_UPGRADE_TEST_FOUNDATION_PACKAGE;
  const originalManaged = process.env.DOCS_UPGRADE_TEST_MANAGED_PACKAGE;
  const originalDocumentAuthoring = process.env.DOCS_UPGRADE_TEST_DOCUMENT_AUTHORING_PACKAGE;
  const originalRepositoryMutation =
    process.env.DOCS_UPGRADE_TEST_REPOSITORY_MUTATION_PACKAGE;
  const restoreGitHubIdentity = useGitHubRepositoryIdentity(REPOSITORY);
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
  process.env.DOCS_UPGRADE_TEST_DOCS_PACKAGE = coreRoot;
  process.env.DOCS_UPGRADE_TEST_FOUNDATION_PACKAGE = foundationRoot;
  process.env.DOCS_UPGRADE_TEST_MANAGED_PACKAGE = packageRoot;
  process.env.DOCS_UPGRADE_TEST_DOCUMENT_AUTHORING_PACKAGE = documentAuthoringRoot;
  process.env.DOCS_UPGRADE_TEST_REPOSITORY_MUTATION_PACKAGE = repositoryMutationRoot;
  try {
    const createUpgrade = (sandbox) => createConsumerUpgradeUseCase({
      assets: packageConsumerAssetCatalogReader,
      authority: { read: async () => authority },
      input: nodeConsumerIntegrationInputReader,
      planning: consumerIntegrationPlanningPorts,
      sandbox,
      transaction: foundationKnownFileTransaction
    });
    const upgrade = createUpgrade(new NodeConsumerUpgradeSandbox());
    const dirtyPath = join(consumerRoot, "uncommitted.txt");
    await writeFile(dirtyPath, "must block\n");
    await assert.rejects(
      upgrade({ consumerRoot, targetGeneration: 2, to: target.cohortId }),
      (error) => error?.code === "DOCS_CONSUMER_UPGRADE_DIRTY_WORKTREE"
    );
    await rm(dirtyPath);
    if (sourceProfileVersion === 2) {
      const originalProfile = await readFile(profilePath);
      const activationFailure = new Error("forced historical profile-v2 activation failure");
      const rollbackSandbox = new NodeConsumerUpgradeSandbox();
      const failedUpgrade = createUpgrade({
        prepareV1ToV2: (options) => rollbackSandbox.prepareV1ToV2(options),
        activateAndVerifyV2: async (options) => {
          await rollbackSandbox.activateAndVerifyV2(options);
          throw activationFailure;
        },
        restoreAndVerifyV1: (options) => rollbackSandbox.restoreAndVerifyV1(options)
      });
      await assert.rejects(
        failedUpgrade({ consumerRoot, targetGeneration: 2, to: target.cohortId }),
        (error) => error === activationFailure
      );
      assert.deepEqual(await readFile(profilePath), originalProfile);
      assert.equal(runGit(consumerRoot, ["diff", "--exit-code", "HEAD"]), "");
      const historicalCheck = JSON.parse(await readFile(
        join(historicalDocsRoot, "last-check.json"), "utf8"
      ));
      assert.equal(historicalCheck.schemaVersion, 2);
      assert.equal(historicalCheck.cohortId, prior.cohort.cohortId);
    }
    const execution = await upgrade({
      consumerRoot,
      targetGeneration: 2,
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
    assert.equal(profile.schemaVersion, 3);
    assert.equal(
      manifest.devDependencies["@agent-teams/docs-protocol"],
      target.packages.docsProtocol.version
    );
    assert.equal(
      manifest.devDependencies["@agent-teams/engineering-foundation"],
      target.packages.engineeringFoundation.version
    );
    assert.equal(
      manifest.devDependencies["@agent-teams/docs-protocol-agent-teams"],
      target.packages.docsProtocolAgentTeams.version
    );
    assert.deepEqual(manifest.untouched, { retained: true });
    assert.equal(
      JSON.parse(lockfile).importers["."].devDependencies["@agent-teams/docs-protocol"].specifier,
      target.packages.docsProtocol.version
    );
    assert.match(
      workspace,
      new RegExp(`@agent-teams/docs-protocol@${target.packages.docsProtocol.version}`, "u")
    );
    assert.match(
      workspace,
      new RegExp(
        `@agent-teams/docs-protocol-agent-teams@${target.packages.docsProtocolAgentTeams.version}`,
        "u"
      )
    );
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
    const repeated = await replay({ consumerRoot, targetGeneration: 2, to: target.cohortId });
    assert.equal(repeated.outcome, "current");
    assert.equal(authorityReads, 0);
  } finally {
      await cleanupOneCommandSandbox({
        disposable,
        originalPath,
        originalDocs,
        originalFoundation,
        originalManaged,
        originalDocumentAuthoring,
        originalRepositoryMutation,
        restoreGitHubIdentity
      });
  }
});

}

test("upgrades, reverses a failed activation, and downgrades one disposable profile-v3 consumer", {
  skip: process.platform === "win32"
}, async () => {
  const disposable = await mkdtemp(join(tmpdir(), "docs-v3-one-command-e2e-"));
  const consumerRoot = join(disposable, "consumer");
  const fakeBin = join(disposable, "bin");
  await Promise.all([
    mkdir(join(consumerRoot, "architecture", "foundation"), { recursive: true }),
    mkdir(join(consumerRoot, ".agents", "skills", "docs-authoring"), { recursive: true }),
    mkdir(join(consumerRoot, ".github", "workflows"), { recursive: true }),
    mkdir(fakeBin, { recursive: true })
  ]);
  const [docsManifest, managedManifest, foundationManifest, mutationManifest, authoringManifest] =
    await Promise.all([
      readFile(join(coreRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(join(packageRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(join(foundationRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(join(repositoryMutationRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(join(documentAuthoringRoot, "package.json"), "utf8").then(JSON.parse)
    ]);
  let sourceBinding = cohortV2("docs-v2-e2e-source");
  sourceBinding = {
    ...sourceBinding,
    packages: {
      repositoryMutation: { version: mutationManifest.version, integrity: V2_INTEGRITY },
      documentAuthoring: { version: authoringManifest.version, integrity: V2_INTEGRITY },
      docsProtocol: { version: docsManifest.version, integrity: V2_INTEGRITY },
      docsProtocolAgentTeams: { version: managedManifest.version, integrity: V2_INTEGRITY },
      engineeringFoundation: { version: foundationManifest.version, integrity: V2_INTEGRITY }
    }
  };
  sourceBinding = {
    ...sourceBinding,
    assets: describeCanonicalConsumerAssets(sourceBinding),
    runtime: {
      ...sourceBinding.runtime,
      runtimeClosureDigest: computePnpmRuntimeClosureDigestV2(
        lockfileObjectForV2(sourceBinding),
        sourceBinding
      )
    }
  };
  const current = desiredV3(sourceBinding);
  const targetProvisional = {
    ...structuredClone(sourceBinding),
    cohortId: "docs-v2-e2e-target",
    recordDigest: `sha256:${"6".repeat(64)}`,
    qualificationEventDigest: `sha256:${"7".repeat(64)}`,
    upgradeFrom: [sourceBinding.cohortId],
    rollbackTo: [sourceBinding.cohortId],
    workflow: {
      ...sourceBinding.workflow,
      revision: "5".repeat(40),
      blobSha: "6".repeat(40)
    }
  };
  const target = {
    ...targetProvisional,
    assets: describeCanonicalConsumerAssets(targetProvisional)
  };
  const authority = Object.freeze({
    repository: "agent-teams-ai/.github",
    path: "governance/docs-qualified-cohorts.json",
    revision: "8".repeat(40),
    cohort: target
  });
  const route = Buffer.from(canonicalManagedRoute(current.skillPath));
  const skill = Buffer.from(readFileSync(join(packageRoot, "skills/docs/SKILL.md")));
  const caller = Buffer.from(canonicalCallerWorkflow(sourceBinding));
  const managedState = canonicalManagedState(current, {
    skillDigest: digestBytes(skill),
    callerWorkflowDigest: digestBytes(caller),
    assetCatalogDigest: sourceBinding.assets.assetCatalogDigest,
    transitionCatalogDigest: sourceBinding.assets.transitionCatalogDigest,
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
      `${JSON.stringify(sourceManifestV2(sourceBinding, current.profilePath), null, 2)}\n`
    ),
    writeFile(join(consumerRoot, "pnpm-lock.yaml"), lockfileForV2(sourceBinding)),
    writeFile(join(consumerRoot, ".node-version"), "24.18.0\n"),
    writeFile(join(consumerRoot, ".gitignore"), "node_modules/\n"),
    writeFile(join(consumerRoot, "AGENTS.md"), route),
    writeFile(join(consumerRoot, current.skillPath), skill),
    writeFile(join(consumerRoot, current.callerWorkflowPath), caller),
    writeFile(join(consumerRoot, current.managedStatePath), managedState),
    writeFile(join(consumerRoot, "pnpm-workspace.yaml"), `packages: []
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
${Object.entries(sourceBinding.packages).map(([key, coordinate]) => {
    const names = {
      repositoryMutation: "repository-mutation",
      documentAuthoring: "document-authoring",
      docsProtocol: "docs-protocol",
      docsProtocolAgentTeams: "docs-protocol-agent-teams",
      engineeringFoundation: "engineering-foundation"
    };
    return `  - "@agent-teams/${names[key]}@${coordinate.version}"`;
  }).join("\n")}
  - "unrelated@1.0.0"
`),
    writeFile(fakeCorepack, fakeCorepackSource())
  ]);
  await chmod(fakeCorepack, 0o755);
  runGit(consumerRoot, ["init", "-q"]);
  runGit(consumerRoot, ["config", "user.email", "sandbox@example.invalid"]);
  runGit(consumerRoot, ["config", "user.name", "Docs V3 Upgrade Sandbox"]);
  runGit(consumerRoot, ["add", "--all"]);
  runGit(consumerRoot, ["commit", "-qm", "test: seed disposable docs v3 consumer"]);
  const sourceHead = runGit(consumerRoot, ["rev-parse", "HEAD"]);
  const sourceTree = runGit(consumerRoot, ["rev-parse", "HEAD^{tree}"]);

  const originalPath = process.env.PATH;
  const originalDocs = process.env.DOCS_UPGRADE_TEST_DOCS_PACKAGE;
  const originalFoundation = process.env.DOCS_UPGRADE_TEST_FOUNDATION_PACKAGE;
  const originalManaged = process.env.DOCS_UPGRADE_TEST_MANAGED_PACKAGE;
  const originalDocumentAuthoring = process.env.DOCS_UPGRADE_TEST_DOCUMENT_AUTHORING_PACKAGE;
  const originalRepositoryMutation =
    process.env.DOCS_UPGRADE_TEST_REPOSITORY_MUTATION_PACKAGE;
  const restoreGitHubIdentity = useGitHubRepositoryIdentity(REPOSITORY);
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
  process.env.DOCS_UPGRADE_TEST_DOCS_PACKAGE = coreRoot;
  process.env.DOCS_UPGRADE_TEST_FOUNDATION_PACKAGE = foundationRoot;
  process.env.DOCS_UPGRADE_TEST_MANAGED_PACKAGE = packageRoot;
  process.env.DOCS_UPGRADE_TEST_DOCUMENT_AUTHORING_PACKAGE = documentAuthoringRoot;
  process.env.DOCS_UPGRADE_TEST_REPOSITORY_MUTATION_PACKAGE = repositoryMutationRoot;
  try {
    const realSandbox = new NodeConsumerUpgradeSandbox();
    const upgrade = createConsumerUpgradeUseCase({
      assets: packageConsumerAssetCatalogReader,
      authority: { read: async () => authority },
      input: nodeConsumerIntegrationInputReader,
      planning: consumerIntegrationPlanningPorts,
      sandbox: realSandbox,
      transaction: foundationKnownFileTransaction
    });
    const execution = await upgrade({ consumerRoot, targetGeneration: 2, to: target.cohortId });
    await assertConsumerUpgradeExecutionSchema(execution);
    assert.deepEqual(
      [execution.outcome, execution.authority.revision],
      ["upgraded", authority.revision]
    );
    const [profile, manifest, callerAfter, stateAfter] = await Promise.all([
      readFile(profilePath, "utf8").then(JSON.parse),
      readFile(join(consumerRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(join(consumerRoot, current.callerWorkflowPath), "utf8"),
      readFile(join(consumerRoot, current.managedStatePath), "utf8").then(JSON.parse)
    ]);
    assert.deepEqual(profile.cohort, target);
    assert.equal(callerAfter, canonicalCallerWorkflow(target));
    assert.deepEqual(
      Object.keys(manifest.devDependencies).filter((name) => name.startsWith("@agent-teams/"))
        .toSorted(),
      [
        "@agent-teams/docs-protocol",
        "@agent-teams/docs-protocol-agent-teams",
        "@agent-teams/engineering-foundation"
      ]
    );
    assert.equal(stateAfter.schemaVersion, 2);
    assert.equal(stateAfter.cohortId, target.cohortId);
    const checked = await nodeConsumerIntegrationInputReader.read({ consumerRoot });
    assert.equal(checked.desired.cohort.cohortId, target.cohortId);

    runGit(consumerRoot, [
      "add", "--all", "--", ".",
      ":(exclude).agent-teams-local", ":(exclude).agent-teams-local/**"
    ]);
    runGit(consumerRoot, ["commit", "-qm", "test: checkpoint disposable v3 target"]);
    const targetHead = runGit(consumerRoot, ["rev-parse", "HEAD"]);
    const targetTree = runGit(consumerRoot, ["rev-parse", "HEAD^{tree}"]);
    const rollbackAuthority = Object.freeze({
      ...authority,
      cohort: sourceBinding
    });
    const activationFailure = new Error("forced disposable v3 activation failure");
    const failingRollback = createConsumerUpgradeUseCase({
      assets: packageConsumerAssetCatalogReader,
      authority: { read: async () => rollbackAuthority },
      input: nodeConsumerIntegrationInputReader,
      planning: consumerIntegrationPlanningPorts,
      sandbox: {
        prepareV1: (options) => realSandbox.prepareV1(options),
        activateAndVerifyV1: (options) => realSandbox.activateAndVerifyV1(options),
        restoreAndVerifyV1: (options) => realSandbox.restoreAndVerifyV1(options),
        prepareV2: (options) => realSandbox.prepareV2(options),
        activateAndVerifyV2: async () => {throw activationFailure;},
        restoreAndVerifyV2: (options) => realSandbox.restoreAndVerifyV2(options)
      },
      transaction: foundationKnownFileTransaction
    });
    await assert.rejects(
      failingRollback({ consumerRoot, targetGeneration: 2, to: sourceBinding.cohortId }),
      (error) => error === activationFailure
    );
    assert.equal(runGit(consumerRoot, ["rev-parse", "HEAD"]), targetHead);
    assert.equal(runGit(consumerRoot, ["write-tree"]), targetTree);
    assert.equal(runGit(consumerRoot, [
      "status", "--porcelain=v1", "--untracked-files=all", "--", ".",
      ":(exclude).agent-teams-local", ":(exclude).agent-teams-local/**"
    ]), "");
    assert.equal(
      JSON.parse(await readFile(profilePath, "utf8")).cohort.cohortId,
      target.cohortId
    );

    const downgrade = createConsumerUpgradeUseCase({
      assets: packageConsumerAssetCatalogReader,
      authority: { read: async () => rollbackAuthority },
      input: nodeConsumerIntegrationInputReader,
      planning: consumerIntegrationPlanningPorts,
      sandbox: realSandbox,
      transaction: foundationKnownFileTransaction
    });
    const downgraded = await downgrade({ consumerRoot, targetGeneration: 2, to: sourceBinding.cohortId });
    assert.equal(downgraded.outcome, "upgraded");
    const [sourceProfile, sourceManifestAfter, sourceCaller, sourceState] = await Promise.all([
      readFile(profilePath, "utf8").then(JSON.parse),
      readFile(join(consumerRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(join(consumerRoot, current.callerWorkflowPath), "utf8"),
      readFile(join(consumerRoot, current.managedStatePath), "utf8").then(JSON.parse)
    ]);
    assert.deepEqual(sourceProfile.cohort, sourceBinding);
    assert.equal(sourceCaller, canonicalCallerWorkflow(sourceBinding));
    assert.equal(sourceState.cohortId, sourceBinding.cohortId);
    assert.deepEqual(
      Object.fromEntries(Object.entries(sourceManifestAfter.devDependencies).filter(
        ([name]) => name.startsWith("@agent-teams/")
      )),
      sourceManifestV2(sourceBinding, current.profilePath).devDependencies
    );
    runGit(consumerRoot, [
      "add", "--all", "--", ".",
      ":(exclude).agent-teams-local", ":(exclude).agent-teams-local/**"
    ]);
    assert.equal(
      runGit(consumerRoot, ["write-tree"]),
      sourceTree,
      runGit(consumerRoot, ["diff", "--cached", "--name-status", sourceHead])
    );
  } finally {
    await cleanupOneCommandSandbox({
      disposable,
      originalPath,
      originalDocs,
      originalFoundation,
      originalManaged,
      originalDocumentAuthoring,
      originalRepositoryMutation,
      restoreGitHubIdentity
    });
  }
});

registerConsumerRestorationTests({ cohortV2, desired, rawRegistry, sourceCohort });

registerRestorationFinalizationTests({ cohortV2, desired });

registerRestorationSelectionTests({ cohortV2, desired });

function consumerClosureVariant(cohort) {
  const lock = lockfileObjectForV2(cohort);
  const locator = `@agent-teams/repository-mutation@${cohort.packages.repositoryMutation.version}`;
  lock.snapshots[locator].dependencies = { "registry-leaf": "2.0.0" };
  lock.snapshots[locator].optionalDependencies = { "@types/node": "24.18.0" };
  lock.packages[locator].peerDependencies = { "@types/node": "*" };
  lock.packages[locator].peerDependenciesMeta = { "@types/node": { optional: true } };
  for (const key of ["registry-leaf@2.0.0", "@types/node@24.18.0"]) {
    lock.packages[key] = { resolution: { integrity: V2_INTEGRITY } };
    lock.snapshots[key] = {};
  }
  lock.packages["registry-leaf@2.0.0"].resolution.tarball = "https://registry.npmjs.org/registry-leaf/-/registry-leaf-2.0.0.tgz";
  lock.packages["@types/node@24.18.0"].resolution.tarball = "https://registry.npmjs.org/@types/node/-/node-24.18.0.tgz";
  return lock;
}

async function consumerClosureFixture() {
  const cohort = cohortV2("docs-consumer-closure-test");
  cohort.runtime.runtimeClosureDigest = computePnpmRuntimeClosureDigestV2(lockfileObjectForV2(cohort), cohort);
  const target = desiredV3(cohort);
  const root = await mkdtemp(join(tmpdir(), "TEST-consumer-closure-"));
  const restoreIdentity = useGitHubRepositoryIdentity(target.repository);
  const lock = consumerClosureVariant(cohort);
  await mkdir(join(root, "architecture/foundation"), { recursive: true });
  await writeFile(join(root, "architecture/foundation/docs-consumer-integration.json"), JSON.stringify(target));
  await writeFile(join(root, "package.json"), JSON.stringify(sourceManifestV2(cohort, target.profilePath)));
  await writeFile(join(root, ".node-version"), "24.18.0\n");
  runGit(root, ["init", "-q"]);
  return { root, target, lock, close: async () => {
    restoreIdentity(); await rm(root, { recursive: true, force: true });
  } };
}

const closureBytes = (lock) => Buffer.from(JSON.stringify(lock));

test("consumer v3 reads its registry closure without replacing isolated authority", async () => {
  const fixture = await consumerClosureFixture();
  try {
    const { assertQualifiedPnpmLockfileV2 } = await import("../dist/consumer-integration/adapters/pnpm-lockfile-validator-v2.js");
    const authority = JSON.stringify(fixture.target);
    const bytes = closureBytes(fixture.lock);
    assert.notEqual(computePnpmRuntimeClosureDigestV2(fixture.lock, fixture.target.cohort),
      fixture.target.cohort.runtime.runtimeClosureDigest);
    assert.throws(() => assertQualifiedPnpmLockfileV2(bytes, fixture.target),
      (error) => error?.code === "DOCS_CONSUMER_RUNTIME_CLOSURE_MISMATCH");
    await writeFile(join(fixture.root, "pnpm-lock.yaml"), bytes);
    const result = await nodeConsumerIntegrationInputReader.read({ consumerRoot: fixture.root });
    assert.equal(JSON.stringify(result.desired), authority);
    assert.deepEqual(result.snapshot.lockfile.bytes, bytes);
    for (const tarball of ["/registry-leaf/-/registry-leaf-2.0.0.tgz", "registry-leaf/-/registry-leaf-2.0.0.tgz",
      "https://registry.npmjs.org:443/registry-leaf/-/registry-leaf-2.0.0.tgz"]) {
      const variant = structuredClone(fixture.lock);
      variant.packages["registry-leaf@2.0.0"].resolution.tarball = tarball;
      const variantBytes = closureBytes(variant);
      await writeFile(join(fixture.root, "pnpm-lock.yaml"), variantBytes);
      const observed = await nodeConsumerIntegrationInputReader.read({ consumerRoot: fixture.root });
      assert.equal(JSON.stringify(observed.desired), authority);
      assert.deepEqual(observed.snapshot.lockfile.bytes, variantBytes);
    }
  } finally {await fixture.close();}
});

test("consumer v3 still refuses invalid coordinates, roles, edges and graph evidence", async () => {
  const fixture = await consumerClosureFixture();
  const mutation = "@agent-teams/repository-mutation@1.0.0";
  try {
    for (const mutate of [
      (lock) => {lock.packages[mutation].resolution.integrity = `sha512-${"B".repeat(86)}==`;},
      (lock) => {lock.importers["."].dependencies = lock.importers["."].devDependencies; delete lock.importers["."].devDependencies;},
      (lock) => {delete lock.snapshots["@agent-teams/document-authoring@1.0.0"].dependencies["@agent-teams/repository-mutation"];},
      (lock) => {lock.importers["."].devDependencies.alias = { specifier: "npm:@agent-teams/repository-mutation@1.0.0", version: mutation };},
      (lock) => {lock.packages["@agent-teams/repository-mutation@2.0.0"] = lock.packages[mutation]; lock.snapshots["@agent-teams/repository-mutation@2.0.0"] = {};},
      (lock) => {delete lock.snapshots["registry-leaf@2.0.0"];},
      (lock) => {lock.packages["registry-leaf@2.0.0"].resolution.integrity = "sha512-invalid";},
      (lock) => {lock.packages["registry-leaf@2.0.0"].resolution.tarball = "https://attacker.invalid/payload.tgz";},
      (lock) => {lock.packages["@types/node@24.18.0"].resolution.tarball = "https://registry.npmjs.org.attacker.invalid/payload.tgz";},
      (lock) => {lock.packages["registry-leaf@2.0.0"].resolution.tarball = 7;},
      (lock) => {Object.assign(lock.packages["registry-leaf@2.0.0"].resolution,
        { type: "git", repo: "https://attacker.invalid/repo.git", commit: "a".repeat(40) });},
      (lock) => {lock.packages["@types/node@24.18.0"].resolution.gitHosted = true;},
      (lock) => {Object.assign(lock.packages["registry-leaf@2.0.0"].resolution,
        { type: "directory", directory: "/tmp/foreign" });}
    ]) {
      const lock = structuredClone(fixture.lock);
      mutate(lock);
      await writeFile(join(fixture.root, "pnpm-lock.yaml"), closureBytes(lock));
      await assert.rejects(nodeConsumerIntegrationInputReader.read({ consumerRoot: fixture.root }),
        (error) => error?.code?.startsWith("DOCS_CONSUMER_"));
    }
  } finally {await fixture.close();}
});

test("restoration admits consumer closure variation but preserves the non-owned graph", async () => {
  const { assertRestorationLockScope } = await import("../dist/consumer-integration/adapters/node-consumer-restoration-lock.js");
  const { parse } = await import("yaml");
  const target = cohortV2("docs-restoration-closure-test");
  target.runtime.runtimeClosureDigest = computePnpmRuntimeClosureDigestV2(lockfileObjectForV2(target), target);
  const source = { cohort: { packages: {
    docsProtocol: { version: "0.1.0", integrity: V2_INTEGRITY },
    engineeringFoundation: { version: "0.1.0", integrity: V2_INTEGRITY }
  }, runtime: { runtimeClosureDigest: `sha256:${"0".repeat(64)}` } } };
  const before = parse(lockfileFor(source.cohort));
  const after = consumerClosureVariant(target);
  for (const lock of [before, after]) {
    lock.importers["."].devDependencies.foreign = { specifier: "1.0.0", version: "1.0.0" };
    lock.packages["foreign@1.0.0"] = { resolution: { integrity: V2_INTEGRITY } };
    lock.snapshots["foreign@1.0.0"] = {};
  }
  const authority = JSON.stringify(target);
  assert.doesNotThrow(() => assertRestorationLockScope(closureBytes(before), closureBytes(after), source, desiredV3(target)));
  assert.equal(JSON.stringify(target), authority);
  for (const tarball of ["/registry-leaf/-/registry-leaf-2.0.0.tgz",
    "https://registry.npmjs.org:443/registry-leaf/-/registry-leaf-2.0.0.tgz"]) {
    const variant = structuredClone(after);
    variant.packages["registry-leaf@2.0.0"].resolution.tarball = tarball;
    assert.doesNotThrow(() => assertRestorationLockScope(closureBytes(before), closureBytes(variant), source, desiredV3(target)));
  }
  for (const locator of ["registry-leaf@2.0.0", "@types/node@24.18.0"]) {
    const hostile = structuredClone(after);
    hostile.packages[locator].resolution.tarball = "https://attacker.invalid/payload.tgz";
    assert.throws(() => assertRestorationLockScope(closureBytes(before), closureBytes(hostile), source, desiredV3(target)),
      { message: `Runtime closure locator ${locator} must resolve from registry.npmjs.org.` });
    const alternateSource = structuredClone(after);
    Object.assign(alternateSource.packages[locator].resolution,
      { type: "git", repo: "https://attacker.invalid/repo.git", commit: "a".repeat(40) });
    assert.throws(() => assertRestorationLockScope(closureBytes(before), closureBytes(alternateSource), source, desiredV3(target)),
      /registry resolution/u);
  }
  after.packages["foreign@1.0.0"].resolution.integrity = `sha512-${"B".repeat(86)}==`;
  assert.throws(() => assertRestorationLockScope(closureBytes(before), closureBytes(after), source, desiredV3(target)),
    /non-owned/u);
});
