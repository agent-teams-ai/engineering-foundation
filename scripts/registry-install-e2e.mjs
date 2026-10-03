// oxlint-disable max-lines -- The registry matrix remains one auditable disposable orchestration.
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPnpmRunner,
  runNpmCommand,
} from "./pack-test-support.mjs";
import {
  verifyRegistryDocsProtocolCli,
  verifyRegistryDocsProtocolMcp,
} from "./registry-docs-protocol-mcp-e2e.mjs";
import {
  registryFoundationQualificationProfile,
  registryInstallMatrix,
} from "./registry-install-policy.mjs";
import {
  verifyFoundationFeatures,
  verifyInstalledBufQualifierForPackage,
  verifyRegistryPackage,
  verifyRegistryTargetDownload,
  verifyInstalledTargetPayload,
  verifyPnpmTargetIntegrity,
} from "./registry-installed-package-qualification.mjs";
import { registryPublishArguments } from "./registry-publication-policy.mjs";
import { verifyRegistryQualityCast } from "./registry-quality-cast-e2e.mjs";
import { publishWithExactEffectReconciliation } from "./registry-publish-reconciliation.mjs";
import {
  installRegistryConsumerWithRetry,
  registryInstallAttemptPaths,
  runRegistryPhase,
  seedRegistryInParallel,
} from "./registry-seed-scheduler.mjs";
import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";
import { runQualifiedArtifactConsumer, withQualifiedPackageArtifacts } from "./pack-publishable-artifacts.mjs";
import {
  packageQualificationPhaseIds, runPackageQualificationPhases,
} from "./package-qualification-groups.mts";
import { readQualifiedReleaseArtifact } from "./pack-artifact-archive.mjs";
import {
  DOCS_PROTOCOL_PACKAGE_NAME,
  registryQualificationPackages,
} from "./registry-qualification-packages.mjs";

