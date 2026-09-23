import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeMandatoryGateFixture, mandatoryTestFile } from "./mandatory-node-test-gate-fixture.mjs";
import { captureFailure, runCommand } from "./pack-test-support.mjs";
import { verifyRegistryDocumentAuthoring } from "./registry-document-authoring-e2e.mjs";
import { verifyInstalledTransactionBarrier } from "./transaction-barrier-e2e.mjs";

const COMMAND_TIMEOUT_MS = 120_000;

function assertMandatoryGateReport(result, scenario) {
  let report;
  try { report = JSON.parse(result.stdout); } catch {
    throw new Error(`Installed mandatory Node test ${scenario.label} emitted no gate report.`);
  }
  const expectedOutcome = scenario.passed ? "passed" : "failed";
  const task = report.tasks?.length === 1 ? report.tasks[0] : undefined;
  if (report.reportSchemaVersion !== 1 || report.outcome !== expectedOutcome ||
    task?.id !== "mandatory" || task.outcome !== expectedOutcome ||
    task.exitCode !== (scenario.passed ? 0 : 1) ||
    (!scenario.passed && !task.failureTail.includes("required execution failed"))) {
    throw new Error(`Installed mandatory Node test ${scenario.label} produced the wrong gate evidence.`);
  }
}

async function verifyInstalledMandatoryNodeTests(installedRoot, consumerRoot) {
  const manifest = await readManifest(installedRoot);
  const bin = manifest.bin?.["agent-teams-node-test"];
  if (bin !== "./dist/node-test-cli.js") {
    throw new Error("Installed Foundation mandatory Node test bin is missing.");
  }
  const commandPath = join(installedRoot, bin);
  const gatePath = join(installedRoot, "dist", "cli.js");
  if (!(await lstat(commandPath)).isFile() || !(await lstat(gatePath)).isFile()) {
    throw new Error("Installed Foundation gate or mandatory Node test entry is missing.");
  }
  const root = join(consumerRoot, "mandatory-node-test-consumer");
  const required = [{ file: mandatoryTestFile, names: ["required"], kind: "test" }];
  const cases = [
    { label: "all-skipped", source: "import test from 'node:test'; test.skip('required', () => {});", passed: false },
    { label: "omitted", source: "import test from 'node:test'; test('unrelated', () => {});", passed: false },
    { label: "executed", source: "import test from 'node:test'; test('required', () => {});", passed: true },
    { label: "exact-exception", source: "import test from 'node:test'; test.skip('required', () => {});", passed: true,
      exceptions: [{ ...required[0], status: "skipped", reason: "Reviewed fixture exception for this one required case.",
        applicability: { platforms: [process.platform] } }] },
  ];
  for (const scenario of cases) {
    await writeMandatoryGateFixture({ root, commandPath, source: scenario.source,
      required, exceptions: scenario.exceptions });
    const execute = () => runCommand(process.execPath,
      [gatePath, "gate", "run", "verify", "--consumer", root, "--format", "json"],
      root, { timeoutMs: COMMAND_TIMEOUT_MS });
    const result = scenario.passed ? await execute() : await captureFailure(execute);
    if (!result || (!scenario.passed && result.code !== 1)) {
      throw new Error(`Installed mandatory Node test ${scenario.label} had the wrong exit status.`);
    }
    assertMandatoryGateReport(result, scenario);
  }
}

async function readManifest(root) {
  return JSON.parse(await readFile(join(root, "package.json"), "utf8"));
}

export async function verifyInstalledBufQualifierForPackage(installedRoot) {
  const environmentKey = "AGENT_TEAMS_FOUNDATION_CLI_PATH";
  const previousCliPath = process.env[environmentKey];
  process.env[environmentKey] = join(installedRoot, "dist", "cli.js");
  try {
    await import("./buf-qualification-e2e.mjs?installed-registry");
  } finally {
    if (previousCliPath === undefined) {
      delete process.env[environmentKey];
    } else {
      process.env[environmentKey] = previousCliPath;
    }
  }
}

export async function verifyRegistryPackage({
  consumerRoot,
  lockfile,
  registryUrl,
  runNpm,
  target,
}) {
  const packageSegments = target.manifest.name.split("/");
  const targetRoot = join(consumerRoot, "node_modules", ...packageSegments);
  const targetEntry = await lstat(targetRoot);
  const targetManifest = await readManifest(targetRoot);
  const lockedTarget = lockfile.packages?.[`node_modules/${target.manifest.name}`];
  if (
    !targetEntry.isDirectory() ||
    targetEntry.isSymbolicLink() ||
    targetManifest.version !== target.manifest.version ||
    lockedTarget?.version !== target.manifest.version ||
    typeof lockedTarget.integrity !== "string" ||
    !lockedTarget.integrity.startsWith("sha512-") ||
    typeof lockedTarget.resolved !== "string" ||
    !lockedTarget.resolved.startsWith(registryUrl)
  ) {
    throw new Error(`Registry evidence is incomplete for ${target.manifest.name}.`);
  }
  await runCommand(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(target.manifest.name)});`,
    ],
    consumerRoot,
    { timeoutMs: COMMAND_TIMEOUT_MS },
  );
  const binary =
    typeof target.manifest.bin === "string"
      ? target.manifest.bin
      : Object.values(target.manifest.bin ?? {})[0];
  if (typeof binary === "string") {
    await runCommand(
      process.execPath,
      [join(targetRoot, binary), "--help"],
      consumerRoot,
      { timeoutMs: COMMAND_TIMEOUT_MS },
    );
  }
  const { stdout: viewedVersion } = await runNpm(
    [
      "view",
      `${target.manifest.name}@${target.manifest.version}`,
      "version",
      "--registry",
      registryUrl,
    ],
    consumerRoot,
  );
  if (viewedVersion.trim() !== target.manifest.version) {
    throw new Error(
      `Registry metadata did not return ${target.manifest.name}@${target.manifest.version}.`,
    );
  }
  return targetRoot;
}

export async function verifyFoundationFeatures({
  authoringVersion,
  consumerRoot,
  docsVersion,
  featureImports,
  installedAdapterRoot,
  installedDocsRoot,
  installedRoot,
  repositoryRoot,
  verifyInstalledBufQualifier,
}) {
  await runCommand(
    process.execPath,
    [join(installedRoot, "dist", "cli.js"), "--help"],
    consumerRoot,
    { timeoutMs: COMMAND_TIMEOUT_MS },
  );
  await runCommand(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await Promise.all(${JSON.stringify(featureImports)}.map((specifier) => import(specifier)));`,
    ],
    consumerRoot,
    { timeoutMs: COMMAND_TIMEOUT_MS },
  );
  await verifyInstalledBufQualifier(installedRoot);
  await verifyInstalledMandatoryNodeTests(installedRoot, consumerRoot);
  await verifyInstalledTransactionBarrier({
    cliPath: join(installedRoot, "dist", "cli.js"),
    consumerRoot: join(consumerRoot, "transaction-barrier-consumer"),
    fixtureRoot: join(
      repositoryRoot,
      "tests",
      "fixtures",
      "scaffolding-authority-consumer",
    ),
  });
  await verifyRegistryDocumentAuthoring({
    consumerRoot,
    docsVersion,
    installedAdapterRoot,
    installedDocsRoot,
    version: authoringVersion,
  });
}
