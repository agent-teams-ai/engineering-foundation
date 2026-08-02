import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FOUNDATION_REQUIRED_ARTIFACT_PATHS } from "../packages/engineering-foundation/dist/package-self-check.js";
import { testPackedAgentWorkflow } from "./pack-agent-workflow-test.mjs";

const execFileAsync = promisify(execFile);
const requireFromRepository = createRequire(import.meta.url);
async function installedVersion(packageName) {
  return JSON.parse(
    await readFile(requireFromRepository.resolve(`${packageName}/package.json`), "utf8")
  ).version;
}

const toolingVersions = {
  oxlint: await installedVersion("oxlint"),
  oxlintTsgolint: await installedVersion("oxlint-tsgolint"),
  typescript: await installedVersion("typescript")
};
const pnpmEntrypoint = process.env.npm_execpath;
const pnpmExecutable =
  pnpmEntrypoint === undefined ? "pnpm" : process.execPath;
const pnpmArguments = (args) =>
  pnpmEntrypoint === undefined ? args : [pnpmEntrypoint, ...args];
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = join(
  repositoryRoot,
  "packages",
  "engineering-foundation"
);
const scaffoldingFixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-consumer"
);
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "agent-teams-foundation-pack-")
);
const keepTemporaryRoot =
  process.env.AGENT_TEAMS_KEEP_PACK_TEST_ARTIFACTS === "1";

const forbiddenEntries = [
  "/.git/",
  "/node_modules/",
  "/src/",
  "/tests/",
  ".env",
  "auth.json",
  "foundation-link.json",
  "/secret-fixtures/"
];
const secretCanary = "AGENT_TEAMS_PACKAGE_SECRET_CANARY_DO_NOT_PUBLISH_7A13D6C4";
const secretPatterns = [
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bghp_[A-Za-z0-9]{36,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u
];

async function assertSecretCanaryAbsent(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await assertSecretCanaryAbsent(path);
    } else if (entry.isFile()) {
      const content = await readFile(path);
      const text = content.toString("utf8");
      if (
        content.includes(Buffer.from(secretCanary)) ||
        secretPatterns.some((pattern) => pattern.test(text))
      ) {
        throw new Error(`Secret-like content leaked into package tarball: ${path}.`);
      }
    }
  }
}

function registryLockfile(version, integrity) {
  const packageName = "@agent-teams/engineering-foundation";
  const packageKey = `${packageName}@${version}`;
  return `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      '${packageName}':
        specifier: ${version}
        version: ${version}

packages:

  '${packageKey}':
    resolution: {integrity: ${integrity}}

snapshots:

  '${packageKey}': {}
`;
}

