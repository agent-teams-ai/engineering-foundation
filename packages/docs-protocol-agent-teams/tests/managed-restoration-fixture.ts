import { consumerIntegrationPlanningPorts } from "../dist/consumer-integration/composition/consumer-integration-planner.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { compileKnownFileTransactionPlan } from "@agent-teams/repository-mutation";
import type {
  ConsumerUpgradeAuthorityV2,
  ConsumerUpgradeAuthorityV3,
} from "../dist/consumer-integration/domain/model.js";
import type { ConsumerUpgradeSandboxPort } from "../dist/consumer-integration/application/ports/consumer-upgrade.js";
import type { ManagedRestorationAuthorityReader } from "../dist/consumer-integration/application/ports/consumer-restoration.js";
import { createFixtureEnvironment } from "./restoration-fixture-environment.ts";
import { desired, managedDesired } from "./consumer-plan-v3-fixture.ts";
import { packageConsumerAssetCatalogReader } from "../dist/consumer-integration/adapters/package-consumer-asset-catalog.js";
import { managedRestorationRecorder } from "../dist/consumer-integration/adapters/node-managed-restoration-preparation.js";
import { projectConsumerUpgradeFiles } from "../dist/consumer-integration/adapters/consumer-upgrade-file-projectors.js";
import { INTEGRATION_PROFILE_PATH } from "../dist/consumer-integration/adapters/node-consumer-repository-files.js";
import {
  CANONICAL_DOCS_SKILL_V2,
  canonicalCallerWorkflow,
  canonicalDocsScripts,
  canonicalDocsScriptsDigest,
  canonicalManagedRoute,
  canonicalManagedState,
  describeCanonicalConsumerAssets,
  digestBytes,
} from "../dist/consumer-integration/application/policies/consumer-integration-assets.js";

export const revision = "a".repeat(40);
const names = {
  repositoryMutation: "@agent-teams/repository-mutation",
  documentAuthoring: "@agent-teams/document-authoring",
  docsProtocol: "@agent-teams/docs-protocol",
  docsProtocolAgentTeams: "@agent-teams/docs-protocol-agent-teams",
  engineeringFoundation: "@agent-teams/engineering-foundation",
} as const;
function lock(
  cohort: ConsumerUpgradeAuthorityV2["cohort"] | ConsumerUpgradeAuthorityV3["cohort"],
): Buffer {
  const coordinates = cohort.packages;
  const entries = Object.entries(names);
  const dependencies = (...keys: readonly (keyof typeof names)[]) =>
    Object.fromEntries(keys.map((key) => [names[key], coordinates[key].version]));
  const locator = (key: keyof typeof names) => `${names[key]}@${coordinates[key].version}`;
  return Buffer.from(
    `${JSON.stringify(
      {
        lockfileVersion: "9.0",
        settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
        importers: {
          ".": {
            devDependencies: Object.fromEntries(
              ["docsProtocol", "docsProtocolAgentTeams", "engineeringFoundation"].map((key) => {
                const entry = entries.find(([name]) => name === key)!;
                const coordinate = coordinates[entry[0] as keyof typeof names];
                return [entry[1], { specifier: coordinate.version, version: coordinate.version }];
              }),
            ),
          },
        },
        packages: Object.fromEntries(
          entries.map(([key]) => [
            locator(key as keyof typeof names),
            { resolution: { integrity: coordinates[key as keyof typeof names].integrity } },
          ]),
        ),
        snapshots: {
          [locator("repositoryMutation")]: {},
          [locator("documentAuthoring")]: { dependencies: dependencies("repositoryMutation") },
          [locator("docsProtocol")]: {
            dependencies: dependencies("documentAuthoring", "repositoryMutation"),
          },
          [locator("docsProtocolAgentTeams")]: {
            dependencies: dependencies("docsProtocol", "repositoryMutation"),
          },
          [locator("engineeringFoundation")]: {
            dependencies: dependencies("documentAuthoring", "repositoryMutation"),
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}
function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const projection = <T>(binding: T) => ({
  repository: "agent-teams-ai/.github" as const,
  path: "governance/docs-qualified-cohorts.json" as const,
  revision,
  cohort: binding,
});

const forbidden = async (): Promise<never> => {
  throw new Error("unselected historical path");
};

function fixtureSourceImages(
  current: ReturnType<typeof desired>,
  historical: { readonly skill: Uint8Array; readonly callerWorkflow: Uint8Array },
) {
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        name: "TEST-retained-generation3",
        private: true,
        packageManager: "pnpm@11.20.0",
        engines: { node: current.cohort.runtime.node },
        scripts: canonicalDocsScripts(current.profilePath),
        devDependencies: Object.fromEntries(
          ["docsProtocol", "docsProtocolAgentTeams", "engineeringFoundation"].map((key) => {
            const name = key as keyof typeof names;
            return [names[name], current.cohort.packages[name].version];
          }),
        ),
        consumerOwned: "preserve",
      },
      null,
      2,
    )}\n`,
  );
  const routeDigest = digestBytes(Buffer.from(canonicalManagedRoute(current.skillPath)));
  const docsScriptsDigest = canonicalDocsScriptsDigest(current.profilePath);
  const originals = new Map([
    [INTEGRATION_PROFILE_PATH, Buffer.from(`${JSON.stringify(current, null, 2)}\n`)],
    ["package.json", manifest],
    ["pnpm-lock.yaml", lock(current.cohort)],
    ["AGENTS.md", Buffer.from(canonicalManagedRoute(current.skillPath))],
    [".node-version", Buffer.from("24.21.0\n")],
    [current.skillPath, Buffer.from(historical.skill)],
    [current.callerWorkflowPath, Buffer.from(historical.callerWorkflow)],
    [
      current.managedStatePath,
      Buffer.from(
        canonicalManagedState(current, {
          ...current.cohort.assets,
          agentsRouteDigest: routeDigest,
          docsScriptsDigest,
        }),
      ),
    ],
  ]);
  return { manifest, originals, routeDigest, docsScriptsDigest };
}

