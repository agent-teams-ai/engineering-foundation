import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FOUNDATION_REQUIRED_ARTIFACT_PATHS } from "../packages/engineering-foundation/dist/package-self-check.js";
import { testPackedAgentWorkflow } from "./pack-agent-workflow-test.mjs";
import { verifyPackedAuthorityScaffolding } from "./pack-scaffolding-test.mjs";
import { packAndInspectArtifact } from "./pack-artifact-e2e.mjs";
import { createPackedConsumerFixture } from "./packed-consumer-fixture.mjs";
import { verifyPackedConsumer } from "./packed-consumer-e2e.mjs";
import { verifyPackedLocalMode } from "./packed-local-mode-e2e.mjs";
import {
  createPnpmRunner,
  localRegistryInstallQualification,
  runCommand
} from "./pack-test-support.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = join(repositoryRoot, "packages", "engineering-foundation");
const docsProtocolRoot = join(repositoryRoot, "packages", "docs-protocol");
const docsProtocolRequiredArtifacts = [
  "CHANGELOG.md",
  "dist/cli.d.ts",
  "dist/cli.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/qualification/index.d.ts",
  "dist/qualification/index.js",
  "schemas/docs-protocol-command-envelope/v1.schema.json",
  "schemas/docs-protocol-profile/v1.schema.json",
  "schemas/docs-protocol/v1.schema.json",
  "schemas/docs-consumer-integration-execution/v1.schema.json",
  "schemas/docs-consumer-integration-plan/v1.schema.json",
  "schemas/docs-consumer-integration-profile/v1.schema.json",
  "schemas/docs-consumer-managed-state/v1.schema.json",
  "schemas/qualified-docs-cohort/v1.schema.json",
];
const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-teams-foundation-pack-"));
const keepTemporaryRoot = process.env.AGENT_TEAMS_KEEP_PACK_TEST_ARTIFACTS === "1";
const requireFromRepository = createRequire(import.meta.url);
const runPnpm = createPnpmRunner();
const repositoryManifest = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8")
);
const typeScriptEntrypoint = join(
  dirname(requireFromRepository.resolve("typescript/package.json")),
  "lib",
  "tsc.js"
);

async function runCleanPackageBuild(stagedPackageRoot) {
  await runCommand(
    process.execPath,
    [typeScriptEntrypoint, "--build", "tsconfig.json", "--pretty", "false"],
    stagedPackageRoot
  );
}

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

try {
  const artifact = await packAndInspectArtifact({
    artifactLabel: "foundation",
    packageRoot,
    requiredArtifactPaths: FOUNDATION_REQUIRED_ARTIFACT_PATHS,
    repositoryRoot,
    runBuild: runCleanPackageBuild,
    runPnpm,
    temporaryRoot
  });
  const fixture = await createPackedConsumerFixture({
    archiveFileSpecifier: artifact.archiveFileSpecifier,
    consumerRoot: join(temporaryRoot, "consumer"),
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
    temporaryRoot
  });
  await testPackedAgentWorkflow({
    consumerRoot: fixture.consumerRoot,
    runPnpm
  });
  const docsProtocolArtifact = await packAndInspectArtifact({
    artifactLabel: "docs-protocol",
    packageRoot: docsProtocolRoot,
    requiredArtifactPaths: docsProtocolRequiredArtifacts,
    repositoryRoot,
    runBuild: runCleanPackageBuild,
    runPnpm,
    supportPackageRoots: [packageRoot],
    temporaryRoot,
  });
  process.stdout.write(
    `Package and local-mode lifecycle verified: ${artifact.archiveName} (${fixture.packedManifest.version}); ${docsProtocolArtifact.archiveName}.\n`
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
