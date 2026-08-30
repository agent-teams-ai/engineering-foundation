import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { createPnpmRunner, runNpmCommand } from "./pack-test-support.mjs";
import { verifyGithubTagRelease } from "./github-release-reconciliation.mjs";
import { verifiedProvenanceFromNpmAudit } from "./release-publish-ordered-runtime.mjs";
import {
  exactPublicCoordinateDecision,
  registryInstallMatrix,
} from "./registry-install-policy.mjs";
import { parsePublishedVersion } from "./release-publish-registry-version.mjs";
import {
  verifyRegistryDocsProtocolCli,
  verifyRegistryDocsProtocolMcp,
} from "./registry-docs-protocol-mcp-e2e.mjs";

const runPnpm = createPnpmRunner();
const DEPENDENCY_SECTIONS = [
  "dependencies", "optionalDependencies", "peerDependencies", "devDependencies",
];
const LOCAL_DEPENDENCY_PROTOCOL = /^(?:file|git\+file|link|workspace):/u;
const LOCAL_LOCKFILE_REFERENCE = /(?:^|@)(?:file|git\+file|link|workspace):/u;
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const PUBLIC_PACKAGE_IDENTITIES = Object.freeze({
  cli: Object.freeze({
    manifestPath: "../packages/docs-protocol/package.json",
    name: "@agent-teams/docs-protocol",
    registryPath: "%40agent-teams%2Fdocs-protocol",
  }),
  mcp: Object.freeze({
    manifestPath: "../packages/docs-protocol-mcp/package.json",
    name: "@agent-teams/docs-protocol-mcp",
    registryPath: "%40agent-teams%2Fdocs-protocol-mcp",
  }),
});

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function currentPublicCoordinates(authority, readPackageManifest) {
  return Object.freeze(await Promise.all(
    Object.entries(authority.packages).map(async ([id, { name }]) => {
      const identity = PUBLIC_PACKAGE_IDENTITIES[id];
      if (identity?.name !== name) {
        throw new Error(`Public Docs authority contains an untrusted package identity for ${id}.`);
      }
      const manifest = await readPackageManifest(new URL(identity.manifestPath, import.meta.url));
      if (manifest?.name !== identity.name) {
        throw new Error(`Public Docs manifest contains an untrusted package identity for ${id}.`);
      }
      if (parsePublishedVersion(manifest.version) === undefined) {
        throw new Error(`Public Docs manifest contains an invalid release version for ${name}.`);
      }
      return Object.freeze({
        name,
        registryPath: identity.registryPath,
        version: manifest.version,
      });
    }),
  ));
}

const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

async function observePublishedPackages(coordinates, registry, dependencies = {}) {
  const fetchRegistry = dependencies.fetchRegistry ?? fetch;
  const delay = dependencies.delay ?? wait;
  const attempts = dependencies.observationAttempts ?? 5;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error("Public npm observation attempts must be between one and five.");
  }
  return Object.fromEntries(await Promise.all(coordinates.map(async ({ name, registryPath }) => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response;
      try {
        response = await fetchRegistry(`${registry}${registryPath}`, {
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        if (attempt >= attempts) {
          throw error;
        }
        await delay(2 ** (attempt - 1) * 1_000);
        continue;
      }
      if (response.ok) {
        const packument = await response.json();
        if (
          typeof packument?.versions !== "object" ||
          packument.versions === null ||
          Array.isArray(packument.versions)
        ) {
          throw new Error(`Public npm observation returned malformed versions for ${name}.`);
        }
        const coordinate = coordinates.find((candidate) => candidate.name === name);
        const exact = packument.versions[coordinate.version];
        return [name, {
          integrity: exact?.dist?.integrity,
          latest: packument["dist-tags"]?.latest,
          versions: Object.keys(packument.versions),
        }];
      }
      if (attempt < attempts && (response.status === 404 || response.status >= 500)) {
        await delay(2 ** (attempt - 1) * 1_000);
        continue;
      }
      if (response.status === 404) {
        return [name, []];
      }
      throw new Error(`Public npm observation failed for ${name}: HTTP ${response.status}.`);
    }
    throw new Error(`Public npm observation exhausted unexpectedly for ${name}.`);
  })));
}

function parsedLockfileEvidence(lockfile) {
  let parsedLockfile;
  try {
    parsedLockfile = typeof lockfile === "string"
      ? parseYaml(lockfile, { maxAliasCount: 100, schema: "core" })
      : undefined;
  } catch {
    throw new Error("Public Docs lockfile is not valid JSON or YAML.");
  }
  if (typeof parsedLockfile !== "object" || parsedLockfile === null || Array.isArray(parsedLockfile)) {
    throw new Error("Public Docs lockfile is not valid JSON or YAML.");
  }
  return parsedLockfile;
}

