import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";

import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";
import {
  assertExactChangesetInventory,
  exactChangesetPreState,
} from "./release-changeset-state.mjs";
import { changesetsPublishArguments, releasePublishInvocation } from "./release-publish-command.mjs";

export { changesetsPublishArguments, releasePublishInvocation };

const allowedPrereleaseTag = "rc";
const changesetMetadataFiles = new Set(["config.json", "pre.json"]);
const workspacePackageGlobs = Object.freeze(["packages/*", "spikes/*"]);
const releaseControlPaths = Object.freeze([
  ".node-version", ".npmrc", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
]);
const workspaceRoots = Object.freeze(workspacePackageGlobs.map((pattern) => pattern.slice(0, -2)));
const registryTimeoutMilliseconds = 10_000;
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const rcVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.(0|[1-9]\d*)$/u;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStableVersion(version) {
  const match = stableVersionPattern.exec(version);
  return match === null ? undefined : match.slice(1).map(BigInt);
}

function parseRcVersion(version) {
  const match = rcVersionPattern.exec(version);
  return match === null ? undefined : {
    core: match.slice(1, 4).map(BigInt), iteration: BigInt(match[4]),
  };
}

function compareVersionCore(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] > right[index] ? 1 : -1;
    }
  }
  return 0;
}

function exactRecord(left, right) {
  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }
  const leftEntries = Object.entries(left);
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([key, value]) => right[key] === value)
  );
}

export function releasePublishPolicy({ packageVersion, preState }) {
  if (parseStableVersion(packageVersion) !== undefined) {
    if (preState !== undefined) {
      throw new Error("Stable publication is forbidden while Changesets prerelease state exists.");
    }
    return { tag: undefined };
  }
  if (
    !isRecord(preState) ||
    preState.mode !== "pre" ||
    preState.tag !== allowedPrereleaseTag ||
    parseRcVersion(packageVersion) === undefined
  ) {
    throw new Error("Prerelease publication requires exact Changesets rc mode and an -rc.N package version.");
  }
  return { tag: allowedPrereleaseTag };
}

function exactInitialVersions(packages, preState) {
  const workspaceVersions = Object.fromEntries(
    [...packages.private, ...packages.public].map(({ name, version }) => [name, version]),
  );
  return packages.public.length > 0 && exactRecord(preState?.initialVersions, workspaceVersions);
}

function validPrereleaseProgression(packageInfo, initialVersion) {
  if (packageInfo.version === initialVersion) {
    return parseStableVersion(initialVersion) !== undefined;
  }
  const initial = parseStableVersion(initialVersion);
  const target = parseRcVersion(packageInfo.version);
  return initial !== undefined && target !== undefined && compareVersionCore(target.core, initial) > 0;
}

function exactPrereleasePackageSet(packages, preState) {
  if (!isRecord(preState?.initialVersions)) {
    return false;
  }
  const workspacePackages = [...packages.private, ...packages.public];
  const workspaceByName = new Map(workspacePackages.map((packageInfo) => [packageInfo.name, packageInfo]));
  const initialEntries = Object.entries(preState.initialVersions);
  return (
    initialEntries.every(([name]) => workspaceByName.has(name)) &&
    packages.private.every(({ name, version }) => preState.initialVersions[name] === version) &&
    packages.public.every((packageInfo) => {
      const initialVersion = preState.initialVersions[packageInfo.name];
      return typeof initialVersion === "string" && validPrereleaseProgression(packageInfo, initialVersion);
    }) &&
    initialEntries.length === workspacePackages.length
  );
}

function freshPrereleaseState({ inventory, packages, preState }) {
  return (
    packages.public.length > 0 &&
    packages.public.every(({ version }) => parseStableVersion(version) !== undefined) &&
    exactChangesetPreState(preState) &&
    preState.mode === "pre" &&
    preState.tag === allowedPrereleaseTag &&
    exactInitialVersions(packages, preState) &&
    Array.isArray(preState.changesets) &&
    preState.changesets.length === 0 &&
    inventory.pending.length === 0 &&
    inventory.unexpected.length === 0
  );
}

