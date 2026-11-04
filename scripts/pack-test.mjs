import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPnpmProfileQualificationRoot } from "../tools/dev.mts";
import { qualifyInstalledStackToolchain } from "./packed-stack-toolchain-qualification.ts";
import { testPackedAgentWorkflow } from "./pack-agent-workflow-test.mjs";
import { qualifyPackedDocsIntegration } from "./packed-docs-consumer-integration.ts";
import { testPackedQualityCoverage } from "./pack-quality-coverage-test.ts";
import { testPackedSdkGrowth } from "./pack-sdk-growth-test.mjs";
import { testPackedQualityGateRunner } from "./pack-quality-gate-runner-test.mjs";
import { verifyPackedAuthorityScaffolding } from "./pack-scaffolding-test.mjs";
import {
  runQualifiedArtifactConsumer,
  withQualifiedPackageArtifacts,
} from "./pack-publishable-artifacts.mjs";
import {
  packageQualificationPhaseIds,
  runPackageQualificationPhases,
} from "./package-qualification-groups.mts";
import { createPackedConsumerFixture } from "./packed-consumer-fixture.mjs";
import { verifyPackedConsumer } from "./packed-consumer-e2e.mjs";
import { verifyPackedCiInputProof } from "./packed-ci-input-proof.mts";
import { verifyPackedFeatureModuleStandard } from "./packed-feature-module-standard.mjs";
import { verifyInstalledKnownFileContract } from "./packed-known-file-contract.ts";
import { verifyPackedReleaseChecks } from "./packed-release-checks.ts";
import { verifyPackedLocalMode } from "./packed-local-mode-e2e.mjs";
import { createPnpmRunner, localRegistryInstallQualification } from "./pack-test-support.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const requireFromRepository = createRequire(import.meta.url);
function phaseElapsed(start) {
  return `${((performance.now() - start) / 1000).toFixed(1)}s`;
}

async function runPackedPhase(name, run, checkpoint) {
  const start = performance.now();
  process.stderr.write(`Pack test phase started: ${name}.\n`);
  try {
    await checkpoint();
    const result = await run();
    await checkpoint();
    process.stderr.write(`Pack test phase completed: ${name} (${phaseElapsed(start)}).\n`);
    return result;
  } catch (error) {
    process.stderr.write(`Pack test phase failed: ${name} (${phaseElapsed(start)}).\n`);
    throw error;
  }
}

async function installedVersion(packageName) {
  const manifestPath = requireFromRepository.resolve(`${packageName}/package.json`);
  return JSON.parse(await readFile(manifestPath, "utf8")).version;
}

async function toolingVersions() {
  return {
    oxlint: await installedVersion("oxlint"),
    oxlintTsgolint: await installedVersion("oxlint-tsgolint"),
    typescript: await installedVersion("typescript"),
  };
}

function packageManagerVersion(repositoryManifest) {
  const packageManager = repositoryManifest.packageManager;
  if (typeof packageManager !== "string" || !/^pnpm@\d+\.\d+\.\d+$/u.test(packageManager)) {
    throw new Error("Repository packageManager must pin an exact pnpm version.");
  }
  return packageManager;
}

/**
 * @param {import("./package-artifact-custody.mts").QualificationHandle} handle
 * @param {import("./package-qualification-groups.mts").PackedQualificationGroup | undefined} [group]
 */
