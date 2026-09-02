import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { testPackedAgentWorkflow } from "./pack-agent-workflow-test.mjs";
import { testPackedQualityGateRunner } from "./pack-quality-gate-runner-test.mjs";
import { verifyPackedAuthorityScaffolding } from "./pack-scaffolding-test.mjs";
import { packPublishableArtifacts } from "./pack-publishable-artifacts.mjs";
import { createPackedConsumerFixture } from "./packed-consumer-fixture.mjs";
import { verifyPackedConsumer } from "./packed-consumer-e2e.mjs";
import { verifyPackedLocalMode } from "./packed-local-mode-e2e.mjs";
import {
  createPnpmRunner,
  localRegistryInstallQualification,
  runCommand
} from "./pack-test-support.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-teams-foundation-pack-"));
const keepTemporaryRoot = process.env.AGENT_TEAMS_KEEP_PACK_TEST_ARTIFACTS === "1";
const requireFromRepository = createRequire(import.meta.url);
const runPnpm = createPnpmRunner();
const repositoryManifest = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8")
);
async function installedVersion(packageName) {
  const manifestPath = requireFromRepository.resolve(`${packageName}/package.json`);
  return JSON.parse(await readFile(manifestPath, "utf8")).version;
}

async function toolingVersions() {
  return {
    oxlint: await installedVersion("oxlint"),
    oxlintTsgolint: await installedVersion("oxlint-tsgolint"),
    typescript: await installedVersion("typescript")
  };
}