export function releasePublishDecision({ inventory, packages, preState }) {
  assertExactChangesetInventory(inventory, preState);
  const freshPrerelease = freshPrereleaseState({ inventory, packages, preState });
  if (freshPrerelease) {
    return { action: "noop" };
  }
  if (packages.public.length === 0) {
    throw new Error("Release publication requires at least one cataloged public package.");
  }
  if (preState !== undefined) {
    const hasRcRelease = packages.public.some(({ version }) => parseRcVersion(version) !== undefined);
    if (
      !exactChangesetPreState(preState) ||
      preState.mode !== "pre" ||
      preState.tag !== allowedPrereleaseTag ||
      !hasRcRelease ||
      !exactPrereleasePackageSet(packages, preState)
    ) {
      throw new Error(
        "Prerelease publication requires exact Changesets rc mode and public versions at their baseline or -rc.N.",
      );
    }
    return { action: "publish", tag: allowedPrereleaseTag };
  }
  if (packages.public.some(({ version }) => parseStableVersion(version) === undefined)) {
    throw new Error("Stable publication requires strict SemVer release versions and no prereleases.");
  }
  return { action: "publish", tag: undefined };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonIfPresent(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function portablePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function workspaceEntries(cwd, workspaceRoot) {
  try {
    return await readdir(join(cwd, workspaceRoot), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function updatePackagePayloadHash(hash, root, directory = "") {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const relativePath = join(directory, entry.name);
    const absolutePath = join(root, relativePath);
    hash.update(`${portablePath(root, absolutePath)}\0`);
    if (entry.isDirectory()) {
      hash.update("directory\0");
      await updatePackagePayloadHash(hash, root, relativePath);
    } else if (entry.isSymbolicLink()) {
      hash.update(`symlink\0${await readlink(absolutePath)}\0`);
    } else if (entry.isFile()) {
      const bytes = await readFile(absolutePath);
      hash.update(`file\0${bytes.length}\0`);
      hash.update(bytes);
    } else {
      throw new Error(`Unsupported publish payload entry ${portablePath(root, absolutePath)}.`);
    }
  }
}

async function packagePayloadDigest(root) {
  const hash = createHash("sha256");
  await updatePackagePayloadHash(hash, root);
  return hash.digest("hex");
}

function validateWorkspaceAuthority(controlFiles) {
  const workspaceBytes = controlFiles.find(({ path }) => path === "pnpm-workspace.yaml")?.bytes;
  const workspace = parseYaml(workspaceBytes);
  if (
    !isRecord(workspace) ||
    !Array.isArray(workspace.packages) ||
    workspace.packages.length !== workspacePackageGlobs.length ||
    workspace.packages.some((pattern) => typeof pattern !== "string") ||
    workspace.packages.toSorted().join(",") !== workspacePackageGlobs.toSorted().join(",")
  ) {
    throw new Error("pnpm workspace package globs must exactly match release package discovery roots.");
  }
}

export async function releasePackages(cwd) {
  const catalogByPath = new Map(PUBLISHABLE_PACKAGES.map((entry) => [entry.manifestPath, entry]));
  const publicPackages = [];
  const privatePackages = [];
  const names = new Set();
  const discoveredCatalogPaths = new Set();
  for (const workspaceRoot of workspaceRoots) {
    const absoluteRoot = join(cwd, workspaceRoot);
    const entries = await workspaceEntries(cwd, workspaceRoot);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic workspace entry ${join(workspaceRoot, entry.name)} is forbidden.`);
      }
      if (!entry.isDirectory()) {
        continue;
      }
      const manifestPath = join(absoluteRoot, entry.name, "package.json");
      const manifest = await readJsonIfPresent(manifestPath);
      if (manifest === undefined) {
        continue;
      }
      const relativeManifestPath = portablePath(cwd, manifestPath);
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
        throw new Error(`Workspace manifest ${relativeManifestPath} requires string name and version.`);
      }
      if (names.has(manifest.name)) {
        throw new Error(`Duplicate workspace package name ${manifest.name}.`);
      }
      names.add(manifest.name);
      const releasePackage = {
        manifestBytes: await readFile(manifestPath, "utf8"),
        name: manifest.name,
        registry: manifest.publishConfig?.registry,
        required: catalogByPath.get(relativeManifestPath)?.required,
        version: manifest.version,
      };
      if (manifest.private === true) {
        privatePackages.push(releasePackage);
        continue;
      }
      const catalogEntry = catalogByPath.get(relativeManifestPath);
      if (catalogEntry === undefined || catalogEntry.name !== manifest.name) {
        throw new Error(
          `Public workspace package ${manifest.name} is missing from the release-owned package catalog.`,
        );
      }
      releasePackage.required = catalogEntry.required;
      releasePackage.payloadDigest = await packagePayloadDigest(join(cwd, catalogEntry.root));
      discoveredCatalogPaths.add(relativeManifestPath);
      publicPackages.push(releasePackage);
    }
  }
  for (const catalogEntry of PUBLISHABLE_PACKAGES) {
    if (!discoveredCatalogPaths.has(catalogEntry.manifestPath)) {
      throw new Error(`Required public package ${catalogEntry.name} is missing from its catalog path.`);
    }
  }
  return {
    private: privatePackages.toSorted((left, right) => left.name.localeCompare(right.name)),
    public: publicPackages.toSorted((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function changesetInventory(cwd) {
  const root = join(cwd, ".changeset");
  const entries = await readdir(root, { withFileTypes: true });
  const pending = [];
  const unexpected = [];
  const metadata = [];
  const files = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      files.push({ name: entry.name, bytes: await readFile(join(root, entry.name), "utf8") });
      if (changesetMetadataFiles.has(entry.name) || entry.name === "README.md") {
        metadata.push(entry.name);
        continue;
      }
      if (!entry.name.startsWith(".") && entry.name.endsWith(".md")) {
        pending.push(entry.name);
      } else {
        unexpected.push(entry.name);
      }
      continue;
    }
    if (entry.isDirectory()) {
      const children = await readdir(join(root, entry.name), { withFileTypes: true });
      for (const child of children) {
        if (child.isFile()) {
          files.push({
            name: `${entry.name}/${child.name}`,
            bytes: await readFile(join(root, entry.name, child.name), "utf8"),
          });
        }
      }
      const exactLegacyV1 =
        children.length === 2 &&
        children.every((child) => child.isFile()) &&
        children.some((child) => child.name === "changes.json") &&
        children.some((child) => child.name === "changes.md");
      (exactLegacyV1 ? pending : unexpected).push(`${entry.name}/`);
      continue;
    }
    unexpected.push(entry.name);
  }
  return {
    files: files.toSorted((left, right) => left.name.localeCompare(right.name)),
    metadata: metadata.toSorted(),
    pending: pending.toSorted(),
    unexpected: unexpected.toSorted(),
  };
}

export async function registryPackageMetadata(packageInfo, fetchImplementation = fetch) {
  const registry = packageInfo.registry ?? "https://registry.npmjs.org/";
  const packageUrl = new URL(
    encodeURIComponent(packageInfo.name),
    registry.endsWith("/") ? registry : `${registry}/`,
  );
  const response = await fetchImplementation(packageUrl, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(registryTimeoutMilliseconds),
  });
  if (response.status === 404) {
    return { distTags: {}, exists: false, versions: [] };
  }
  if (!response.ok) {
    throw new Error(`Registry metadata request for ${packageInfo.name} failed with ${response.status}.`);
  }
  const metadata = await response.json();
  if (
    !isRecord(metadata) ||
    !isRecord(metadata.versions) ||
    (metadata["dist-tags"] !== undefined &&
      (!isRecord(metadata["dist-tags"]) ||
        Object.values(metadata["dist-tags"]).some((version) => typeof version !== "string")))
  ) {
    throw new Error(`Registry metadata for ${packageInfo.name} has an invalid packument shape.`);
  }
  return {
    distTags: Object.fromEntries(Object.entries(metadata["dist-tags"] ?? {}).toSorted()),
    exists: true,
    versions: Object.keys(metadata.versions).toSorted(),
  };
}

export async function registryVersionExists(packageInfo, fetchImplementation = fetch) {
  const metadata = await registryPackageMetadata(packageInfo, fetchImplementation);
  return metadata.versions.includes(packageInfo.version);
}

function parsePublishedVersion(version) {
  const stable = parseStableVersion(version);
  if (stable !== undefined) {
    return { core: stable, iteration: undefined };
  }
  return parseRcVersion(version);
}

function comparePublishedVersions(left, right) {
  const coreComparison = compareVersionCore(left.core, right.core);
  if (coreComparison !== 0) {
    return coreComparison;
  }
  if (left.iteration === undefined || right.iteration === undefined) {
    if (left.iteration === right.iteration) {
      return 0;
    }
    return left.iteration === undefined ? 1 : -1;
  }
  if (left.iteration === right.iteration) {
    return 0;
  }
  return left.iteration > right.iteration ? 1 : -1;
}

async function verifyPublishRegistryState(state) {
  const registryState = [];
  for (const packageInfo of state.packages.public) {
    const metadata = await registryPackageMetadata(packageInfo);
    registryState.push({
      distTags: metadata.distTags,
      exists: metadata.exists,
      name: packageInfo.name,
      registry: packageInfo.registry ?? "https://registry.npmjs.org/",
      versions: metadata.versions,
    });
    const targetRc = parseRcVersion(packageInfo.version);
    const targetStable = parseStableVersion(packageInfo.version);
    const target =
      targetRc ?? (targetStable === undefined ? undefined : { core: targetStable, iteration: undefined });
    if (target === undefined) {
      throw new Error(`Release ${packageInfo.name}@${packageInfo.version} has an unsupported version.`);
    }
    if (targetRc !== undefined && (!metadata.exists || metadata.versions.length === 0)) {
      throw new Error(`Prerelease for ${packageInfo.name} requires stable registry history.`);
    }
    const parsedVersions = metadata.versions.map((version) => ({
      parsed: parsePublishedVersion(version),
      version,
    }));
    if (parsedVersions.some(({ parsed }) => parsed === undefined)) {
      throw new Error(`Registry history for ${packageInfo.name} contains an unsupported version.`);
    }
    if (targetRc !== undefined && parsedVersions.every(({ parsed }) => parsed.iteration !== undefined)) {
      throw new Error(
        `Changesets cannot safely preserve the rc tag for prerelease-only package ${packageInfo.name}.`,
      );
    }
    if (
      parsedVersions.some(
        ({ parsed, version }) =>
          version !== packageInfo.version && comparePublishedVersions(target, parsed) <= 0,
      )
    ) {
      throw new Error(`Release ${packageInfo.name}@${packageInfo.version} is not registry-monotonic.`);
    }
  }
  return registryState;
}

export async function releaseState(cwd) {
  const preState = await readJsonIfPresent(join(cwd, ".changeset", "pre.json"));
  const controlFiles = await Promise.all(releaseControlPaths.map(async (path) => ({
    path, bytes: await readFile(join(cwd, path), "utf8"),
  })));
  validateWorkspaceAuthority(controlFiles);
  return {
    controlFiles,
    inventory: await changesetInventory(cwd),
    packages: await releasePackages(cwd),
    preState,
  };
}

export async function main({
  cwd = process.cwd(),
  inspectReleaseState = releaseState,
  resolvePublishInvocation = releasePublishInvocation,
  spawn = spawnSync,
  verifyRegistry = verifyPublishRegistryState,
} = {}) {
  const initialState = await inspectReleaseState(cwd);
  const decision = releasePublishDecision(initialState);
  if (decision.action === "noop") {
    for (const packageInfo of initialState.packages.public) {
      if (!(await registryVersionExists(packageInfo))) {
        throw new Error(
          `Fresh prerelease no-op requires ${packageInfo.name}@${packageInfo.version} to exist in its registry.`,
        );
      }
    }
    const verifiedState = await inspectReleaseState(cwd);
    if (JSON.stringify(verifiedState) !== JSON.stringify(initialState)) {
      throw new Error("Release filesystem state changed while prerelease no-op was being verified.");
    }
    process.stdout.write("Fresh Changesets prerelease state has no releases; publish skipped.\n");
    return;
  }
  const initialRegistryState = await verifyRegistry(initialState);
  const verifiedState = await inspectReleaseState(cwd);
  if (JSON.stringify(verifiedState) !== JSON.stringify(initialState)) {
    throw new Error("Release filesystem state changed before the publish command was started.");
  }
  const verifiedRegistryState = await verifyRegistry(verifiedState);
  if (JSON.stringify(verifiedRegistryState) !== JSON.stringify(initialRegistryState)) {
    throw new Error("Release registry state changed before the publish command was started.");
  }
  const finalState = await inspectReleaseState(cwd);
  if (JSON.stringify(finalState) !== JSON.stringify(initialState)) {
    throw new Error("Release filesystem state changed during final registry verification.");
  }
  const invocation = resolvePublishInvocation();
  const result = spawn(invocation.command, invocation.args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await main();
}
