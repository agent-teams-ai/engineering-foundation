import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPnpmRunner, runCommand } from "./pack-test-support.mjs";
import { installPublishedFoundation } from "./published-foundation-install.mjs";

const version = "0.12.0";
const expectedIntegrity =
  "sha512-LWey96bQBwA/91eD1T9pZRKrNUPlAt/8NEOQ5gnWfW6Mzs+kdvyOUNQFXUUR2TTrfzfgiYPgjg5aBTUkCrZ0WQ==";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageName = "@agent-teams/engineering-foundation";
const runPnpm = createPnpmRunner();

async function runScaffolding(cliPath, consumerRoot, args) {
  const { stdout } = await runCommand(
    process.execPath,
    [cliPath, ...args, "--consumer", consumerRoot, "--json"],
    consumerRoot,
  );
  JSON.parse(stdout);
  return Buffer.from(stdout, "utf8");
}

function npmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function installPackedCurrentPackage({
  currentPackageRoot,
  temporaryRoot,
}) {
  const packRoot = join(temporaryRoot, "current-pack");
  await mkdir(packRoot, { recursive: true });
  await runPnpm(
    ["pack", "--pack-destination", packRoot, "--config.ignore-scripts=true"],
    currentPackageRoot,
  );
  const archives = (await readdir(packRoot)).filter((name) =>
    name.endsWith(".tgz"),
  );
  if (archives.length !== 1) {
    throw new Error("Current Foundation pack did not produce exactly one archive.");
  }
  const installRoot = join(temporaryRoot, "current-packed-package");
  const archivePath = join(packRoot, archives[0]);
  await mkdir(installRoot, { recursive: true });
  await writeFile(
    join(installRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "current-packed-foundation-qualification",
        private: true,
        type: "module",
        devDependencies: {
          [packageName]: `file:${archivePath.replaceAll("\\", "/")}`,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await runCommand(
    npmExecutable(),
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=true",
      "--registry=https://registry.npmjs.org/",
      "--loglevel=error",
    ],
    installRoot,
  );
  const packageRoot = join(
    installRoot,
    "node_modules",
    "@agent-teams",
    "engineering-foundation",
  );
  const metadata = await lstat(packageRoot);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    manifest.name !== packageName ||
    manifest.version !== version
  ) {
    throw new Error("Current packed Foundation has an invalid installed identity.");
  }
  return Object.freeze({
    archivePath,
    cliPath: join(packageRoot, "dist", "cli.js"),
  });
}

async function assertAllPlannedOutputsEqual({
  currentConsumer,
  currentPlan,
  publishedConsumer,
  publishedPlan,
}) {
  const currentPaths = currentPlan.operations.map(({ path }) => path);
  const publishedPaths = publishedPlan.operations.map(({ path }) => path);
  if (JSON.stringify(currentPaths) !== JSON.stringify(publishedPaths)) {
    throw new Error("Current and published Plans enumerate different output paths.");
  }
  for (let index = 0; index < currentPlan.operations.length; index += 1) {
    const currentOperation = currentPlan.operations[index];
    const publishedOperation = publishedPlan.operations[index];
    const currentBytes = await readFile(join(currentConsumer, currentOperation.path));
    const publishedBytes = await readFile(
      join(publishedConsumer, publishedOperation.path),
    );
    const expectedCurrentBytes = Buffer.from(
      currentOperation.after.contentBase64,
      "base64",
    );
    const expectedPublishedBytes = Buffer.from(
      publishedOperation.after.contentBase64,
      "base64",
    );
    if (
      !currentBytes.equals(publishedBytes) ||
      !currentBytes.equals(expectedCurrentBytes) ||
      !publishedBytes.equals(expectedPublishedBytes) ||
      currentOperation.after.digest !== publishedOperation.after.digest ||
      currentOperation.after.size !== currentBytes.byteLength ||
      publishedOperation.after.size !== publishedBytes.byteLength
    ) {
      throw new Error(
        `Packed current output differs from published Foundation ${version}: ${currentOperation.path}.`,
      );
    }
  }
}

export async function verifyPublishedScaffoldingCompatibility({
  currentPackageRoot,
  fixtureRoot = join(
    repositoryRoot,
    "tests",
    "fixtures",
    "scaffolding-authority-consumer",
  ),
  temporaryRoot,
}) {
  const published = await installPublishedFoundation({
    expectedIntegrity,
    root: join(temporaryRoot, "published-0.12-package"),
    version,
  });
  const current = await installPackedCurrentPackage({
    currentPackageRoot,
    temporaryRoot,
  });
  const currentConsumer = join(temporaryRoot, "current-consumer");
  const publishedConsumer = join(temporaryRoot, "published-consumer");
  await Promise.all([
    cp(fixtureRoot, currentConsumer, { recursive: true }),
    cp(fixtureRoot, publishedConsumer, { recursive: true }),
  ]);
  const [currentPlanBytes, publishedPlanBytes] = await Promise.all([
    runScaffolding(current.cliPath, currentConsumer, [
      "scaffold-plan",
      "intents/create-fixture.yaml",
    ]),
    runScaffolding(published.cliPath, publishedConsumer, [
      "scaffold-plan",
      "intents/create-fixture.yaml",
    ]),
  ]);
  if (!currentPlanBytes.equals(publishedPlanBytes)) {
    throw new Error(
      `Current packed ScaffoldPlan bytes differ from published Foundation ${version}.`,
    );
  }
  const currentPlan = JSON.parse(currentPlanBytes);
  const publishedPlan = JSON.parse(publishedPlanBytes);

  await Promise.all([
    mkdir(join(currentConsumer, "plans"), { recursive: true }),
    mkdir(join(publishedConsumer, "plans"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(currentConsumer, "plans", "compatibility.json"),
      currentPlanBytes,
    ),
    writeFile(
      join(publishedConsumer, "plans", "compatibility.json"),
      publishedPlanBytes,
    ),
  ]);
  const [currentReceipt, publishedReceipt] = await Promise.all([
    runScaffolding(current.cliPath, currentConsumer, [
      "scaffold-apply",
      "plans/compatibility.json",
    ]),
    runScaffolding(published.cliPath, publishedConsumer, [
      "scaffold-apply",
      "plans/compatibility.json",
    ]),
  ]);
  if (!currentReceipt.equals(publishedReceipt)) {
    throw new Error(
      `Current packed ScaffoldReceipt bytes differ from published Foundation ${version}.`,
    );
  }
  await assertAllPlannedOutputsEqual({
    currentConsumer,
    currentPlan,
    publishedConsumer,
    publishedPlan,
  });
}