function packageManagerVersion() {
  const packageManager = repositoryManifest.packageManager;
  if (typeof packageManager !== "string" || !/^pnpm@\d+\.\d+\.\d+$/u.test(packageManager)) {
    throw new Error("Repository packageManager must pin an exact pnpm version.");
  }
  return packageManager;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseDocsExecution(stdout) {
  if (typeof stdout !== "string" || stdout.trim() === "") {
    throw new Error("Packed Docs Protocol CLI returned no JSON output.");
  }
  return JSON.parse(stdout);
}

function rollbackFixtureRuntimeLock(cohort) {
  const docsLocator = `@agent-teams/docs-protocol@${cohort.packages.docsProtocol.version}`;
  const foundationLocator =
    `@agent-teams/engineering-foundation@${cohort.packages.engineeringFoundation.version}`;
  return {
    lockfileVersion: "9.0",
    importers: { ".": { devDependencies: {
      "@agent-teams/docs-protocol": {
        specifier: cohort.packages.docsProtocol.version,
        version: cohort.packages.docsProtocol.version
      },
      "@agent-teams/engineering-foundation": {
        specifier: cohort.packages.engineeringFoundation.version,
        version: cohort.packages.engineeringFoundation.version
      }
    } } },
    packages: {
      [docsLocator]: { resolution: { integrity: cohort.packages.docsProtocol.integrity } },
      [foundationLocator]: {
        resolution: { integrity: cohort.packages.engineeringFoundation.integrity }
      }
    },
    snapshots: {
      [docsLocator]: { dependencies: {
        "@agent-teams/engineering-foundation": cohort.packages.engineeringFoundation.version
      } },
      [foundationLocator]: {}
    }
  };
}

async function createRollbackFixturePackage(
  adapterArtifact,
  docsArtifact,
  foundationArtifact,
  mutationArtifact
) {
  const root = join(temporaryRoot, "docs-rollback-package-fixture");
  await mkdir(root, { recursive: true });
  await runCommand("tar", ["-xzf", adapterArtifact.archivePath, "-C", root], temporaryRoot);
  const extractedPackageRoot = join(root, "package");
  const api = await import(`${pathToFileURL(join(
    extractedPackageRoot,
    "dist", "consumer-integration", "application", "policies", "consumer-integration-assets.js"
  )).href}?rollback-fixture=1`);
  const closureApi = await import(`${pathToFileURL(join(
    extractedPackageRoot,
    "dist", "consumer-integration", "adapters", "pnpm-runtime-closure-v1.js"
  )).href}?rollback-fixture=1`);
  const packageManifest = JSON.parse(await readFile(join(extractedPackageRoot, "package.json"), "utf8"));
  packageManifest.dependencies["@agent-teams/docs-protocol"] = docsArtifact.archiveFileSpecifier;
  packageManifest.dependencies["@agent-teams/engineering-foundation"] =
    foundationArtifact.archiveFileSpecifier;
  packageManifest.dependencies["@agent-teams/repository-mutation"] =
    mutationArtifact.archiveFileSpecifier;
  await writeFile(
    join(extractedPackageRoot, "package.json"),
    `${JSON.stringify(packageManifest, null, 2)}\n`
  );
  const integrity = `sha512-${"A".repeat(86)}==`;
  const common = {
    schemaVersion: 1,
    channel: "rc",
    eligibleAfter: "2026-08-16T00:00:00Z",
    upgradeFrom: [],
    packages: {
      docsProtocol: { version: packageManifest.version, integrity },
      engineeringFoundation: {
        version: JSON.parse(await readFile(join(
          repositoryRoot,
          "packages", "engineering-foundation", "package.json"
        ), "utf8")).version,
        integrity
      }
    },
    schemas: { consumerIntegration: 1, managedState: 1, docsProtocol: 1 },
    runtime: {
      node: ">=24.18.0 <25",
      pnpm: ">=11.17.0 <12",
      runtimeClosureDigest: `sha256:${"e".repeat(64)}`
    }
  };
  const targetA = {
    ...common,
    cohortId: "packed-target-a",
    recordDigest: `sha256:${"a".repeat(64)}`,
    qualificationEventDigest: `sha256:${"b".repeat(64)}`,
    rollbackTo: [],
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: "6".repeat(40),
      blobSha: "7".repeat(40)
    },
    assets: {
      skillDigest: `sha256:${"0".repeat(64)}`,
      callerWorkflowDigest: `sha256:${"0".repeat(64)}`,
      assetCatalogDigest: `sha256:${"9".repeat(64)}`,
      transitionCatalogDigest: `sha256:${"8".repeat(64)}`
    }
  };
  targetA.packages = {
    docsProtocol: { version: "0.0.9", integrity },
    engineeringFoundation: { version: "0.16.1", integrity }
  };
  const targetSkill = Buffer.from(`${api.CANONICAL_DOCS_SKILL}\n<!-- qualified target A -->\n`);
  const targetCaller = Buffer.from(api.canonicalCallerWorkflow(targetA));
  targetA.assets = {
    ...targetA.assets,
    skillDigest: sha256(targetSkill),
    callerWorkflowDigest: sha256(targetCaller)
  };
  const sourceB = {
    ...common,
    cohortId: "packed-source-b",
    recordDigest: `sha256:${"c".repeat(64)}`,
    qualificationEventDigest: `sha256:${"d".repeat(64)}`,
    rollbackTo: [targetA.cohortId],
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: "1".repeat(40),
      blobSha: "2".repeat(40)
    },
    assets: {
      skillDigest: sha256(Buffer.from(api.CANONICAL_DOCS_SKILL_V2)),
      callerWorkflowDigest: `sha256:${"0".repeat(64)}`,
      assetCatalogDigest: `sha256:${"0".repeat(64)}`,
      transitionCatalogDigest: `sha256:${"0".repeat(64)}`
    }
  };
  sourceB.assets.callerWorkflowDigest = sha256(Buffer.from(
    api.canonicalCallerWorkflow(sourceB)
  ));
  sourceB.runtime = {
    ...sourceB.runtime,
    runtimeClosureDigest: closureApi.computePnpmRuntimeClosureDigestV1(
      rollbackFixtureRuntimeLock(sourceB),
      sourceB
    )
  };
  targetA.runtime = {
    ...targetA.runtime,
    runtimeClosureDigest: closureApi.computePnpmRuntimeClosureDigestV1(
      rollbackFixtureRuntimeLock(targetA),
      targetA
    )
  };
  const skillPath = `assets/history/sha256-${targetA.assets.skillDigest.slice(7)}/skill.md`;
  const callerPath = `assets/history/sha256-${targetA.assets.callerWorkflowDigest.slice(7)}/caller.yml`;
  await mkdir(join(extractedPackageRoot, skillPath, ".."), { recursive: true });
  await mkdir(join(extractedPackageRoot, callerPath, ".."), { recursive: true });
  await writeFile(join(extractedPackageRoot, skillPath), targetSkill);
  await writeFile(join(extractedPackageRoot, callerPath), targetCaller);
  const catalogBytes = await readFile(join(extractedPackageRoot, "assets", "catalog.json"));
  sourceB.assets.assetCatalogDigest = sha256(catalogBytes);
  const transitionCatalog = JSON.parse(await readFile(
    join(extractedPackageRoot, "assets", "transition-catalog.json"),
    "utf8"
  ));
  transitionCatalog.currentSourceExecutors = [{
    schemas: sourceB.schemas,
    runtime: sourceB.runtime,
    packages: sourceB.packages,
    assetCatalogDigest: sourceB.assets.assetCatalogDigest,
    skillDigest: sourceB.assets.skillDigest,
    callerWorkflowDigest: sourceB.assets.callerWorkflowDigest,
    agentsRouteDigest: sha256(Buffer.from(api.canonicalManagedRoute(
      ".agents/skills/docs-authoring/SKILL.md"
    ))),
    docsScriptsDigest: api.canonicalDocsScriptsDigest(
      "architecture/foundation/docs-protocol.yaml"
    ),
    directTargetCohortIds: [targetA.cohortId]
  }];
  transitionCatalog.directTargetBundles = [{
    cohort: targetA,
    skillPath,
    skillDigest: targetA.assets.skillDigest,
    callerWorkflowPath: callerPath,
    callerWorkflowDigest: targetA.assets.callerWorkflowDigest,
    agentsRouteDigest: transitionCatalog.currentSourceExecutors[0].agentsRouteDigest,
    docsScriptsDigest: transitionCatalog.currentSourceExecutors[0].docsScriptsDigest
  }];
  const transitionCatalogBytes = Buffer.from(`${JSON.stringify(transitionCatalog)}\n`);
  sourceB.assets.transitionCatalogDigest = sha256(transitionCatalogBytes);
  await writeFile(
    join(extractedPackageRoot, "assets", "transition-catalog.json"),
    transitionCatalogBytes
  );
  const archivePath = join(temporaryRoot, "agent-teams-docs-protocol-agent-teams-rollback-fixture.tgz");
  await runCommand("tar", ["-czf", archivePath, "package"], root);
  return {
    archiveFileSpecifier: `file:${archivePath.replaceAll("\\", "/")}`,
    sourceB,
    targetA
  };
}

