import { Arguments } from "../dist/consumer-integration/adapters/inbound/consumer-cli-arguments.js";
import {
  executeFinalizationArguments,
  executeRestorationArguments,
} from "../dist/consumer-integration/adapters/inbound/consumer-restoration-cli.js";
import type { ManagedConsumerOperations } from "../dist/consumer-integration/application-api.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { desired, managedDesired, snapshot, file } from "./consumer-plan-v3-fixture.ts";
import { compileConsumerIntegration } from "../dist/consumer-integration/application/use-cases/plan-consumer-integration.js";
import { createConsumerUpgradeUseCase } from "../dist/consumer-integration/application/use-cases/upgrade-consumer-integration.js";
import type { ConsumerUpgradePorts } from "../dist/consumer-integration/application/use-cases/consumer-upgrade-inspection.js";
import { consumerIntegrationPlanningPorts } from "../dist/consumer-integration/composition/consumer-integration-planner.js";
import { foundationKnownFileTransaction } from "../dist/consumer-integration/composition/known-file-transaction.js";
import { packageConsumerAssetCatalogReader } from "../dist/consumer-integration/adapters/package-consumer-asset-catalog.js";
import {
  canonicalDocsScripts,
  canonicalManagedRoute,
} from "../dist/consumer-integration/application/policies/consumer-integration-assets.js";
import type {
  ConsumerIntegrationDesiredStateV3,
  ManagedSuccessorProfile,
  ConsumerUpgradeAuthorityV2,
  ConsumerUpgradeAuthorityV3,
  ConsumerIntegrationSnapshot,
} from "../dist/consumer-integration/domain/model.js";
import type { ConsumerUpgradeSandboxPort } from "../dist/consumer-integration/application/ports/consumer-upgrade.js";

