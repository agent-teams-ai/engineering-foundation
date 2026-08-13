import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { runServer } from "verdaccio";

import {
  createPnpmRunner,
  runCommand,
  runNpmCommand,
} from "./pack-test-support.mjs";
import { registryPublishArguments } from "./registry-publication-policy.mjs";
import { verifyInstalledTransactionBarrier } from "./transaction-barrier-e2e.mjs";
import { verifyRegistryDocumentAuthoring } from "./registry-document-authoring-e2e.mjs";

const FOUNDATION_PACKAGE_NAME = "@agent-teams/engineering-foundation";
const COMMAND_TIMEOUT_MS = 120_000;
const REGISTRY_TOKEN_ENVIRONMENT_KEY = "FOUNDATION_REGISTRY_E2E_TOKEN";
const repositoryRoot = resolvePath(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = join(repositoryRoot, "packages", "engineering-foundation");
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "agent-teams-foundation-registry-e2e-"),
);
const keepTemporaryRoot =
  process.env.AGENT_TEAMS_KEEP_REGISTRY_E2E_ARTIFACTS === "1";
const runPnpm = createPnpmRunner();
const previousRegistryToken = process.env[REGISTRY_TOKEN_ENVIRONMENT_KEY];
let npmUserConfigPath;

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function runNpm(args, cwd) {
  const userConfigArgs =
    npmUserConfigPath === undefined ? [] : ["--userconfig", npmUserConfigPath];
  return runNpmCommand([...args, ...userConfigArgs, "--loglevel=error"], cwd, {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

async function readManifest(root) {
  return JSON.parse(await readFile(join(root, "package.json"), "utf8"));
}

function dependencyNames(manifest) {
  const optionalPeers = new Set(
    Object.entries(manifest.peerDependenciesMeta ?? {})
      .filter(([, metadata]) => metadata?.optional === true)
      .map(([name]) => name),
  );
  return [
    ...Object.keys(manifest.dependencies ?? {}).map((name) => ({
      name,
      optional: false,
    })),
    ...Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({
      name,
      optional: true,
    })),
    ...Object.keys(manifest.peerDependencies ?? {})
      .filter((name) => !optionalPeers.has(name))
      .map((name) => ({ name, optional: false })),
  ].toSorted((left, right) => compareStrings(left.name, right.name));
}

async function resolveDependencyRoot(fromRoot, dependencyName) {
  const pathSegments = dependencyName.split("/");
  let current = fromRoot;
  while (true) {
    const candidate = join(current, "node_modules", ...pathSegments);
    try {
      return await realpath(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

async function collectRuntimeDependencyClosure() {
  const collected = new Map();
  const queued = [{ root: packageRoot, manifest: await readManifest(packageRoot) }];
  for (let index = 0; index < queued.length; index += 1) {
    const current = queued[index];
    for (const dependency of dependencyNames(current.manifest)) {
      const root = await resolveDependencyRoot(current.root, dependency.name);
      if (root === undefined) {
        if (dependency.optional) {
          continue;
        }
        throw new Error(
          `Runtime dependency ${dependency.name} cannot be resolved from ${current.root}.`,
        );
      }
      const manifest = await readManifest(root);
      if (manifest.name !== dependency.name || typeof manifest.version !== "string") {
        throw new Error(`Resolved package identity is invalid for ${dependency.name}.`);
      }
      const identity = `${manifest.name}@${manifest.version}`;
      if (collected.has(identity)) {
        continue;
      }
      const entry = Object.freeze({ identity, manifest, root });
      collected.set(identity, entry);
      queued.push(entry);
    }
  }
  return [...collected.values()].toSorted((left, right) =>
    compareStrings(left.identity, right.identity),
  );
}

async function createTargetArchive() {
  const destination = join(temporaryRoot, "target");
  await mkdir(destination, { recursive: true });
  await runPnpm(["pack", "--pack-destination", destination], packageRoot);
  const manifest = await readManifest(packageRoot);
  const archiveName = `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`;
  const archivePath = join(destination, archiveName);
  await lstat(archivePath);
  return Object.freeze({ archivePath, manifest });
}

async function startRegistry() {
  const configPath = join(temporaryRoot, "verdaccio.yaml");
  await writeFile(
    configPath,
    [
      "storage: ./storage",
      "auth:",
      "  htpasswd:",
      "    file: ./htpasswd",
      "    max_users: 1",
      "uplinks: {}",
      "packages:",
      "  '@*/*':",
      "    access: $all",
      "    publish: $all",
      "    unpublish: $all",
      "  '**':",
      "    access: $all",
      "    publish: $all",
      "    unpublish: $all",
      "web:",
      "  enable: false",
      "log:",
      "  type: stdout",
      "  format: pretty",
      "  level: fatal",
      "",
    ].join("\n"),
    "utf8",
  );
  const app = await runServer(configPath);
  const server = await new Promise((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    candidate.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Hermetic registry did not expose a TCP address.");
  }
  return Object.freeze({
    registryUrl: `http://127.0.0.1:${address.port}`,
    server,
  });
}

async function configureRegistryAuthentication(registryUrl) {
  const username = "foundation-registry-e2e";
  const response = await fetch(
    `${registryUrl}/-/user/org.couchdb.user:${username}`,
    {
      body: JSON.stringify({
        _id: `org.couchdb.user:${username}`,
        email: "foundation-registry-e2e@example.invalid",
        name: username,
        password: "foundation-registry-e2e-password",
        roles: [],
        type: "user",
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    },
  );
  if (!response.ok) {
    throw new Error(
      `Hermetic registry user creation failed with HTTP ${response.status}.`,
    );
  }
  const body = await response.json();
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("Hermetic registry did not issue a publication token.");
  }
  const host = new URL(registryUrl).host;
  npmUserConfigPath = join(temporaryRoot, "auth", "npmrc");
  await mkdir(dirname(npmUserConfigPath), { recursive: true, mode: 0o700 });
  await writeFile(
    npmUserConfigPath,
    [
      `registry=${registryUrl}`,
      `@agent-teams:registry=${registryUrl}`,
      `//${host}/:_authToken=\${${REGISTRY_TOKEN_ENVIRONMENT_KEY}}`,
      "audit=false",
      "fund=false",
      "provenance=false",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  process.env[REGISTRY_TOKEN_ENVIRONMENT_KEY] = body.token;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

async function packPackage(entry, index) {
  const destination = join(temporaryRoot, "seed", String(index));
  await mkdir(destination, { recursive: true });
  await runPnpm(
    ["pack", "--pack-destination", destination, "--config.ignore-scripts=true"],
    entry.root,
  );
  const archives = (await readdir(destination)).filter((name) =>
    name.endsWith(".tgz"),
  );
  if (archives.length !== 1) {
    throw new Error(`pnpm pack did not report one archive for ${entry.identity}.`);
  }
  return join(destination, archives[0]);
}

async function publishArchive(archivePath, registryUrl, version) {
  await runNpm(
    registryPublishArguments({ archivePath, registryUrl, version }),
    repositoryRoot,
  );
}

async function seedRegistry(dependencies, registryUrl) {
  for (let index = 0; index < dependencies.length; index += 1) {
    const archivePath = await packPackage(dependencies[index], index);
    await publishArchive(
      archivePath,
      registryUrl,
      dependencies[index].manifest.version,
    );
  }
}

async function verifyInstalledBufQualifier(installedRoot) {
  if (process.platform === "win32") {
    return;
  }
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

async function verifyConsumer(target, registryUrl) {
  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "foundation-registry-e2e-consumer",
        private: true,
        type: "module",
        devDependencies: {
          [FOUNDATION_PACKAGE_NAME]: target.manifest.version,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await runNpm(
    [
      "install",
      "--registry",
      registryUrl,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=true",
    ],
    consumerRoot,
  );

  const installedRoot = join(
    consumerRoot,
    "node_modules",
    "@agent-teams",
    "engineering-foundation",
  );
  const installedEntry = await lstat(installedRoot);
  if (!installedEntry.isDirectory() || installedEntry.isSymbolicLink()) {
    throw new Error("Registry install did not produce a real package directory.");
  }
  const installedManifest = await readManifest(installedRoot);
  if (installedManifest.version !== target.manifest.version) {
    throw new Error("Registry install returned a different Foundation version.");
  }
  const lockfile = JSON.parse(
    await readFile(join(consumerRoot, "package-lock.json"), "utf8"),
  );
  const locked =
    lockfile.packages?.["node_modules/@agent-teams/engineering-foundation"];
  if (
    locked?.version !== target.manifest.version ||
    typeof locked.integrity !== "string" ||
    !locked.integrity.startsWith("sha512-") ||
    typeof locked.resolved !== "string" ||
    !locked.resolved.startsWith(registryUrl)
  ) {
    throw new Error("Registry lock evidence is incomplete or points outside the hermetic registry.");
  }

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
      `await Promise.all([import(${JSON.stringify(FOUNDATION_PACKAGE_NAME)}), import(${JSON.stringify(`${FOUNDATION_PACKAGE_NAME}/document-authoring`)}), import(${JSON.stringify(`${FOUNDATION_PACKAGE_NAME}/local-mode`)}), import(${JSON.stringify(`${FOUNDATION_PACKAGE_NAME}/scaffolding`)})]);`,
    ],
    consumerRoot,
    { timeoutMs: COMMAND_TIMEOUT_MS },
  );
  await verifyInstalledBufQualifier(installedRoot);
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
    version: target.manifest.version
  });
  const { stdout: viewedVersion } = await runNpm(
    [
      "view",
      `${FOUNDATION_PACKAGE_NAME}@${target.manifest.version}`,
      "version",
      "--registry",
      registryUrl,
    ],
    consumerRoot,
  );
  if (viewedVersion.trim() !== target.manifest.version) {
    throw new Error("Registry metadata did not return the published Foundation version.");
  }
  return createHash("sha256")
    .update(await readFile(join(consumerRoot, "package-lock.json")))
    .digest("hex");
}

let registry;
try {
  const target = await createTargetArchive();
  const dependencies = await collectRuntimeDependencyClosure();
  registry = await startRegistry();
  await configureRegistryAuthentication(registry.registryUrl);
  await seedRegistry(dependencies, registry.registryUrl);
  await publishArchive(
    target.archivePath,
    registry.registryUrl,
    target.manifest.version,
  );
  const lockDigest = await verifyConsumer(target, registry.registryUrl);
  process.stdout.write(
    `Registry-install qualification PASS: ${target.manifest.name}@${target.manifest.version}; ${dependencies.length} runtime packages; lock sha256:${lockDigest}.\n`,
  );
} finally {
  if (previousRegistryToken === undefined) {
    delete process.env[REGISTRY_TOKEN_ENVIRONMENT_KEY];
  } else {
    process.env[REGISTRY_TOKEN_ENVIRONMENT_KEY] = previousRegistryToken;
  }
  if (registry !== undefined) {
    await closeServer(registry.server);
  }
  if (keepTemporaryRoot) {
    process.stderr.write(`Registry E2E artifacts: ${temporaryRoot}\n`);
  } else {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}
