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
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { runServer } from "verdaccio";

import {
  createPnpmRunner,
  runNpmCommand,
} from "./pack-test-support.mjs";
import {
  verifyFoundationFeatures,
  verifyInstalledBufQualifierForPackage,
  verifyRegistryPackage,
} from "./registry-installed-package-qualification.mjs";
import { registryPublishArguments } from "./registry-publication-policy.mjs";
import { publishWithExactEffectReconciliation } from "./registry-publish-reconciliation.mjs";
import {
  installRegistryConsumerWithRetry,
  registryInstallAttemptPaths,
  runRegistryPhase,
  seedRegistryInParallel,
} from "./registry-seed-scheduler.mjs";
import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";
import {
  DOCS_PROTOCOL_PACKAGE_NAME,
  registryQualificationPackages,
  stageQualificationPackage,
} from "./registry-qualification-packages.mjs";

const FOUNDATION_PACKAGE_NAME = "@agent-teams/engineering-foundation";
const FOUNDATION_FEATURE_IMPORTS = [
  FOUNDATION_PACKAGE_NAME, `${FOUNDATION_PACKAGE_NAME}/document-authoring`,
  `${FOUNDATION_PACKAGE_NAME}/local-mode`, `${FOUNDATION_PACKAGE_NAME}/scaffolding`,
];
const REGISTRY_QUALIFICATION_PACKAGES = registryQualificationPackages(
  PUBLISHABLE_PACKAGES,
);
const TARGET_PACKAGE_NAMES = new Set(
  REGISTRY_QUALIFICATION_PACKAGES.map((releasePackage) => releasePackage.name),
);
const COMMAND_TIMEOUT_MS = 120_000;
const SEED_PUBLISH_TIMEOUT_MS = process.platform === "win32" ? 30_000 : COMMAND_TIMEOUT_MS;
const REGISTRY_SEED_CONCURRENCY = Math.min(4, availableParallelism());
const REGISTRY_TOKEN_ENVIRONMENT_KEY = "FOUNDATION_REGISTRY_E2E_TOKEN";
const USER_CONFIG_ENVIRONMENT_KEY = "NPM_CONFIG_USERCONFIG";
const repositoryRoot = resolvePath(fileURLToPath(new URL("..", import.meta.url)));
const temporaryRoot = await realpath(await mkdtemp(
  join(tmpdir(), "agent-teams-foundation-registry-e2e-"),
));
const keepTemporaryRoot =
  process.env.AGENT_TEAMS_KEEP_REGISTRY_E2E_ARTIFACTS === "1";
const runPnpm = createPnpmRunner();
const previousRegistryToken = process.env[REGISTRY_TOKEN_ENVIRONMENT_KEY];
const previousUserConfig = process.env[USER_CONFIG_ENVIRONMENT_KEY];
let npmUserConfigPath;

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function runNpm(
  args,
  cwd,
  {
    timeoutMs = COMMAND_TIMEOUT_MS,
    userConfigPath = npmUserConfigPath,
  } = {},
) {
  const userConfigArgs =
    userConfigPath === undefined ? [] : ["--userconfig", userConfigPath];
  return runNpmCommand([...args, ...userConfigArgs, "--loglevel=error"], cwd, {
    timeoutMs,
  });
}

