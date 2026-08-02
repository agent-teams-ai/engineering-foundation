import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FOUNDATION_REQUIRED_ARTIFACT_PATHS } from "../packages/engineering-foundation/dist/package-self-check.js";
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
const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-teams-foundation-pack-"));
const keepTemporaryRoot = process.env.AGENT_TEAMS_KEEP_PACK_TEST_ARTIFACTS === "1";
const requireFromRepository = createRequire(import.meta.url);
const runPnpm = createPnpmRunner();
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

try {
  const artifact = await packAndInspectArtifact({
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
    runPnpm,
    toolingVersions: await toolingVersions()
  });
  await verifyPackedConsumer({ fixture });
  await verifyPackedLocalMode({
    ...artifact,
    packageVersion: fixture.packedManifest.version,
    repositoryRoot,
    runPnpm,
    temporaryRoot
  });
  process.stdout.write(
    `Package and local-mode lifecycle verified: ${artifact.archiveName} (${fixture.packedManifest.version})\n`
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