const revision = "a".repeat(40);
const target = (): ManagedSuccessorProfile => {
  const profile = managedDesired();
  return {
    ...profile,
    cohort: {
      ...profile.cohort,
      recordDigest: `sha256:${"1".repeat(64)}`,
      qualificationEventDigest: `sha256:${"2".repeat(64)}`,
    },
  };
};
function selected(profile: ManagedSuccessorProfile): ConsumerUpgradeAuthorityV3 {
  return {
    repository: "agent-teams-ai/.github",
    path: "governance/docs-qualified-cohorts.json",
    revision,
    cohort: {
      ...profile.cohort,
      recordDigest: `sha256:${"1".repeat(64)}`,
      qualificationEventDigest: `sha256:${"2".repeat(64)}`,
    },
  };
}
function manifest(profile: ConsumerIntegrationDesiredStateV3 | ManagedSuccessorProfile) {
  return {
    name: "TEST-managed-transition",
    private: true,
    packageManager: "pnpm@11.20.0",
    engines: { node: profile.cohort.runtime.node },
    scripts: canonicalDocsScripts(profile.profilePath),
    devDependencies: {
      "@agent-teams/docs-protocol": profile.cohort.packages.docsProtocol.version,
      "@agent-teams/docs-protocol-agent-teams":
        profile.cohort.packages.docsProtocolAgentTeams.version,
      "@agent-teams/engineering-foundation": profile.cohort.packages.engineeringFoundation.version,
    },
    untouched: { owner: "consumer" },
  };
}
function currentSnapshot(
  profile: ConsumerIntegrationDesiredStateV3 | ManagedSuccessorProfile,
  catalog?: Awaited<ReturnType<typeof packageConsumerAssetCatalogReader.read>>,
): ConsumerIntegrationSnapshot {
  const initial = {
    ...snapshot(),
    integrationProfile: file(JSON.stringify(profile)),
    packageManifest: file(JSON.stringify(manifest(profile))),
    agents: file(canonicalManagedRoute(profile.skillPath)),
  };
  const compiled = compileConsumerIntegration(
    {
      desired: profile,
      snapshot: initial,
      ...(catalog === undefined ? {} : { assetCatalog: catalog }),
    },
    consumerIntegrationPlanningPorts,
  );
  assert.equal(compiled.plan.outcome, "change-required", JSON.stringify(compiled.plan.issues));
  assert.ok(compiled.mutationPlan);
  for (const operation of compiled.mutationPlan.operations) {
    const observation = file(Buffer.from(operation.postimage.contentBase64, "base64"));
    if (operation.path === profile.skillPath) {
      initial.skill = observation;
    }
    if (operation.path === profile.callerWorkflowPath) {
      initial.callerWorkflow = observation;
    }
    if (operation.path === profile.managedStatePath) {
      initial.managedState = observation;
    }
  }
  assert.equal(
    compileConsumerIntegration(
      {
        desired: profile,
        snapshot: initial,
        ...(catalog === undefined ? {} : { assetCatalog: catalog }),
      },
      consumerIntegrationPlanningPorts,
    ).plan.outcome,
    "current",
  );
  return initial;
}
const forbidden = async (): Promise<never> => {
  throw new Error("Legacy sandbox must not run for generation3");
};
async function fixture(
  t: TestContext,
  selection?: {
    current: ConsumerIntegrationDesiredStateV3 | ManagedSuccessorProfile;
    authority: ConsumerUpgradeAuthorityV2 | ConsumerUpgradeAuthorityV3;
  },
) {
  const root = await mkdtemp(join(tmpdir(), "TEST-managed-generation3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceNode = selection?.current.schemaVersion === 4 ? "26.11.1\n" : "24.21.0\n";
  const targetNode = selection?.authority.cohort.schemaVersion === 2 ? "24.21.0\n" : "26.11.1\n";
  await writeFile(join(root, ".node-version"), sourceNode, { mode: 0o644 });
  const mode = (await lstat(join(root, ".node-version"))).mode & 0o777;
  const current = selection?.current ?? desired();
  const successor = target();
  const authority = selection?.authority ?? selected(successor);
  const calls: string[] = [];
  const reads: Parameters<ConsumerUpgradePorts["authority"]["read"]>[0][] = [];
  const sandbox: ConsumerUpgradeSandboxPort = {
    restoreCommittedAndVerifyManaged: async (options) => {
      assert.equal(
        await readFile(join(options.consumerRoot, ".node-version"), "utf8"),
        "24.21.0\n",
      );
    },
    verifyManagedRuntime: async () => {},
    prepareV1: forbidden,
    prepareV2: forbidden,
    prepareV1ToV2: forbidden,
    activateAndVerifyV1: forbidden,
    activateAndVerifyV2: forbidden,
    restoreAndVerifyV1: forbidden,
    restoreAndVerifyV2: forbidden,
    prepareManaged: async (input) => {
      calls.push("prepare");
      assert.equal(input.current.schemaVersion, current.schemaVersion);
      assert.equal(input.authority.cohort.schemaVersion, authority.cohort.schemaVersion);
      assert.equal(input.expectedSourceRevision, revision);
      assert.ok(input.managedPreimages.managedState.digest.startsWith("sha256:"));
      return {
        operations: [
          {
            path: ".node-version",
            precondition: {
              state: "known-file",
              acceptedPreimages: [{ bytes: Buffer.from(sourceNode), mode }],
            },
            postimage: { bytes: Buffer.from(targetNode), mode },
          },
        ],
      };
    },
    activateAndVerifyManaged: async () => {
      calls.push("activate");
      assert.equal(await readFile(join(root, ".node-version"), "utf8"), targetNode);
    },
    restoreAndVerifyManaged: async () => {
      calls.push("restore");
      assert.equal(await readFile(join(root, ".node-version"), "utf8"), sourceNode);
    },
  };
  const ports: ConsumerUpgradePorts = {
    input: {
      read: async () => ({
        root,
        desired: current,
        repositoryHead: revision,
        snapshot: currentSnapshot(current),
      }),
    },
    assets: packageConsumerAssetCatalogReader,
    planning: consumerIntegrationPlanningPorts,
    authority: {
      read: async (input) => {
        reads.push(input);
        return authority;
      },
    },
    sandbox,
    transaction: foundationKnownFileTransaction,
  };
  return {
    root,
    ports,
    calls,
    reads,
    successor,
    current,
    authority,
    upgrade: createConsumerUpgradeUseCase(ports),
  };
}

export { revision, target, selected, manifest, currentSnapshot, forbidden, fixture };

function cliSelectionFixture() {
  const calls: unknown[] = [];
  const operations: ManagedConsumerOperations = {
    check: forbidden,
    plan: forbidden,
    apply: forbidden,
    recover: forbidden,
    upgrade: forbidden,
    finalize: async (options) => {
      calls.push(options);
      return { schemaVersion: 1, command: "consumer.finalize", outcome: "blocked", issues: [] };
    },
    restore: async (options) => {
      calls.push(options);
      return { schemaVersion: 1, command: "consumer.restore", outcome: "restored", issues: [] };
    },
  };
  const digest = `sha256:${"1".repeat(64)}`;
  return { calls, operations, digest };
}

export async function assertOriginalCliSelections(): Promise<void> {
  const { calls, operations, digest } = cliSelectionFixture();
  await executeFinalizationArguments(
    new Arguments([
      "--from",
      "docs-source",
      "--to",
      "docs-target",
      "--source-generation",
      "2",
      "--target-generation",
      "3",
      "--preparation",
      "/TEST/selected",
      "--proof",
      "/TEST/complete",
      "--expect",
      digest,
    ]),
    "/TEST/consumer",
    operations,
  );
  await executeRestorationArguments(
    new Arguments([
      "--from",
      "docs-target",
      "--to",
      "docs-source",
      "--source-generation",
      "3",
      "--target-generation",
      "2",
      "--preparation",
      "/TEST/selected",
      "--expect",
      digest,
    ]),
    "/TEST/consumer",
    operations,
  );
  assert.deepEqual(calls, [
    {
      consumerRoot: "/TEST/consumer",
      from: "docs-source",
      to: "docs-target",
      sourceGeneration: 2,
      targetGeneration: 3,
      preparationPath: "/TEST/selected",
      proofPath: "/TEST/complete",
      expect: digest,
    },
    {
      consumerRoot: "/TEST/consumer",
      from: "docs-target",
      to: "docs-source",
      sourceGeneration: 3,
      targetGeneration: 2,
      preparationPath: "/TEST/selected",
      expect: digest,
    },
  ]);
  await assert.rejects(
    executeRestorationArguments(
      new Arguments([
        "--from",
        "docs-target",
        "--to",
        "docs-source",
        "--source-generation",
        "3",
        "--target-generation",
        "2",
        "--proof",
        "/TEST/old-proof",
        "--expect",
        digest,
      ]),
      "/TEST/consumer",
      operations,
    ),
    { code: "DOCS_CONSUMER_CLI_INVALID" },
  );
  assert.equal(calls.length, 2);
}

export async function assertCurrentCliSelections(): Promise<void> {
  const { calls, operations, digest } = cliSelectionFixture();
  const base = [
    "--from",
    "docs-target",
    "--to",
    "docs-source",
    "--source-generation",
    "3",
    "--target-generation",
    "2",
    "--preparation",
    "/TEST/selected",
    "--expect",
    digest,
  ];
  await executeRestorationArguments(
    new Arguments([
      ...base,
      "--current-revision",
      revision,
      "--current-tree",
      "c".repeat(40),
      "--selection",
      "/TEST/current",
    ]),
    "/TEST/consumer",
    operations,
  );
  assert.deepEqual(calls, [
    {
      consumerRoot: "/TEST/consumer",
      from: "docs-target",
      to: "docs-source",
      sourceGeneration: 3,
      targetGeneration: 2,
      preparationPath: "/TEST/selected",
      expect: digest,
      currentRevision: revision,
      currentTree: "c".repeat(40),
      selectionPath: "/TEST/current",
    },
  ]);
  await assert.rejects(
    executeRestorationArguments(
      new Arguments([...base, "--current-revision", revision, "--selection", "/TEST/current"]),
      "/TEST/consumer",
      operations,
    ),
    { code: "DOCS_CONSUMER_CLI_INVALID" },
  );
  await assert.rejects(
    executeRestorationArguments(
      new Arguments([
        ...base,
        "--current-revision",
        revision,
        "--current-tree",
        "c".repeat(40),
        "--selection",
        "/TEST/current",
        "--selection-expect",
        "invalid",
      ]),
      "/TEST/consumer",
      operations,
    ),
    { code: "DOCS_CONSUMER_CLI_INVALID" },
  );
  assert.equal(calls.length, 1);
}