export function qualifyPackedConsumers(handle, group) {
  packageQualificationPhaseIds("packed", group);
  return runQualifiedArtifactConsumer(
    handle,
    "packed",
    async ({ artifacts, temporaryRoot, checkpoint }) => {
      const runPnpm = createPnpmRunner();
      const sourceRoot = process.env["AGENT_TEAMS_FOUNDATION_SOURCE_ROOT"];
      if (sourceRoot === undefined || sourceRoot === "") {
        throw new Error("Package qualification requires an explicit source root.");
      }
      await assertPnpmProfileQualificationRoot(repositoryRoot, sourceRoot);
      const repositoryManifest = JSON.parse(
        await readFile(join(repositoryRoot, "package.json"), "utf8"),
      );
      const packageManager = packageManagerVersion(repositoryManifest);
      const timedPhase = (name, run) => runPackedPhase(name, run, checkpoint);
      const artifact = artifacts["@agent-teams/engineering-foundation"];
      const mutationArtifact = artifacts["@agent-teams/repository-mutation"];
      const documentAuthoringArtifact = artifacts["@agent-teams/document-authoring"];
      const docsProtocolArtifact = artifacts["@agent-teams/docs-protocol"];
      const docsProtocolAdapterArtifact = artifacts["@agent-teams/docs-protocol-agent-teams"];
      const docsProtocolMcpArtifact = artifacts["@agent-teams/docs-protocol-mcp"];
      let fixture;
      const getFixture = async () => {
        fixture ??= await timedPhase("packed consumer fixture", async () =>
          createPackedConsumerFixture({
            archiveFileSpecifier: artifact.archiveFileSpecifier,
            stackToolchainArchiveFileSpecifier: artifacts["stack-toolchain"].archiveFileSpecifier,
            consumerRoot: join(temporaryRoot, "consumer"),
            documentAuthoringArchiveFileSpecifier: documentAuthoringArtifact.archiveFileSpecifier,
            mutationArchiveFileSpecifier: mutationArtifact.archiveFileSpecifier,
            packageManager,
            runPnpm,
            toolingVersions: await toolingVersions(),
          }),
        );
        return fixture;
      };
      const consumerPhase = (id, run) => ({
        id,
        run: async () => {
          const current = await getFixture();
          return timedPhase(id, () => run(current));
        },
      });
      await runPackageQualificationPhases("packed", group, [
        {
          id: "Docs integration",
          run: async () => {
            await timedPhase("Docs integration", () =>
              qualifyPackedDocsIntegration({
                temporaryRoot,
                runPnpm,
                packageManager,
                adapter: docsProtocolAdapterArtifact,
                authoring: documentAuthoringArtifact,
                docs: docsProtocolArtifact,
                foundation: artifact,
                mutation: mutationArtifact,
              }),
            );
            process.stdout.write(
              `Packed Docs consumer adoption and B-to-A source rollback verified: ${docsProtocolArtifact.archiveName}.\n`,
            );
          },
        },
        consumerPhase("packed consumer E2E", async (current) => {
          await verifyPackedConsumer({ fixture: current });
          await verifyInstalledKnownFileContract({
            consumerRoot: current.consumerRoot,
            packageVersion: mutationArtifact.packageVersion,
            repositoryRoot,
          });
          await verifyPackedCiInputProof(
            artifacts["@agent-teams/ci-input-proof"],
            temporaryRoot,
            repositoryRoot,
            runPnpm,
          );
          await verifyPackedFeatureModuleStandard({
            artifacts,
            temporaryRoot,
            packageManager,
            runPnpm,
            typescript: (await toolingVersions()).typescript,
          });
          await verifyPackedReleaseChecks({
            artifact: artifacts["@agent-teams/release-checks"],
            temporaryRoot,
            repositoryRoot,
            packageManager,
            runPnpm,
          });
        }),
        consumerPhase("SDK growth qualification", (current) =>
          testPackedSdkGrowth({ consumerRoot: current.consumerRoot, artifact }),
        ),
        consumerPhase("authority scaffolding", (current) =>
          verifyPackedAuthorityScaffolding({ fixture: current, repositoryRoot }),
        ),
        consumerPhase("local-mode lifecycle", (current) =>
          verifyPackedLocalMode({
            ...artifact,
            packageVersion: current.packedManifest.version,
            packageManager,
            repositoryRoot,
            runPnpm,
            documentAuthoringArchiveFileSpecifier: documentAuthoringArtifact.archiveFileSpecifier,
            mutationArchiveFileSpecifier: mutationArtifact.archiveFileSpecifier,
            temporaryRoot,
          }),
        ),
        consumerPhase("agent-workflow fixture", (current) =>
          testPackedAgentWorkflow({
            consumerRoot: current.consumerRoot,
            runPnpm,
          }),
        ),
        consumerPhase("quality coverage", async (current) => {
          await qualifyInstalledStackToolchain(current.consumerRoot);
          return testPackedQualityCoverage({ consumerRoot: current.consumerRoot, artifact });
        }),
        consumerPhase("quality gate runner", (current) =>
          testPackedQualityGateRunner({
            consumerRoot: current.consumerRoot,
            runPnpm,
          }),
        ),
      ]);
      const current = await getFixture();
      if (group === undefined || group === "integration") {
        process.stdout.write(
          `Package and local-mode lifecycle verified: ${artifact.archiveName} (${current.packedManifest.version}); ${docsProtocolArtifact.archiveName}; ${docsProtocolMcpArtifact.archiveName}.\n`,
        );
      } else {
        process.stdout.write(
          `Packed consumer group verified: ${group}; ${artifact.archiveName}.\n`,
        );
      }
      process.stdout.write(
        `Registry-install qualification: ${localRegistryInstallQualification.status}. ${localRegistryInstallQualification.summary}\n`,
      );
    },
  );
}

/** @param {import("./package-qualification-groups.mts").PackedQualificationGroup | undefined} [group] */
export async function runPackTest(group) {
  packageQualificationPhaseIds("packed", group);
  const evidence = await withQualifiedPackageArtifacts("packed", (handle) =>
    qualifyPackedConsumers(handle, group),
  );
  process.stdout.write(
    `Packed${group === undefined ? "" : ` group ${group}`} qualification PASS: ${JSON.stringify(evidence)}\n`,
  );
  return evidence;
}

if (import.meta.main) {
  if (process.argv.length !== 2) {
    throw new Error("Pack qualification accepts no archive overrides or arguments.");
  }
  await runPackTest();
}