export async function retainedFixture(t: TestContext) {
  const disposable = await mkdtemp(join(tmpdir(), "TEST-managed-retained3-"));
  const root = join(disposable, "consumer");
  await mkdir(root);
  t.after(() => rm(disposable, { recursive: true, force: true }));
  const historical = (await packageConsumerAssetCatalogReader.read()).historicalV2Bundles?.find(
    ({ cohort }) => cohort.cohortId === "docs-2026-10-03-stable31",
  );
  assert.ok(historical);
  const current = { ...desired(), cohort: historical.cohort };
  const environment = createFixtureEnvironment();
  environment.setEnv("GITHUB_REPOSITORY_ID", current.repository.id);
  environment.setEnv("GITHUB_REPOSITORY", current.repository.nameWithOwner);
  t.after(() => {
    environment.restoreEnvironment();
  });
  const provisional = managedDesired();
  const cohort: ConsumerUpgradeAuthorityV3["cohort"] = {
    ...provisional.cohort,
    recordDigest: `sha256:${"1".repeat(64)}`,
    qualificationEventDigest: `sha256:${"2".repeat(64)}`,
    upgradeFrom: [current.cohort.cohortId],
    rollbackTo: [current.cohort.cohortId],
  };
  const target = {
    ...provisional,
    cohort: { ...cohort, assets: describeCanonicalConsumerAssets(cohort) },
  };
  const authority: ManagedRestorationAuthorityReader & {
    read: () => Promise<ConsumerUpgradeAuthorityV3>;
  } = {
    read: async () => projection(target.cohort),
    readManagedRestoration: async () => ({ revision, target: projection(current.cohort) }),
  };
  const { manifest, originals, routeDigest, docsScriptsDigest } = fixtureSourceImages(
    current,
    historical,
  );
  for (const [path, bytes] of originals) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes, { mode: 0o644 });
  }
  await writeFile(join(root, ".gitignore"), ".agent-teams-local/\nnode_modules/\n");
  git(root, "init", "-q");
  git(root, "config", "user.name", "Managed restoration TEST fixture");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "add", "--all");
  git(root, "commit", "-qm", "test: seed disposable stable31 source");
  const sourceRevision = git(root, "rev-parse", "HEAD");
  const projected = await projectConsumerUpgradeFiles({
    current,
    authority: projection(target.cohort),
    manifest,
    profile: originals.get(INTEGRATION_PROFILE_PATH)!,
  });
  const postimages = new Map(originals);
  postimages.set(INTEGRATION_PROFILE_PATH, Buffer.from(projected.profile));
  postimages.set("package.json", Buffer.from(projected.manifest));
  postimages.set(".node-version", Buffer.from(projected.nodeVersion!));
  postimages.set("pnpm-lock.yaml", lock(target.cohort));
  postimages.set(current.skillPath, Buffer.from(CANONICAL_DOCS_SKILL_V2));
  postimages.set(current.callerWorkflowPath, Buffer.from(canonicalCallerWorkflow(target.cohort)));
  postimages.set(
    current.managedStatePath,
    Buffer.from(
      canonicalManagedState(target, {
        ...target.cohort.assets,
        agentsRouteDigest: routeDigest,
        docsScriptsDigest,
      }),
    ),
  );
  const plan = compileKnownFileTransactionPlan({
    operations: [...postimages]
      .filter(([path, bytes]) => !originals.get(path)!.equals(bytes))
      .map(([path, bytes]) => ({
        path,
        precondition: {
          state: "known-file",
          acceptedPreimages: [{ bytes: originals.get(path)!, mode: 0o644 }],
        },
        postimage: { bytes, mode: 0o644 },
      })),
  });
  const proofPath = join(disposable, "selected.json");
  const prepare = () =>
    managedRestorationRecorder(authority)({
      consumerRoot: root,
      sourceRevision,
      current,
      target: target.cohort,
      plan,
      proofPath,
    });
  const activation: string[] = [];
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
    prepareManaged: forbidden,
    activateAndVerifyV1: forbidden,
    activateAndVerifyV2: forbidden,
    restoreAndVerifyV1: forbidden,
    restoreAndVerifyV2: forbidden,
    activateAndVerifyManaged: async () => {
      assert.equal(await readFile(join(root, ".node-version"), "utf8"), "26.11.1\n");
      activation.push("target");
    },
    restoreAndVerifyManaged: async () => {
      assert.equal(await readFile(join(root, ".node-version"), "utf8"), "24.21.0\n");
      activation.push("origin");
    },
  };
  const options = {
    consumerRoot: root,
    sourceGeneration: 2 as const,
    targetGeneration: 3 as const,
    from: current.cohort.cohortId,
    to: target.cohort.cohortId,
    preparationPath: `${proofPath}.prepared`,
    proofPath,
  };
  return {
    disposable,
    root,
    current,
    target,
    originals,
    postimages,
    authority,
    planning: consumerIntegrationPlanningPorts,
    sandbox,
    prepare,
    activation,
    options,
  };
}

export { git as fixtureGit };
