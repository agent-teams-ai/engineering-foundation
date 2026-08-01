import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
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

const execFileAsync = promisify(execFile);
const requireFromRepository = createRequire(import.meta.url);
const oxlintRoot = dirname(requireFromRepository.resolve("oxlint/package.json"));
const oxlintEntrypoint = join(oxlintRoot, "bin", "oxlint");
const typescriptEntrypoint = join(
  dirname(requireFromRepository.resolve("typescript/package.json")),
  "lib",
  "tsc.js"
);
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
  "foundation-link.json"
];

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
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/cli.js",
    "package/presets/oxlint/base.json",
    "package/presets/oxlint/node.json",
    "package/presets/typescript/base.json",
    "package/presets/typescript/node.json",
    "package/schemas/foundation-config/v1.schema.json",
    "package/schemas/foundation-check-report/v1.schema.json",
    "package/schemas/workspace-dependency-declarations/v1.schema.json"
  ]) {
    if (!listing.split(/\r?\n/u).includes(required)) {
      throw new Error(`Required package entry missing: ${required}`);
    }
  }

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
          "@agent-teams/engineering-foundation": archiveFileSpecifier
        }
      },
      null,
      2
    )}\n`,
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
          "@agent-teams/engineering-foundation": packedManifest.version
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "pnpm-workspace.yaml"),
    `packages:\n  - "packages/*"\ncatalogMode: strict\ncatalog: {}\n`,
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "foundation.config.yaml"),
    `schemaVersion: 1\nproject:\n  id: pack-consumer\ncapabilities:\n  workspace.dependency-declarations:\n    configPath: architecture/foundation/dependency-declarations.yaml\n`,
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
    `schemaVersion: 1\npackageManager:\n  kind: pnpm\n  workspaceManifest: pnpm-workspace.yaml\npolicies:\n  externalDependencies: catalog\n  catalogVersions: exact\n  internalDependencies: workspace-protocol\n  reservedScopes:\n    - "@agent-teams/"\n  developmentOnlyPackages:\n    - oxlint\n    - typescript\n  exactRegistryDevelopmentOnlyPackages:\n    - "@agent-teams/engineering-foundation"\n`,
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
    packedCheck.capabilities?.[0]?.capabilityId !==
      "workspace.dependency-declarations"
  ) {
    throw new Error("Packed executable capability check did not pass.");
  }
  const consumerSourceRoot = join(consumerRoot, "src");
  await mkdir(consumerSourceRoot, { recursive: true });
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
    [typescriptEntrypoint, "--project", join(consumerRoot, "tsconfig.json")],
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
      oxlintEntrypoint,
      "--config",
      join(consumerRoot, ".oxlintrc.json"),
      "--deny-warnings",
      join(consumerRoot, "src")
    ],
    { cwd: consumerRoot }
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
