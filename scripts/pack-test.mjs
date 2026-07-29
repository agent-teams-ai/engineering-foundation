import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
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
    "package/dist/cli.js"
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
  await execFileAsync(
    "node",
    [
      "--input-type=module",
      "--eval",
      [
        'import { defineFoundationConfig } from "@agent-teams/engineering-foundation";',
        "const config = defineFoundationConfig({",
        "  schemaVersion: 1,",
        '  projectId: "pack-consumer",',
        '  projectKind: "tooling",',
        "  capabilities: { lint: { enabled: true } }",
        "});",
        'if (config.projectId !== "pack-consumer") process.exit(2);'
      ].join("\n")
    ],
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