async function writeRegistryUserConfig(path, registryUrl) {
  const host = new URL(registryUrl).host;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
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
  const queued = await Promise.all(
    REGISTRY_QUALIFICATION_PACKAGES.map(async (releasePackage) => {
      const root = join(repositoryRoot, releasePackage.root);
      return { root, manifest: await readManifest(root) };
    }),
  );
  for (let index = 0; index < queued.length; index += 1) {
    const current = queued[index];
    for (const dependency of dependencyNames(current.manifest)) {
      if (TARGET_PACKAGE_NAMES.has(dependency.name)) {
        continue;
      }
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

async function createTargetArchive(releasePackage, index) {
  const destination = join(temporaryRoot, "target", String(index));
  await mkdir(destination, { recursive: true });
  const packageRoot = await stageQualificationPackage({
    destination,
    foundationPackageName: FOUNDATION_PACKAGE_NAME,
    releasePackage,
    repositoryRoot,
  });
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
  npmUserConfigPath = join(temporaryRoot, "auth", "npmrc");
  await writeRegistryUserConfig(npmUserConfigPath, registryUrl);
  process.env[REGISTRY_TOKEN_ENVIRONMENT_KEY] = body.token;
  process.env[USER_CONFIG_ENVIRONMENT_KEY] = npmUserConfigPath;
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

async function publishArchive(
  archivePath, registryUrl, name, version, timeoutMs = COMMAND_TIMEOUT_MS,
) {
  const result = await publishWithExactEffectReconciliation({
    archivePath,
    name,
    publish: () => runNpm(registryPublishArguments({ archivePath, registryUrl, version }),
      repositoryRoot, { timeoutMs }),
    registryUrl,
    version,
  });
  if (result === "reconciled") {
    process.stdout.write(
      `Registry E2E publication reconciled exact effect for ${name}@${version}.\n`,
    );
  }
}

async function seedRegistry(dependencies, registryUrl) {
  await seedRegistryInParallel({
    concurrency: REGISTRY_SEED_CONCURRENCY,
    dependencies,
    packPackage,
    publishArchive: (archivePath, targetRegistryUrl, name, version) =>
      publishArchive(
        archivePath,
        targetRegistryUrl,
        name,
        version,
        SEED_PUBLISH_TIMEOUT_MS,
      ),
    registryUrl,
  });
}

async function verifyInstalledBufQualifier(installedRoot) {
  if (process.platform === "win32") {
    return;
  }
  await verifyInstalledBufQualifierForPackage(installedRoot);
}

async function createConsumerAttempt(targets, registryUrl, attempt) {
  const { cacheRoot, clientRoot, consumerRoot, userConfigPath } = registryInstallAttemptPaths(
    temporaryRoot,
    attempt,
  );
  await Promise.all([
    mkdir(cacheRoot, { recursive: true }),
    mkdir(consumerRoot, { recursive: true }),
  ]);
  await writeRegistryUserConfig(userConfigPath, registryUrl);
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "foundation-registry-e2e-consumer",
        private: true,
        type: "module",
        devDependencies: Object.fromEntries(
          targets.map((target) => [target.manifest.name, target.manifest.version]),
        ),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return Object.freeze({ cacheRoot, clientRoot, consumerRoot, userConfigPath });
}

async function installConsumer(targets, registryUrl) {
  return installRegistryConsumerWithRetry({
    cleanupAttempt: (context) => Promise.all([
      rm(context.clientRoot, { force: true, recursive: true }),
      rm(context.consumerRoot, { force: true, recursive: true }),
    ]),
    createAttempt: (attempt) =>
      createConsumerAttempt(targets, registryUrl, attempt),
    onRetry: ({ attempt, delayMs, timeoutMs }) => {
      process.stdout.write(
        `Registry E2E install retry attempt=${attempt} delayMs=${delayMs} timeoutMs=${timeoutMs}.\n`,
      );
    },
    runInstall: (context, { attempt, timeoutMs }) =>
      runRegistryPhase(`consumer-install-attempt-${attempt}`, async () => {
        await runNpm(
          [
            "install",
            "--registry",
            registryUrl,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--package-lock=true",
            "--cache",
            context.cacheRoot,
          ],
          context.consumerRoot,
          { timeoutMs, userConfigPath: context.userConfigPath },
        );
        return context;
      }),
  });
}

async function verifyConsumer(targets, registryUrl) {
  const { consumerRoot } = await installConsumer(targets, registryUrl);

  const foundationTarget = targets.find(
    (target) => target.manifest.name === FOUNDATION_PACKAGE_NAME,
  );
  if (foundationTarget === undefined) {
    throw new Error("Foundation target is missing from registry qualification.");
  }
  const docsTarget = targets.find(
    (target) => target.manifest.name === DOCS_PROTOCOL_PACKAGE_NAME,
  );
  if (docsTarget === undefined) {
    throw new Error("Docs Protocol target is missing from registry qualification.");
  }
  const lockfile = JSON.parse(
    await readFile(join(consumerRoot, "package-lock.json"), "utf8"),
  );
  let installedFoundationRoot;
  for (const target of targets) {
    const targetRoot = await verifyRegistryPackage({
      consumerRoot,
      lockfile,
      registryUrl,
      runNpm,
      target,
    });
    if (target.manifest.name === FOUNDATION_PACKAGE_NAME) {
      installedFoundationRoot = targetRoot;
    }
  }
  if (installedFoundationRoot === undefined) {
    throw new Error("Installed Foundation target is missing.");
  }
  await verifyFoundationFeatures({
    consumerRoot,
    docsVersion: docsTarget.manifest.version,
    featureImports: FOUNDATION_FEATURE_IMPORTS,
    installedRoot: installedFoundationRoot,
    repositoryRoot,
    verifyInstalledBufQualifier,
    version: foundationTarget.manifest.version,
  });
  return createHash("sha256")
    .update(await readFile(join(consumerRoot, "package-lock.json")))
    .digest("hex");
}

let registry;
try {
  const targets = await runRegistryPhase("target-archive", () =>
    Promise.all(REGISTRY_QUALIFICATION_PACKAGES.map(createTargetArchive)),
  );
  const dependencies = await runRegistryPhase(
    "dependency-closure",
    collectRuntimeDependencyClosure,
  );
  registry = await runRegistryPhase("registry-start", startRegistry);
  await runRegistryPhase("registry-auth", () =>
    configureRegistryAuthentication(registry.registryUrl),
  );
  await runRegistryPhase("registry-seed", () =>
    seedRegistry(dependencies, registry.registryUrl),
  );
  await runRegistryPhase("target-publish", async () => {
    for (const target of targets) {
      await publishArchive(
        target.archivePath,
        registry.registryUrl,
        target.manifest.name,
        target.manifest.version,
      );
    }
  });
  const lockDigest = await runRegistryPhase("consumer-qualification", () =>
    verifyConsumer(targets, registry.registryUrl),
  );
  process.stdout.write(
    `Registry-install qualification PASS: ${targets.map((target) => `${target.manifest.name}@${target.manifest.version}`).join(", ")}; ${dependencies.length} runtime packages; lock sha256:${lockDigest}.\n`,
  );
} finally {
  if (previousRegistryToken === undefined) {
    delete process.env[REGISTRY_TOKEN_ENVIRONMENT_KEY];
  } else {
    process.env[REGISTRY_TOKEN_ENVIRONMENT_KEY] = previousRegistryToken;
  }
  if (previousUserConfig === undefined) {
    delete process.env[USER_CONFIG_ENVIRONMENT_KEY];
  } else {
    process.env[USER_CONFIG_ENVIRONMENT_KEY] = previousUserConfig;
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