function hasLocalLockfileReference(lockfile) {
  const pending = [lockfile];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null) {
      if (typeof current === "string" && LOCAL_LOCKFILE_REFERENCE.test(current)) {
        return true;
      }
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      if (LOCAL_LOCKFILE_REFERENCE.test(key)) {
        return true;
      }
      pending.push(value);
    }
  }
  return false;
}

export function assertRegistryOnlyInstallEvidence({ lockfile, manifests }) {
  if (hasLocalLockfileReference(parsedLockfileEvidence(lockfile))) {
    throw new Error("Public Docs lockfile contains a local or workspace dependency.");
  }
  for (const { manifest, name, version } of manifests) {
    if (manifest?.name !== name || manifest.version !== version) {
      throw new Error(`Public install resolved an unexpected identity for ${name}@${version}.`);
    }
    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = manifest[section] ?? {};
      if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies) ||
          Object.values(dependencies).some((value) =>
            typeof value !== "string" || LOCAL_DEPENDENCY_PROTOCOL.test(value))) {
        throw new Error(`Public install retained a local dependency in ${name} ${section}.`);
      }
    }
  }
}

async function installAndQualify({ coordinates, matrixEntry, mcpName, registry, temporaryRoot }) {
  const root = join(temporaryRoot, "public-docs-install", matrixEntry.id);
  await mkdir(root, { recursive: true });
  const userConfigPath = join(root, ".npmrc");
  await writeFile(userConfigPath, [
    `registry=${registry}`,
    `@agent-teams:registry=${registry}`,
    "audit=false",
    "fund=false",
    "",
  ].join("\n"), "utf8");
  const selected = coordinates.filter(({ name }) => matrixEntry.packageNames.includes(name));
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: `public-docs-install-${matrixEntry.id}`,
    private: true,
    type: "module",
    devDependencies: Object.fromEntries(selected.map(({ name, version }) => [name, version])),
  }, null, 2)}\n`, "utf8");
  if (matrixEntry.manager === "npm") {
    await runNpmCommand([
      "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=true",
      "--registry", registry, "--userconfig", userConfigPath,
    ], root, { timeoutMs: 240_000 });
  } else {
    await runPnpm([
      "install", "--ignore-scripts", "--registry", registry,
      `--config.userconfig=${userConfigPath}`, "--store-dir", join(root, ".pnpm-store"),
    ], root);
  }
  const installed = new Map(await Promise.all(selected.map(async ({ name, version }) => {
    const installedRoot = await realpath(join(root, "node_modules", ...name.split("/")));
    return [name, {
      installedRoot,
      manifest: JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")),
      name,
      version,
    }];
  })));
  assertRegistryOnlyInstallEvidence({
    lockfile: await readFile(join(
      root,
      matrixEntry.manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml",
    ), "utf8"),
    manifests: [...installed.values()],
  });
  const docsRoot = installed.get("@agent-teams/docs-protocol").installedRoot;
  if (matrixEntry.profile === "docs-only") {
    await verifyRegistryDocsProtocolCli({
      consumerRoot: join(root, "cli-consumer"),
      installedDocsRoot: docsRoot,
    });
    return Object.freeze({ root, userConfigPath });
  }
  const mcpRoot = installed.get("@agent-teams/docs-protocol-mcp").installedRoot;
  await verifyRegistryDocsProtocolMcp({
    consumerRoot: root,
    installedDocsRoot: docsRoot,
    installedMcpRoot: mcpRoot,
    mcpVersion: coordinates.find(({ name }) => name === mcpName).version,
  });
  return Object.freeze({ root, userConfigPath });
}

function canonicalIntegrity(value, name) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(value ?? "");
  const bytes = match === null ? undefined : Buffer.from(match[1], "base64");
  if (bytes?.length !== 64 || bytes.toString("base64") !== match[1]) {
    throw new Error(`Public npm returned invalid integrity for ${name}.`);
  }
  return value;
}

function registryDecision(coordinates, published) {
  const publishedVersions = Object.fromEntries(coordinates.map(({ name }) => [
    name,
    published[name]?.versions ?? [],
  ]));
  const decision = exactPublicCoordinateDecision({ coordinates, publishedVersions });
  if (decision.status === "pending") {
    return decision;
  }
  const artifacts = coordinates.map(({ name, version }) => {
    const evidence = published[name];
    if (evidence.latest !== version) {
      throw new Error(`Public npm latest dist-tag drifted for ${name}@${version}.`);
    }
    return Object.freeze({
      integrity: canonicalIntegrity(evidence.integrity, name),
      latest: evidence.latest,
      name,
      version,
    });
  });
  return Object.freeze({ ...decision, artifacts: Object.freeze(artifacts) });
}

async function npmAuditSignatures({ registry, root, userConfigPath }) {
  const result = await runNpmCommand([
    "audit", "signatures", "--json", "--include-attestations",
    "--registry", registry, "--userconfig", userConfigPath,
  ], root, { timeoutMs: 240_000 });
  return JSON.parse(result.stdout);
}

function githubRepository(repository) {
  const url = new URL(repository);
  const path = url.pathname.replace(/^\//u, "").replace(/\.git$/u, "");
  if (url.protocol !== "https:" || url.hostname !== "github.com" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(path)) {
    throw new Error("Public Docs authority contains an invalid GitHub source repository.");
  }
  return path;
}

export async function verifyPublicExactDocsCoordinates({ temporaryRoot }, dependencies = {}) {
  const authority = await json(new URL(
    "../architecture/foundation/open-source-docs-release.json",
    import.meta.url,
  ));
  if (authority.registry !== PUBLIC_NPM_REGISTRY) {
    throw new Error("Public Docs authority must use the pinned public npm registry.");
  }
  const coordinates = await currentPublicCoordinates(
    authority,
    dependencies.readPackageManifest ?? json,
  );
  const observe = dependencies.observePublishedPackages ?? observePublishedPackages;
  const published = await observe(coordinates, PUBLIC_NPM_REGISTRY, dependencies);
  const decision = registryDecision(coordinates, published);
  if (decision.status === "pending") {
    return decision;
  }
  const qualify = dependencies.installAndQualify ?? installAndQualify;
  const installs = new Map();
  const matrix = registryInstallMatrix({
    docsPackageName: authority.packages.cli.name,
    managers: authority.qualifiedPackageManagers,
    mcpPackageName: authority.packages.mcp.name,
  });
  for (const matrixEntry of matrix) {
    installs.set(matrixEntry.id, await qualify({
      coordinates,
      matrixEntry,
      mcpName: authority.packages.mcp.name,
      registry: PUBLIC_NPM_REGISTRY,
      temporaryRoot,
    }));
  }
  const npmPair = installs.get("npm-docs-mcp");
  if (typeof npmPair?.root !== "string" || typeof npmPair.userConfigPath !== "string") {
    throw new Error("Public npm pair qualification did not return its disposable install root.");
  }
  const audit = dependencies.auditSignatures ?? npmAuditSignatures;
  const auditEvidence = await audit({
    registry: PUBLIC_NPM_REGISTRY,
    root: npmPair.root,
    userConfigPath: npmPair.userConfigPath,
  });
  const verifyProvenance = dependencies.verifyProvenance ?? verifiedProvenanceFromNpmAudit;
  const provenances = decision.artifacts.map((artifact) => verifyProvenance(
    auditEvidence,
    artifact,
    authority.source,
  ));
  const commits = new Set(provenances.map(({ commit }) => commit));
  if (commits.size !== 1) {
    throw new Error("Public Docs packages are not bound to one provenance commit.");
  }
  const [commit] = commits;
  const verifyGithub = dependencies.verifyGithub ?? verifyGithubTagRelease;
  const repository = githubRepository(authority.source.repository);
  for (const artifact of decision.artifacts) {
    await verifyGithub(`${artifact.name}@${artifact.version}`, commit, { repository });
  }
  const finalPublished = await observe(coordinates, PUBLIC_NPM_REGISTRY, dependencies);
  const finalDecision = registryDecision(coordinates, finalPublished);
  if (finalDecision.status !== "ready") {
    throw new Error("Public Docs coordinates became unavailable during qualification.");
  }
  if (JSON.stringify(finalDecision.artifacts) !== JSON.stringify(decision.artifacts)) {
    throw new Error("Public Docs registry identity drifted during qualification.");
  }
  return Object.freeze({
    ...finalDecision,
    commit,
    matrix: Object.freeze(matrix.map(({ id }) => id)),
  });
}

export function requirePublicDocsDecision(decision, { required = false } = {}) {
  if (required && decision.status !== "ready") {
    const missing = decision.missing?.map(({ name, version }) => `${name}@${version}`).join(", ");
    throw new Error(`Required public Docs Protocol coordinates are not available: ${missing || "unknown"}.`);
  }
  return decision;
}