try {
  await execFileAsync(
    pnpmExecutable,
    pnpmArguments(["pack", "--pack-destination", temporaryRoot]),
    { cwd: packageRoot }
  );

  const archiveName = (await readdir(temporaryRoot)).find((name) =>
    name.endsWith(".tgz")
  );
  if (archiveName === undefined) {
    throw new Error("pnpm pack did not produce a tarball.");
  }

  const archivePath = join(temporaryRoot, archiveName);
  const archiveFileSpecifier = `file:${archivePath.replaceAll("\\", "/")}`;
  const { stdout: listing } = await execFileAsync(
    "tar",
    ["-tzf", archivePath],
    { cwd: temporaryRoot }
  );
  for (const forbidden of forbiddenEntries) {
    if (listing.includes(forbidden)) {
      throw new Error(`Forbidden package entry detected: ${forbidden}`);
    }
  }
  for (const required of [
    "package/package.json",
    "package/LICENSE",
    "package/README.md",
    ...FOUNDATION_REQUIRED_ARTIFACT_PATHS.map((path) => `package/${path}`)
  ]) {
    if (!listing.split(/\r?\n/u).includes(required)) {
      throw new Error(`Required package entry missing: ${required}`);
    }
  }
  const extractedRoot = join(temporaryRoot, "extracted");
  await mkdir(extractedRoot, { recursive: true });
  await execFileAsync("tar", ["-xzf", archivePath, "-C", extractedRoot], {
    cwd: temporaryRoot
  });
  await assertSecretCanaryAbsent(extractedRoot);

  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "foundation-pack-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@11.18.0",
        devDependencies: {
          "@agent-teams/engineering-foundation": archiveFileSpecifier,
          oxlint: "catalog:",
          "oxlint-tsgolint": "catalog:",
          typescript: "catalog:"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "pnpm-workspace.yaml"),
    `packages:\n  - "packages/*"\ncatalogMode: strict\ncatalog:\n  oxlint: ${toolingVersions.oxlint}\n  oxlint-tsgolint: ${toolingVersions.oxlintTsgolint}\n  typescript: ${toolingVersions.typescript}\n`,
    "utf8"
  );

  await execFileAsync(
    pnpmExecutable,
    pnpmArguments(["install", "--ignore-scripts", "--no-frozen-lockfile"]),
    { cwd: consumerRoot }
  );
  const { stdout: versionOutput } = await execFileAsync(
    pnpmExecutable,
    pnpmArguments(["exec", "agent-teams-foundation", "--version"]),
    { cwd: consumerRoot }
  );

  const packedManifest = JSON.parse(
    await readFile(
      join(
        consumerRoot,
        "node_modules",
        "@agent-teams",
        "engineering-foundation",
        "package.json"
      ),
      "utf8"
    )
  );
  if (versionOutput.trim() !== packedManifest.version) {
    throw new Error("Packed CLI version differs from packed package version.");
  }
  const requireFromConsumer = createRequire(join(consumerRoot, "package.json"));
  const consumerOxlintEntrypoint = join(
    dirname(requireFromConsumer.resolve("oxlint/package.json")),
    "bin",
    "oxlint"
  );
  const consumerTypescriptEntrypoint = join(
    dirname(requireFromConsumer.resolve("typescript/package.json")),
    "lib",
    "tsc.js"
  );
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "foundation-pack-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@11.18.0",
        devDependencies: {
          "@agent-teams/engineering-foundation": packedManifest.version,
          oxlint: "catalog:",
          "oxlint-tsgolint": "catalog:",
          typescript: "catalog:"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "foundation.config.yaml"),
    `schemaVersion: 1\nproject:\n  id: pack-consumer\ncapabilities:\n  architecture.source-dependencies:\n    configPath: architecture/foundation/source-dependencies.yaml\n  workspace.dependency-declarations:\n    configPath: architecture/foundation/dependency-declarations.yaml\n`,
    "utf8"
  );
  await mkdir(join(consumerRoot, "architecture", "foundation"), {
    recursive: true
  });
  await writeFile(
    join(
      consumerRoot,
      "architecture",
      "foundation",
      "dependency-declarations.yaml"
    ),
    `schemaVersion: 1\npackageManager:\n  kind: pnpm\n  workspaceManifest: pnpm-workspace.yaml\npolicies:\n  externalDependencies: catalog\n  catalogVersions: exact\n  internalDependencies: workspace-protocol\n  reservedScopes:\n    - "@agent-teams/"\n  developmentOnlyPackages:\n    - oxlint\n    - oxlint-tsgolint\n    - typescript\n  exactRegistryDevelopmentOnlyPackages:\n    - "@agent-teams/engineering-foundation"\n`,
    "utf8"
  );
  await writeFile(
    join(
      consumerRoot,
      "architecture",
      "foundation",
      "source-dependencies.yaml"
    ),
    `schemaVersion: 1\nworkspace:\n  kind: pnpm\n  manifest: pnpm-workspace.yaml\ngovernedRoots:\n  - src\nboundaries:\n  - id: pack-consumer.core\n    roots:\n      - src\n    allow:\n      boundaries: []\n      packages: []\n      builtins: []\n      runtimeReferences: []\n`,
    "utf8"
  );
  const consumerSourceRoot = join(consumerRoot, "src");
  await mkdir(consumerSourceRoot, { recursive: true });
  await writeFile(
    join(consumerSourceRoot, "index.ts"),
    `export function identity(value: string): string {\n  return value;\n}\n`,
    "utf8"
  );
  const { stdout: checkOutput } = await execFileAsync(
    pnpmExecutable,
    pnpmArguments([
      "exec",
      "agent-teams-foundation",
      "check",
      "--consumer",
      consumerRoot,
      "--format",
      "json"
    ]),
    { cwd: consumerRoot }
  );
  const packedCheck = JSON.parse(checkOutput);
  if (
    packedCheck.outcome !== "passed" ||
    packedCheck.capabilities?.map((capability) => capability.capabilityId).join(",") !==
      "architecture.source-dependencies,workspace.dependency-declarations"
  ) {
    throw new Error("Packed executable capability check did not pass.");
  }
  await testPackedAgentWorkflow({
    consumerRoot,
    pnpmExecutable,
    pnpmArguments,
  });
  await writeFile(
    join(consumerSourceRoot, "index.ts"),
    `import "node:fs";\nexport const invalidBoundary = true;\n`,
    "utf8"
  );
  let packedViolation;
  try {
    await execFileAsync(
      pnpmExecutable,
      pnpmArguments([
        "exec",
        "agent-teams-foundation",
        "check",
        "--consumer",
        consumerRoot,
        "--format",
        "json"
      ]),
      { cwd: consumerRoot }
    );
  } catch (error) {
    packedViolation = JSON.parse(error.stdout ?? "null");
  }
  if (
    packedViolation?.capabilities?.[0]?.diagnostics?.[0]?.ruleId !==
    "architecture.source-dependencies.forbidden-builtin-dependency"
  ) {
    throw new Error("Packed source capability did not reject a forbidden builtin.");
  }
  await writeFile(
    join(consumerSourceRoot, "index.ts"),
    `export function identity(value: string): string {\n  return value;\n}\n`,
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        extends:
          "@agent-teams/engineering-foundation/presets/typescript/node.json",
        compilerOptions: {
          noEmit: true
        },
        include: ["src/**/*.ts"]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await execFileAsync(
    process.execPath,
    [consumerTypescriptEntrypoint, "--project", join(consumerRoot, "tsconfig.json")],
    { cwd: consumerRoot }
  );
  await writeFile(
    join(consumerRoot, ".oxlintrc.json"),
    `${JSON.stringify(
      {
        extends: [
          "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/node.json"
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await execFileAsync(
    process.execPath,
    [
      consumerOxlintEntrypoint,
      "--config",
      join(consumerRoot, ".oxlintrc.json"),
      "--deny-warnings",
      "--disable-nested-config",
      join(consumerRoot, "src")
    ],
    { cwd: consumerRoot }
  );
  const maintainabilitySource = `export function packedHelper(a, b, c, d, e, f) {\n  let result = a + b + c + d + e + f;\n${Array.from({ length: 180 }, () => "  result += 1;").join("\n")}\n  return result;\n}\n`;
  await writeFile(
    join(consumerRoot, ".oxlintrc.maintainability.json"),
    `${JSON.stringify(
      {
        extends: [
          "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/node.json",
          "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/maintainability.json"
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(join(consumerSourceRoot, "index.ts"), maintainabilitySource, "utf8");
  let maintainabilityFailure = "";
  try {
    await execFileAsync(
      process.execPath,
      [
        consumerOxlintEntrypoint,
        "--config",
        join(consumerRoot, ".oxlintrc.maintainability.json"),
        "--deny-warnings",
        "--disable-nested-config",
        join(consumerRoot, "src")
      ],
      { cwd: consumerRoot }
    );
  } catch (error) {
    maintainabilityFailure = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  if (
    !maintainabilityFailure.includes("eslint(max-lines-per-function)") ||
    !maintainabilityFailure.includes("eslint(max-params)")
  ) {
    throw new Error("Packed production maintainability preset did not enforce its budgets.");
  }
  await writeFile(
    join(consumerRoot, ".oxlintrc.maintainability-tests.json"),
    `${JSON.stringify(
      {
        extends: [
          "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/node.json",
          "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/maintainability-tests.json"
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await execFileAsync(
    process.execPath,
    [
      consumerOxlintEntrypoint,
      "--config",
      join(consumerRoot, ".oxlintrc.maintainability-tests.json"),
      "--deny-warnings",
      "--disable-nested-config",
      join(consumerRoot, "src")
    ],
    { cwd: consumerRoot }
  );
  await writeFile(
    join(consumerRoot, ".oxlintrc.type-aware.json"),
    `${JSON.stringify(
      {
        extends: [
          "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/type-aware.json"
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    join(consumerSourceRoot, "index.ts"),
    `async function execute(): Promise<void> {}\nexecute();\n`,
    "utf8"
  );
  let typeAwareFailure = "";
  try {
    await execFileAsync(
      process.execPath,
      [
        consumerOxlintEntrypoint,
        "--config",
        join(consumerRoot, ".oxlintrc.type-aware.json"),
        "--deny-warnings",
        "--disable-nested-config",
        join(consumerRoot, "src")
      ],
      { cwd: consumerRoot }
    );
  } catch (error) {
    typeAwareFailure = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  if (!typeAwareFailure.includes("typescript(no-floating-promises)")) {
    throw new Error("Packed type-aware Oxlint preset did not reject a floating promise.");
  }
  await writeFile(
    join(consumerSourceRoot, "index.ts"),
    `export function identity(value: string): string {\n  return value;\n}\n`,
    "utf8"
  );
  const { stdout: selfCheckOutput } = await execFileAsync(
    pnpmExecutable,
    pnpmArguments(["exec", "agent-teams-foundation", "self-check", "--json"]),
    { cwd: consumerRoot }
  );
  const packedSelfCheck = JSON.parse(selfCheckOutput);
  if (
    packedSelfCheck.ok !== true ||
    packedSelfCheck.packageVersion !== packedManifest.version ||
    packedSelfCheck.localModeProtocolVersion !== 1
  ) {
    throw new Error("Packed CLI self-check did not validate the package.");
  }

  await cp(
    join(scaffoldingFixtureRoot, "architecture", "foundation", "scaffolding.yaml"),
    join(consumerRoot, "architecture", "foundation", "scaffolding.yaml")
  );
  await cp(
    join(scaffoldingFixtureRoot, "architecture", "package-catalog.yaml"),
    join(consumerRoot, "architecture", "package-catalog.yaml")
  );
  await mkdir(join(consumerRoot, "intents"), { recursive: true });
  await cp(
    join(scaffoldingFixtureRoot, "intents", "create-fixture.yaml"),
    join(consumerRoot, "intents", "create-fixture.yaml")
  );
  const { stdout: scaffoldPlanOutput } = await execFileAsync(
    pnpmExecutable,
    pnpmArguments([
      "exec",
      "agent-teams-foundation",
      "scaffold-plan",
      "intents/create-fixture.yaml",
      "--consumer",
      consumerRoot,
      "--json"
    ]),
    { cwd: consumerRoot }
  );
  const scaffoldPlan = JSON.parse(scaffoldPlanOutput);
  await mkdir(join(consumerRoot, "plans"));
  await writeFile(
    join(consumerRoot, "plans", "pack-fixture.json"),
    `${JSON.stringify(scaffoldPlan, null, 2)}\n`
  );
  const { stdout: scaffoldReceiptOutput } = await execFileAsync(
    pnpmExecutable,
    pnpmArguments([
      "exec",
      "agent-teams-foundation",
      "scaffold-apply",
      "plans/pack-fixture.json",
      "--consumer",
      consumerRoot,
      "--json"
    ]),
    { cwd: consumerRoot }
  );
  const scaffoldReceipt = JSON.parse(scaffoldReceiptOutput);
  if (scaffoldReceipt.outcome !== "applied") {
    throw new Error("Packed scaffolding CLI did not apply its deterministic Plan.");
  }
  const generatedManifest = JSON.parse(
    await readFile(
      join(consumerRoot, "packages", "testing", "generated", "package.json"),
      "utf8"
    )
  );
  if (generatedManifest.name !== "@fixture/generated") {
    throw new Error("Packed scaffolding CLI generated an unexpected package.");
  }

  const localModeConsumerRoot = join(temporaryRoot, "local-mode-consumer");
  await mkdir(localModeConsumerRoot, { recursive: true });
  await writeFile(
    join(localModeConsumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "foundation-local-mode-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@11.18.0",
        devDependencies: {
          "@agent-teams/engineering-foundation": packedManifest.version
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    join(localModeConsumerRoot, "pnpm-workspace.yaml"),
    `packages:\n  - "packages/*"\noverrides:\n  "@agent-teams/engineering-foundation": "${archiveFileSpecifier}"\n`,
    "utf8"
  );
  const siblingPackageRoot = join(
    localModeConsumerRoot,
    "packages",
    "sibling"
  );
  await mkdir(siblingPackageRoot, { recursive: true });
  await writeFile(
    join(siblingPackageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "foundation-local-mode-sibling",
        version: "0.0.0",
        private: true
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await execFileAsync(
    pnpmExecutable,
    pnpmArguments(["install", "--ignore-scripts", "--no-frozen-lockfile"]),
    { cwd: localModeConsumerRoot }
  );
  await execFileAsync("git", ["init", "--quiet"], {
    cwd: localModeConsumerRoot
  });
  let rejectedOverride = false;
  try {
    await execFileAsync(
      pnpmExecutable,
      pnpmArguments([
        "exec",
        "agent-teams-foundation",
        "assert-registry",
        "--consumer",
        localModeConsumerRoot
      ]),
      { cwd: localModeConsumerRoot }
    );
  } catch {
    rejectedOverride = true;
  }
  if (!rejectedOverride) {
    throw new Error("Registry assertion accepted a local tarball override.");
  }

  const archiveIntegrity = `sha512-${createHash("sha512")
    .update(await readFile(archivePath))
    .digest("base64")}`;
  await writeFile(
    join(localModeConsumerRoot, "pnpm-workspace.yaml"),
    `packages:\n  - "packages/*"\n`,
    "utf8"
  );
  await writeFile(
    join(localModeConsumerRoot, "pnpm-lock.yaml"),
    registryLockfile(packedManifest.version, archiveIntegrity),
    "utf8"
  );
  let rejectedStaleInstall = false;
  try {
    await execFileAsync(
      pnpmExecutable,
      pnpmArguments([
        "exec",
        "agent-teams-foundation",
        "assert-registry",
        "--consumer",
        localModeConsumerRoot
      ]),
      { cwd: localModeConsumerRoot }
    );
  } catch {
    rejectedStaleInstall = true;
  }
  if (!rejectedStaleInstall) {
    throw new Error(
      "Registry assertion accepted a stale local virtual-store installation."
    );
  }
  await writeFile(
    join(localModeConsumerRoot, "node_modules", ".pnpm", "lock.yaml"),
    registryLockfile(packedManifest.version, archiveIntegrity),
    "utf8"
  );
  await execFileAsync(
    pnpmExecutable,
    pnpmArguments([
      "exec",
      "agent-teams-foundation",
      "assert-dev-only",
      "--consumer",
      localModeConsumerRoot
    ]),
    { cwd: localModeConsumerRoot }
  );
  await execFileAsync(
    pnpmExecutable,
    pnpmArguments([
      "exec",
      "agent-teams-foundation",
      "assert-registry",
      "--consumer",
      localModeConsumerRoot
    ]),
    { cwd: localModeConsumerRoot }
  );

  const localManifestPath = join(localModeConsumerRoot, "package.json");
  const localLockfilePath = join(localModeConsumerRoot, "pnpm-lock.yaml");
  const localWorkspacePath = join(
    localModeConsumerRoot,
    "pnpm-workspace.yaml"
  );
  const localManifestBefore = await readFile(localManifestPath, "utf8");
  const localLockfileBefore = await readFile(localLockfilePath, "utf8");
  const localWorkspaceBefore = await readFile(localWorkspacePath, "utf8");
  const siblingSentinelPath = join(
    siblingPackageRoot,
    "node_modules",
    "foundation-lifecycle-sentinel.txt"
  );
  await mkdir(join(siblingPackageRoot, "node_modules"), { recursive: true });
  await writeFile(siblingSentinelPath, "preserve-me\n", "utf8");

  const { stdout: attachOutput } = await execFileAsync(
    pnpmExecutable,
    pnpmArguments([
      "exec",
      "agent-teams-foundation",
      "attach",
      repositoryRoot,
      "--consumer",
      localModeConsumerRoot,
      "--json"
    ]),
    { cwd: localModeConsumerRoot }
  );
  const attachStatus = JSON.parse(attachOutput);
  if (attachStatus.mode !== "LOCAL") {
    throw new Error(`Local attach failed: ${attachOutput}`);
  }
  if ((await readFile(localManifestPath, "utf8")) !== localManifestBefore) {
    throw new Error("Local attach changed the consumer package.json.");
  }
  if ((await readFile(localLockfilePath, "utf8")) !== localLockfileBefore) {
    throw new Error("Local attach changed the consumer lockfile.");
  }
  if ((await readFile(localWorkspacePath, "utf8")) !== localWorkspaceBefore) {
    throw new Error("Local attach changed the consumer workspace configuration.");
  }
  if ((await readFile(siblingSentinelPath, "utf8")) !== "preserve-me\n") {
    throw new Error("Local attach changed a sibling workspace node_modules tree.");
  }

  const { stdout: detachOutput } = await execFileAsync(
    pnpmExecutable,
    pnpmArguments([
      "exec",
      "agent-teams-foundation",
      "detach",
      "--consumer",
      localModeConsumerRoot,
      "--json"
    ]),
    { cwd: localModeConsumerRoot }
  );
  const detachStatus = JSON.parse(detachOutput);
  if (detachStatus.mode !== "REGISTRY") {
    throw new Error(`Registry restoration failed: ${detachOutput}`);
  }
  if ((await readFile(localManifestPath, "utf8")) !== localManifestBefore) {
    throw new Error("Local detach changed the consumer package.json.");
  }
  if ((await readFile(localLockfilePath, "utf8")) !== localLockfileBefore) {
    throw new Error("Local detach changed the consumer lockfile.");
  }
  if ((await readFile(localWorkspacePath, "utf8")) !== localWorkspaceBefore) {
    throw new Error("Local detach changed the consumer workspace configuration.");
  }
  if ((await readFile(siblingSentinelPath, "utf8")) !== "preserve-me\n") {
    throw new Error("Local detach changed a sibling workspace node_modules tree.");
  }

  process.stdout.write(
    `Package and local-mode lifecycle verified: ${archiveName} (${packedManifest.version})\n`
  );
} finally {
  if (keepTemporaryRoot) {
    process.stderr.write(`Pack test artifacts: ${temporaryRoot}\n`);
  } else {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}