const FOUNDATION_PACKAGE_NAME = "@agent-teams/engineering-foundation";
const DOCUMENT_AUTHORING_PACKAGE_NAME = "@agent-teams/document-authoring";
const DOCS_PROTOCOL_ADAPTER_PACKAGE_NAME = "@agent-teams/docs-protocol-agent-teams";
const DOCS_PROTOCOL_MCP_PACKAGE_NAME = "@agent-teams/docs-protocol-mcp";
const FOUNDATION_FEATURE_IMPORTS = [
  FOUNDATION_PACKAGE_NAME,
  `${FOUNDATION_PACKAGE_NAME}/local-mode`, `${FOUNDATION_PACKAGE_NAME}/scaffolding`,
];
const REGISTRY_QUALIFICATION_PACKAGES = registryQualificationPackages(
  PUBLISHABLE_PACKAGES,
);
const TARGET_PACKAGE_NAMES = new Set(
  REGISTRY_QUALIFICATION_PACKAGES.map((releasePackage) => releasePackage.name),
);
const COMMAND_TIMEOUT_MS = 120_000;
const REGISTRY_SEED_CONCURRENCY = Math.min(4, availableParallelism());
const REGISTRY_TOKEN_ENVIRONMENT_KEY = "FOUNDATION_REGISTRY_E2E_TOKEN";
const USER_CONFIG_ENVIRONMENT_KEY = "NPM_CONFIG_USERCONFIG";
const repositoryRoot = resolvePath(fileURLToPath(new URL("..", import.meta.url)));
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function runRegistryNpm(
  args,
  cwd,
  {
    timeoutMs = COMMAND_TIMEOUT_MS,
    userConfigPath,
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

async function createTargetArchives(artifacts) {
  return Promise.all(REGISTRY_QUALIFICATION_PACKAGES.map(async (entry) => {
    const manifest = await readManifest(join(repositoryRoot, entry.root));
    return Object.freeze(await readQualifiedReleaseArtifact(artifacts[entry.name], manifest));
  }));
}

async function startRegistry(temporaryRoot) {
  const { runServer } = await import("verdaccio");
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

async function configureRegistryAuthentication(registryUrl, temporaryRoot) {
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
  const npmUserConfigPath = join(temporaryRoot, "auth", "npmrc");
  await writeRegistryUserConfig(npmUserConfigPath, registryUrl);
  process.env[REGISTRY_TOKEN_ENVIRONMENT_KEY] = body.token;
  process.env[USER_CONFIG_ENVIRONMENT_KEY] = npmUserConfigPath;
  return npmUserConfigPath;
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

async function packPackage(entry, index, { temporaryRoot, runPnpm }) {
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
  archivePath, registryUrl, name, version, runNpm,
) {
  const result = await publishWithExactEffectReconciliation({
    archivePath,
    name,
    publish: () => runNpm(registryPublishArguments({ archivePath, registryUrl, version }),
      repositoryRoot, { timeoutMs: COMMAND_TIMEOUT_MS }),
    registryUrl,
    version,
  });
  if (result === "reconciled") {
    process.stdout.write(
      `Registry E2E publication reconciled exact effect for ${name}@${version}.\n`,
    );
  }
}

async function seedRegistry(dependencies, registryUrl, { temporaryRoot, runPnpm, runNpm }) {
  await seedRegistryInParallel({
    concurrency: REGISTRY_SEED_CONCURRENCY,
    dependencies,
    packPackage: (entry, index) => packPackage(entry, index, { temporaryRoot, runPnpm }),
    publishArchive: (path, url, name, version) => publishArchive(path, url, name, version, runNpm),
    registryUrl,
  });
}

async function verifyInstalledBufQualifier(installedRoot) {
  if (process.platform === "win32") {
    return;
  }
  await verifyInstalledBufQualifierForPackage(installedRoot);
}

async function createConsumerAttempt(targets, registryUrl, matrixEntry, attempt, temporaryRoot) {
  const { cacheRoot, clientRoot, consumerRoot, userConfigPath } = registryInstallAttemptPaths(
    join(temporaryRoot, "consumer-matrix", matrixEntry.id),
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
        name: `foundation-registry-e2e-${matrixEntry.id}`,
        private: true,
        type: "module",
        devDependencies: Object.fromEntries(
          targets
            .filter((target) => matrixEntry.packageNames.includes(target.manifest.name))
            .map((target) => [target.manifest.name, target.manifest.version]),
        ),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return Object.freeze({ cacheRoot, clientRoot, consumerRoot, userConfigPath });
}

async function installConsumer(targets, registryUrl, matrixEntry, { temporaryRoot, runPnpm, runNpm }) {
  return installRegistryConsumerWithRetry({
    cleanupAttempt: (context) => Promise.all([
      rm(context.clientRoot, { force: true, recursive: true }),
      rm(context.consumerRoot, { force: true, recursive: true }),
    ]),
    createAttempt: (attempt) =>
      createConsumerAttempt(targets, registryUrl, matrixEntry, attempt, temporaryRoot),
    onRetry: ({ attempt, delayMs, timeoutMs }) => {
      process.stdout.write(
        `Registry E2E install retry attempt=${attempt} delayMs=${delayMs} timeoutMs=${timeoutMs}.\n`,
      );
    },
    runInstall: (context, { attempt, timeoutMs }) =>
      runRegistryPhase(`consumer-install-attempt-${attempt}`, async () => {
        if (matrixEntry.manager === "npm") {
          await runNpm(
            [
              "install", "--registry", registryUrl, "--ignore-scripts",
              "--no-audit", "--no-fund", "--package-lock=true",
              "--cache", context.cacheRoot,
            ],
            context.consumerRoot,
            { timeoutMs, userConfigPath: context.userConfigPath },
          );
        } else {
          await runPnpm([
            "install", "--registry", registryUrl, "--ignore-scripts",
            `--config.userconfig=${context.userConfigPath}`,
            "--store-dir", context.cacheRoot,
          ], context.consumerRoot);
        }
        return context;
      }),
  });
}

async function verifyPnpmRegistryPackage({ consumerRoot, registryUrl, target, userConfigPath, runPnpm }) {
  const targetRoot = await realpath(join(
    consumerRoot, "node_modules", ...target.manifest.name.split("/"),
  ));
  const installedManifest = await readManifest(targetRoot);
  if (installedManifest.name !== target.manifest.name || installedManifest.version !== target.manifest.version) {
    throw new Error(`pnpm installed the wrong version of ${target.manifest.name}.`);
  }
  const viewed = await runPnpm([
    "view", `${target.manifest.name}@${target.manifest.version}`, "version",
    "--registry", registryUrl, `--config.userconfig=${userConfigPath}`,
  ], consumerRoot);
  if (viewed.stdout.trim() !== target.manifest.version) {
    throw new Error(`pnpm registry metadata is incomplete for ${target.manifest.name}.`);
  }
  await verifyPnpmTargetIntegrity(consumerRoot, target);
  await verifyInstalledTargetPayload(targetRoot, target);
  return targetRoot;
}

async function verifyConsumer(targets, registryUrl, matrixEntry, commands) {
  const { consumerRoot, userConfigPath } = await installConsumer(
    targets, registryUrl, matrixEntry, commands,
  );
  const requiredTarget = (name) => {
    const target = targets.find((candidate) => candidate.manifest.name === name);
    if (target === undefined) {
      throw new Error(`${name} target is missing from registry qualification.`);
    }
    return target;
  };
  requiredTarget(FOUNDATION_PACKAGE_NAME);
  const authoringTarget = requiredTarget(DOCUMENT_AUTHORING_PACKAGE_NAME);
  const docsTarget = requiredTarget(DOCS_PROTOCOL_PACKAGE_NAME);
  const mcpTarget = requiredTarget(DOCS_PROTOCOL_MCP_PACKAGE_NAME);
  const selectedTargets = targets.filter((target) =>
    matrixEntry.packageNames.includes(target.manifest.name),
  );
  if (selectedTargets.length !== matrixEntry.packageNames.length) {
    throw new Error(`Registry matrix ${matrixEntry.id} is missing a target archive.`);
  }
  const lockfile = matrixEntry.manager === "npm"
    ? JSON.parse(await readFile(join(consumerRoot, "package-lock.json"), "utf8"))
    : undefined;
  const installedRoots = new Map();
  for (const target of selectedTargets) {
    const targetRoot = matrixEntry.manager === "npm"
      ? await verifyRegistryPackage({ consumerRoot, lockfile, registryUrl, runNpm: commands.runNpm, target })
      : await verifyPnpmRegistryPackage({
        consumerRoot, registryUrl, target, userConfigPath, runPnpm: commands.runPnpm,
      });
    installedRoots.set(target.manifest.name, targetRoot);
  }
  const installedDocsRoot = installedRoots.get(DOCS_PROTOCOL_PACKAGE_NAME);
  const installedAdapterRoot = installedRoots.get(DOCS_PROTOCOL_ADAPTER_PACKAGE_NAME);
  const installedMcpRoot = installedRoots.get(DOCS_PROTOCOL_MCP_PACKAGE_NAME);
  if (installedDocsRoot === undefined) {
    throw new Error("Installed Docs Protocol qualification target is missing.");
  }
  if (matrixEntry.profile === "docs-only") {
    await verifyRegistryDocsProtocolCli({
      consumerRoot: join(consumerRoot, "docs-protocol-cli-consumer"),
      installedDocsRoot,
    });
  } else if (matrixEntry.profile === "docs-mcp") {
    if (installedMcpRoot === undefined) {
      throw new Error("Installed Docs Protocol MCP qualification target is missing.");
    }
    await verifyRegistryDocsProtocolMcp({
      consumerRoot,
      installedDocsRoot,
      installedMcpRoot,
      mcpVersion: mcpTarget.manifest.version,
    });
  }
  if (matrixEntry.profile === "foundation-full") {
    const installedFoundationRoot = installedRoots.get(FOUNDATION_PACKAGE_NAME);
    if (installedFoundationRoot === undefined || installedAdapterRoot === undefined) {
      throw new Error("Installed Foundation qualification package is missing.");
    }
    await verifyFoundationFeatures({
      consumerRoot,
      authoringVersion: authoringTarget.manifest.version,
      docsVersion: docsTarget.manifest.version,
      featureImports: FOUNDATION_FEATURE_IMPORTS,
      installedAdapterRoot,
      installedDocsRoot,
      installedRoot: installedFoundationRoot,
      repositoryRoot,
      verifyInstalledBufQualifier,
    });
    await verifyRegistryQualityCast({ consumerRoot, installedRoot: installedFoundationRoot });
  }
  const lockPath = join(
    consumerRoot,
    matrixEntry.manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml",
  );
  return createHash("sha256")
    .update(await readFile(lockPath))
    .digest("hex");
}


async function qualifyRegistryMatrix(targets, registryUrl, commands, checkpoint, group) {
  const matrix = registryInstallMatrix({
    docsPackageName: DOCS_PROTOCOL_PACKAGE_NAME,
    mcpPackageName: DOCS_PROTOCOL_MCP_PACKAGE_NAME,
  });
  const foundationEntry = registryFoundationQualificationProfile({
    adapterPackageName: DOCS_PROTOCOL_ADAPTER_PACKAGE_NAME,
    authoringPackageName: DOCUMENT_AUTHORING_PACKAGE_NAME,
    docsPackageName: DOCS_PROTOCOL_PACKAGE_NAME,
    foundationPackageName: FOUNDATION_PACKAGE_NAME,
    mcpPackageName: DOCS_PROTOCOL_MCP_PACKAGE_NAME,
  });
  const lockDigests = [];
  await runPackageQualificationPhases("registry", group, [...matrix, foundationEntry].map(matrixEntry => ({
    id: matrixEntry.id,
    run: async () => {
      await checkpoint();
      lockDigests.push([matrixEntry.id, await runRegistryPhase(
        `consumer-qualification-${matrixEntry.id}`,
        () => verifyConsumer(targets, registryUrl, matrixEntry, commands),
      )]);
      await checkpoint();
    }
  })));
  process.stdout.write(
    `Registry consumers verified: ${targets.map((target) => `${target.manifest.name}@${target.manifest.version}`).join(", ")}; ${lockDigests.map(([id, digest]) => `${id}=sha256:${digest}`).join(", ")}.\n`,
  );
}

/**
 * @param {import("./package-artifact-custody.mts").QualificationHandle} handle
 * @param {import("./package-qualification-groups.mts").RegistryQualificationGroup | undefined} [group]
 */
export function qualifyRegistryConsumers(handle, group) {
  packageQualificationPhaseIds("registry", group);
  return runQualifiedArtifactConsumer(handle, "registry", async ({ artifacts, temporaryRoot, checkpoint }) => {
    const runPnpm = createPnpmRunner();
    const previousRegistryToken = process.env[REGISTRY_TOKEN_ENVIRONMENT_KEY];
    const previousUserConfig = process.env[USER_CONFIG_ENVIRONMENT_KEY];
    let npmUserConfigPath;
    const commands = { temporaryRoot, runPnpm, runNpm: (args, cwd, options = {}) =>
      runRegistryNpm(args, cwd, { ...options, userConfigPath: options.userConfigPath ?? npmUserConfigPath }) };
    let registry;
    try {
      await checkpoint();
      const targets = await runRegistryPhase("target-archive", () => createTargetArchives(artifacts));
      const dependencies = await runRegistryPhase(
        "dependency-closure",
        collectRuntimeDependencyClosure,
      );
      registry = await runRegistryPhase("registry-start", () => startRegistry(temporaryRoot));
      npmUserConfigPath = await runRegistryPhase("registry-auth", () =>
        configureRegistryAuthentication(registry.registryUrl, temporaryRoot),
      );
      await runRegistryPhase("registry-seed", () =>
        seedRegistry(dependencies, registry.registryUrl, commands),
      );
      await runRegistryPhase("target-publish", async () => {
        for (const target of targets) {
          await checkpoint();
          await publishArchive(
            target.archivePath,
            registry.registryUrl,
            target.manifest.name,
            target.manifest.version,
            commands.runNpm,
          );
        }
      });
      await checkpoint();
      for (const target of targets) {
        await verifyRegistryTargetDownload(target, registry.registryUrl);
      }
      await checkpoint();
      await qualifyRegistryMatrix(targets, registry.registryUrl, commands, checkpoint, group);
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
      await checkpoint();
    }
  });
}

/** @param {import("./package-qualification-groups.mts").RegistryQualificationGroup | undefined} [group] */
export async function runRegistryInstallTest(group) {
  packageQualificationPhaseIds("registry", group);
  const evidence = await withQualifiedPackageArtifacts("registry", handle => qualifyRegistryConsumers(handle, group));
  process.stdout.write(`Registry-install${group === undefined ? "" : ` group ${group}`} qualification PASS: ${JSON.stringify(evidence)}\n`);
  return evidence;
}

if (import.meta.main) {
  if (process.argv.length !== 2) { throw new Error("Registry qualification accepts no archive overrides or arguments."); }
  await runRegistryInstallTest();
}