async function verifyPackedDocsConsumerIntegration(input) {
  const consumerRoot = join(temporaryRoot, "docs-consumer-tarball-e2e");
  await mkdir(join(consumerRoot, "architecture", "foundation"), { recursive: true });
  await runCommand("git", ["init", "-q"], consumerRoot);
  const installedManifest = {
    name: "docs-consumer-tarball-e2e",
    private: true,
    packageManager: packageManagerVersion(),
    devDependencies: {
      "@agent-teams/document-authoring": input.authoring.archiveFileSpecifier,
      "@agent-teams/docs-protocol-agent-teams": input.adapter.archiveFileSpecifier,
      "@agent-teams/docs-protocol": input.docs.archiveFileSpecifier,
      "@agent-teams/engineering-foundation": input.foundation.archiveFileSpecifier,
      "@agent-teams/repository-mutation": input.mutation.archiveFileSpecifier
    }
  };
  await writeFile(join(consumerRoot, "package.json"), `${JSON.stringify(installedManifest, null, 2)}\n`);
  const localArtifactOverrides = {
    "@agent-teams/document-authoring": input.authoring.archiveFileSpecifier,
    "@agent-teams/docs-protocol": input.docs.archiveFileSpecifier,
    "@agent-teams/engineering-foundation": input.foundation.archiveFileSpecifier,
    "@agent-teams/repository-mutation": input.mutation.archiveFileSpecifier
  };
  await writeFile(
    join(consumerRoot, "pnpm-workspace.yaml"),
    `overrides:\n${Object.entries(localArtifactOverrides).map(([name, specifier]) =>
      `  ${JSON.stringify(name)}: ${JSON.stringify(specifier)}`).join("\n")}\n`
  );
  await writeFile(join(consumerRoot, ".node-version"), `${process.versions.node}\n`);
  await runPnpm(["install", "--ignore-scripts"], consumerRoot);
  await rm(join(consumerRoot, "node_modules"), { force: true, recursive: true });
  await runPnpm(
    ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
    consumerRoot
  );

  let cohort = input.adapter.sourceB;
  const desired = {
    schemaVersion: 1,
    repository: { provider: "github", id: "999999999", nameWithOwner: "agent-teams-ai/packed-docs-consumer-e2e" },
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    cohort
  };
  installedManifest.scripts = {};
  await writeFile(join(consumerRoot, "AGENTS.md"), "# Packed consumer\n");
  const writeAuthority = async () => {
    desired.cohort = cohort;
    installedManifest.devDependencies = {
      ...installedManifest.devDependencies,
      "@agent-teams/docs-protocol": cohort.packages.docsProtocol.version,
      "@agent-teams/engineering-foundation": cohort.packages.engineeringFoundation.version
    };
    await writeFile(join(consumerRoot, "package.json"), `${JSON.stringify(installedManifest, null, 2)}\n`);
    await writeFile(
      join(consumerRoot, "architecture", "foundation", "docs-consumer-integration.json"),
      `${JSON.stringify(desired, null, 2)}\n`
    );
    await writeFile(join(consumerRoot, "pnpm-lock.yaml"), `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      '@agent-teams/docs-protocol':
        specifier: ${cohort.packages.docsProtocol.version}
        version: ${cohort.packages.docsProtocol.version}
      '@agent-teams/engineering-foundation':
        specifier: ${cohort.packages.engineeringFoundation.version}
        version: ${cohort.packages.engineeringFoundation.version}
packages:
  '@agent-teams/docs-protocol@${cohort.packages.docsProtocol.version}':
    resolution: {integrity: ${cohort.packages.docsProtocol.integrity}}
  '@agent-teams/engineering-foundation@${cohort.packages.engineeringFoundation.version}':
    resolution: {integrity: ${cohort.packages.engineeringFoundation.integrity}}
snapshots:
  '@agent-teams/docs-protocol@${cohort.packages.docsProtocol.version}':
    dependencies:
      '@agent-teams/engineering-foundation': ${cohort.packages.engineeringFoundation.version}
  '@agent-teams/engineering-foundation@${cohort.packages.engineeringFoundation.version}': {}
`);
  };
  await writeAuthority();
  const cli = join(
    consumerRoot,
    "node_modules",
    "@agent-teams",
    "docs-protocol-agent-teams",
    "dist",
    "cli.js"
  );
  const invoke = async (args) => {
    try {
      const result = await runCommand(
        process.execPath,
        [cli, ...args, "--consumer", consumerRoot, "--json"],
        consumerRoot
      );
      return parseDocsExecution(result.stdout);
    } catch (error) {
      if (error?.code === 1 && typeof error.stdout === "string" && error.stdout.trim() !== "") {
        return parseDocsExecution(error.stdout);
      }
      throw error;
    }
  };
  const previousRepositoryId = process.env["GITHUB_REPOSITORY_ID"];
  const previousRepository = process.env["GITHUB_REPOSITORY"];
  process.env["GITHUB_REPOSITORY_ID"] = "999999999";
  process.env["GITHUB_REPOSITORY"] = "agent-teams-ai/packed-docs-consumer-e2e";
  try {
    const checked = await invoke(["check"]);
    if (checked.outcome !== "change-required") {
      throw new Error(`Packed consumer check did not plan adoption: ${JSON.stringify(checked)}`);
    }
    const planned = await invoke(["plan", "--to", cohort.cohortId]);
    if (planned.outcome !== "change-required") {throw new Error("Packed consumer plan did not require adoption.");}
    const applied = await invoke(["apply", "--expect", planned.plan.planDigest]);
    if (process.platform === "win32") {
      if (applied.outcome !== "blocked" ||
          !applied.issues.some(({ code }) => code === "KNOWN_FILE_APPLY_UNSUPPORTED")) {
        throw new Error(`Packed Windows consumer apply did not fail closed: ${JSON.stringify(applied)}`);
      }
      const unchanged = await invoke(["check"]);
      if (unchanged.outcome !== "change-required") {
        throw new Error("Packed Windows apply refusal changed the consumer.");
      }
      return;
    }
    if (applied.outcome !== "applied") {
      throw new Error(`Packed consumer apply did not commit adoption: ${JSON.stringify(applied)}`);
    }
    const current = await invoke(["check"]);
    if (current.outcome !== "current") {throw new Error("Packed consumer check did not converge.");}
    installedManifest.scripts = JSON.parse(
      await readFile(join(consumerRoot, "package.json"), "utf8")
    ).scripts;

    cohort = input.adapter.targetA;
    await writeAuthority();
    const rollbackPlan = await invoke(["plan", "--to", cohort.cohortId]);
    if (rollbackPlan.outcome !== "change-required") {
      throw new Error(
        `Packed source executor did not plan B to A rollback: ${JSON.stringify(rollbackPlan)}`
      );
    }
    const rollback = await invoke(["apply", "--expect", rollbackPlan.plan.planDigest]);
    if (rollback.outcome !== "applied") {throw new Error("Packed source executor did not apply B to A rollback.");}
    const rolledBack = await invoke(["check"]);
    if (rolledBack.outcome !== "current") {throw new Error("Packed B to A rollback did not converge.");}
  } finally {
    if (previousRepositoryId === undefined) {
      delete process.env["GITHUB_REPOSITORY_ID"];
    } else {
      process.env["GITHUB_REPOSITORY_ID"] = previousRepositoryId;
    }
    if (previousRepository === undefined) {
      delete process.env["GITHUB_REPOSITORY"];
    } else {
      process.env["GITHUB_REPOSITORY"] = previousRepository;
    }
  }
}

