import { createHash } from "node:crypto";
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
import { isDeepStrictEqual } from "node:util";

import {
  createPnpmRunner,
  runCommand,
  runNpmCommand,
} from "./pack-test-support.mjs";
import { installPublishedFoundation } from "./published-foundation-install.mjs";

const publishedVersion = "0.12.0";
const expectedIntegrity =
  "sha512-LWey96bQBwA/91eD1T9pZRKrNUPlAt/8NEOQ5gnWfW6Mzs+kdvyOUNQFXUUR2TTrfzfgiYPgjg5aBTUkCrZ0WQ==";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageName = "@agent-teams/engineering-foundation";
const normalizedCompilerVersion = "0.0.0-compatibility";
const runPnpm = createPnpmRunner();

function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
}

export function compatibilityDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

async function runScaffolding(cliPath, consumerRoot, args) {
  const { stdout } = await runCommand(
    process.execPath,
    [cliPath, ...args, "--consumer", consumerRoot, "--json"],
    consumerRoot,
  );
  JSON.parse(stdout);
  return Buffer.from(stdout, "utf8");
}

async function installPackedCurrentPackage({
  candidateVersion,
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
  await runNpmCommand(
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
    manifest.version !== candidateVersion
  ) {
    throw new Error("Current packed Foundation has an invalid installed identity.");
  }
  return Object.freeze({
    archivePath,
    cliPath: join(packageRoot, "dist", "cli.js"),
  });
}

export function projectScaffoldPlanCompatibility(plan, expectedVersion) {
  const projection = structuredClone(plan);
  if (projection.compiler?.version !== expectedVersion) {
    throw new Error(
      `ScaffoldPlan compiler version differs from expected package ${expectedVersion}.`,
    );
  }
  const { planDigest, ...originalBody } = projection;
  if (planDigest !== compatibilityDigest(originalBody)) {
    throw new Error("ScaffoldPlan digest binding is invalid.");
  }
  delete projection.planDigest;
  projection.compiler.version = normalizedCompilerVersion;
  projection.planDigest = compatibilityDigest(projection);
  return projection;
}

export function projectScaffoldReceiptCompatibility(
  receipt,
  { originalPlanDigest, projectedPlanDigest },
) {
  const projection = structuredClone(receipt);
  if (projection.planDigest !== originalPlanDigest) {
    throw new Error("ScaffoldReceipt does not bind its original Plan.");
  }
  const { receiptDigest, ...originalBody } = projection;
  if (receiptDigest !== compatibilityDigest(originalBody)) {
    throw new Error("ScaffoldReceipt digest binding is invalid.");
  }
  delete projection.receiptDigest;
  projection.planDigest = projectedPlanDigest;
  projection.receiptDigest = compatibilityDigest(projection);
  return projection;
}

async function assertAllPlannedOutputsEqual({
  currentConsumer,
  currentPlan,
  publishedConsumer,
  publishedPlan,
}) {
  const currentPaths = currentPlan.operations.map(({ path }) => path);
  const publishedPaths = publishedPlan.operations.map(({ path }) => path);
  if (!isDeepStrictEqual(currentPaths, publishedPaths)) {
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
        `Packed current output differs from published Foundation ${publishedVersion}: ${currentOperation.path}.`,
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
  const candidateManifest = JSON.parse(
    await readFile(join(currentPackageRoot, "package.json"), "utf8"),
  );
  if (
    candidateManifest.name !== packageName ||
    typeof candidateManifest.version !== "string"
  ) {
    throw new Error("Current Foundation source package identity is invalid.");
  }
  const candidateVersion = candidateManifest.version;
  const published = await installPublishedFoundation({
    expectedIntegrity,
    root: join(temporaryRoot, "published-0.12-package"),
    version: publishedVersion,
  });
  const current = await installPackedCurrentPackage({
    candidateVersion,
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
  const currentPlan = JSON.parse(currentPlanBytes);
  const publishedPlan = JSON.parse(publishedPlanBytes);
  const currentPlanProjection = projectScaffoldPlanCompatibility(
    currentPlan,
    candidateVersion,
  );
  const publishedPlanProjection = projectScaffoldPlanCompatibility(
    publishedPlan,
    publishedVersion,
  );
  if (!isDeepStrictEqual(currentPlanProjection, publishedPlanProjection)) {
    throw new Error(
      `Current packed ScaffoldPlan semantics differ from published Foundation ${publishedVersion}.`,
    );
  }

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
  const currentReceiptValue = JSON.parse(currentReceipt);
  const publishedReceiptValue = JSON.parse(publishedReceipt);
  const currentReceiptProjection = projectScaffoldReceiptCompatibility(
    currentReceiptValue,
    {
      originalPlanDigest: currentPlan.planDigest,
      projectedPlanDigest: currentPlanProjection.planDigest,
    },
  );
  const publishedReceiptProjection = projectScaffoldReceiptCompatibility(
    publishedReceiptValue,
    {
      originalPlanDigest: publishedPlan.planDigest,
      projectedPlanDigest: publishedPlanProjection.planDigest,
    },
  );
  if (!isDeepStrictEqual(currentReceiptProjection, publishedReceiptProjection)) {
    throw new Error(
      `Current packed ScaffoldReceipt semantics differ from published Foundation ${publishedVersion}.`,
    );
  }
  await assertAllPlannedOutputsEqual({
    currentConsumer,
    currentPlan,
    publishedConsumer,
    publishedPlan,
  });
}