try {
  const artifacts = await packPublishableArtifacts({ temporaryRoot });
  const artifact = artifacts["@agent-teams/engineering-foundation"];
  const mutationArtifact = artifacts["@agent-teams/repository-mutation"];
  const documentAuthoringArtifact = artifacts["@agent-teams/document-authoring"];
  const docsProtocolArtifact = artifacts["@agent-teams/docs-protocol"];
  const docsProtocolAdapterArtifact = artifacts["@agent-teams/docs-protocol-agent-teams"];
  const docsProtocolMcpArtifact = artifacts["@agent-teams/docs-protocol-mcp"];
  const rollbackFixtureArtifact = await createRollbackFixturePackage(
    docsProtocolAdapterArtifact,
    docsProtocolArtifact,
    artifact,
    mutationArtifact
  );
  await verifyPackedDocsConsumerIntegration({
    adapter: rollbackFixtureArtifact,
    authoring: documentAuthoringArtifact,
    docs: docsProtocolArtifact,
    foundation: artifact,
    mutation: mutationArtifact
  });
  process.stdout.write(`Packed Docs consumer adoption and B-to-A source rollback verified: ${docsProtocolArtifact.archiveName}.\n`);
  const fixture = await createPackedConsumerFixture({
    archiveFileSpecifier: artifact.archiveFileSpecifier,
    consumerRoot: join(temporaryRoot, "consumer"),
    documentAuthoringArchiveFileSpecifier: documentAuthoringArtifact.archiveFileSpecifier,
    documentAuthoringVersion: documentAuthoringArtifact.packageVersion,
    mutationArchiveFileSpecifier: mutationArtifact.archiveFileSpecifier,
    packageManager: packageManagerVersion(),
    runPnpm,
    toolingVersions: await toolingVersions()
  });
  await verifyPackedConsumer({ fixture });
  await verifyPackedAuthorityScaffolding({ fixture, repositoryRoot });
  await verifyPackedLocalMode({
    ...artifact,
    packageVersion: fixture.packedManifest.version,
    packageManager: packageManagerVersion(),
    repositoryRoot,
    runPnpm,
    documentAuthoringArchiveFileSpecifier: documentAuthoringArtifact.archiveFileSpecifier,
    mutationArchiveFileSpecifier: mutationArtifact.archiveFileSpecifier,
    temporaryRoot
  });
  await testPackedAgentWorkflow({
    consumerRoot: fixture.consumerRoot,
    runPnpm
  });
  await testPackedQualityGateRunner({
    consumerRoot: fixture.consumerRoot,
    runPnpm
  });
  process.stdout.write(
    `Package and local-mode lifecycle verified: ${artifact.archiveName} (${fixture.packedManifest.version}); ${docsProtocolArtifact.archiveName}; ${docsProtocolMcpArtifact.archiveName}.\n`
  );
  process.stdout.write(
    `Registry-install qualification: ${localRegistryInstallQualification.status}. ${localRegistryInstallQualification.summary}\n`
  );
} finally {
  if (keepTemporaryRoot) {
    process.stderr.write(`Pack test artifacts: ${temporaryRoot}\n`);
  } else {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}
