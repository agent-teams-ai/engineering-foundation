import { lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { assertSecretCanaryAbsent } from "./pack-test-support.mjs";
import {
  assertArchiveSafety, inspectCompressedTarArchive, portableEntryIdentity, readRegularArchive, sha256,
} from "./pack-artifact-archive.mjs";
import { boundedDirectoryEntries, canonicalPublishManifest, containsPhysicalPath, generatedPackageEntries, materializeStableTree, npmPackManifest, pathExists, publishDependencyIdentity, readBoundedStableJson, readStableRegularFile, wireStagedPackageDependencies } from "./pack-artifact-stage-support.mjs";
export {
  assertArchiveListing, assertArchiveSafety, assertNoSpecialTarEntries, inspectCompressedTarArchive, readVerifiedArchive,
} from "./pack-artifact-archive.mjs";

const verifiedArchiveBytes = new WeakMap();

function hasAuthoritativeFileIdentity(metadata) {
  return (typeof metadata.dev === "bigint" ? metadata.dev > 0n : Number.isSafeInteger(metadata.dev) && metadata.dev > 0) &&
    (typeof metadata.ino === "bigint" ? metadata.ino > 0n : Number.isSafeInteger(metadata.ino) && metadata.ino > 0);
}

export function sameAuthoritativeFileIdentity(first, second) {
  return hasAuthoritativeFileIdentity(first) && hasAuthoritativeFileIdentity(second) &&
    first.dev === second.dev && first.ino === second.ino;
}

function describeArchiveDifference(firstBytes, secondBytes) {
  let firstEntries;
  let secondEntries;
  try {
    firstEntries = inspectCompressedTarArchive(firstBytes).entries;
    secondEntries = inspectCompressedTarArchive(secondBytes).entries;
  } catch (error) {
    return `archive structure inspection failed: ${error instanceof Error ? error.message : "unknown error"}`;
  }
  if (firstEntries.length !== secondEntries.length) {
    return `entry counts differ (${firstEntries.length} != ${secondEntries.length})`;
  }
  for (let index = 0; index < firstEntries.length; index += 1) {
    const first = firstEntries[index];
    const second = secondEntries[index];
    if (first.name !== second.name || first.type !== second.type || first.size !== second.size) {
      return `entry ${index} metadata differs (${first.name}:${first.type}:${first.size} != ${second.name}:${second.type}:${second.size})`;
    }
    const firstDigest = sha256(first.data);
    const secondDigest = sha256(second.data);
    if (firstDigest !== secondDigest) {
      return `entry ${first.name} content differs (${firstDigest} != ${secondDigest})`;
    }
  }
  return "payload entries match; tar headers or gzip metadata differ";
}

function workspaceCatalogVersions(bytes) {
  const versions = new Map();
  let inCatalog = false;
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    if (/^catalog:\s*$/u.test(line)) { inCatalog = true; continue; }
    if (inCatalog && /^\S/u.test(line)) {
      break;
    }
    if (!inCatalog) {
      continue;
    }
    const match = /^  (["']?)([^"':]+|@[^"']+)\1:\s*([0-9][0-9A-Za-z.-]*)\s*$/u.exec(line);
    if (match !== null) {
      versions.set(match[2], match[3]);
    }
  }
  return versions;
}

function releaseManifestIdentity(manifest) {
  const identity = {};
  for (const key of ["name", "version", "type", "bin", "exports", "files", "scripts"]) {
    if (Object.hasOwn(manifest, key)) {
      identity[key] = manifest[key];
    }
  }
  return JSON.stringify(identity);
}

function packageSourceRoot(entry, repositoryRoot) {
  return entry.sourceRoot ?? join(repositoryRoot, entry.root);
}

async function expectedPackedEntries(packageRoot, manifest, requiredArtifactPaths) {
  const entries = new Set(["package/package.json", "package/LICENSE", "package/README.md"]);
  const fileDigests = new Map();
  const state = { bytes: 0, entries: 0 };
  async function visit(absolute, relativePath) {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
      throw new Error(`Packed payload authority contains a special file: ${relativePath}.`);
    }
    portableEntryIdentity(`package/${relativePath}${metadata.isDirectory() ? "/" : ""}`);
    if (metadata.isFile()) {
      const { bytes } = await readStableRegularFile(absolute, state, "Packed payload authority");
      entries.add(`package/${relativePath}`);
      if (relativePath !== "package.json") {
        fileDigests.set(`package/${relativePath}`, sha256(bytes));
      }
      return;
    }
    for (const entry of await boundedDirectoryEntries(absolute, "Packed payload authority", state)) {
      await visit(join(absolute, entry.name), `${relativePath}/${entry.name}`);
    }
  }
  if (Array.isArray(manifest.files)) {
    for (const path of manifest.files) {
      await visit(join(packageRoot, path), path);
    }
  } else {
    for (const path of requiredArtifactPaths ?? []) {
      entries.add(`package/${path}`);
    }
  }
  for (const path of ["LICENSE", "README.md"]) {
    if (!fileDigests.has(`package/${path}`) && await pathExists(join(packageRoot, path))) {
      await visit(join(packageRoot, path), path);
    }
  }
  return Object.freeze({ entries: Object.freeze([...entries].toSorted()), fileDigests });
}

export async function createCleanBuildStage(input, label) {
  if (!Array.isArray(input.stagePackages) || input.stagePackages.length === 0) {
    throw new Error("Clean package staging requires a manifest-derived stagePackages closure.");
  }
  await mkdir(input.temporaryRoot, { recursive: true });
  const stageRoot = await mkdtemp(join(input.temporaryRoot, `clean-build-${input.artifactLabel ?? "package"}-${label}-`));
  const stagedPackagesByName = new Map(input.stagePackages.map((entry) => [entry.name, join(stageRoot, entry.root)]));
  const dependencyDeclarations = input.dependencyDeclarations ?? {};
  const internalPackageNames = new Set([...Object.keys(dependencyDeclarations), ...stagedPackagesByName.keys()]);
  const physicalInternalRoots = [];
  for (const root of input.authoritativePackageRoots ?? input.stagePackages.map((entry) => entry.sourceRoot)) {
    if (typeof root === "string") {
      physicalInternalRoots.push(await realpath(root));
    }
  }
  const manifestsByName = new Map();
  const workspace = await readStableRegularFile(
    join(input.repositoryRoot, "pnpm-workspace.yaml"), { bytes: 0 }, "Workspace manifest",
  );
  const catalogVersions = workspaceCatalogVersions(workspace.bytes);
  for (const entry of input.stagePackages) {
    const sourceRoot = packageSourceRoot(entry, input.repositoryRoot);
    const sourceManifest = await readBoundedStableJson(join(sourceRoot, "package.json"), "Authoritative package manifest");
    if (sourceManifest.name !== entry.name || (entry.version !== undefined && sourceManifest.version !== entry.version)) {
      throw new Error(`Authoritative package manifest identity changed for ${entry.name}.`);
    }
    manifestsByName.set(entry.name, sourceManifest);
    const stagedRoot = stagedPackagesByName.get(entry.name);
    await mkdir(dirname(stagedRoot), { recursive: true });
    await materializeStableTree(sourceRoot, stagedRoot, {
      allowLinks: false,
      excludedEntries: generatedPackageEntries,
      label: "Package source tree",
      state: { bytes: 0, entries: 0 },
    });
    const stagedManifest = await readBoundedStableJson(join(stagedRoot, "package.json"), "Staged package manifest");
    if (releaseManifestIdentity(stagedManifest) !== releaseManifestIdentity(sourceManifest)) {
      throw new Error(`Authoritative package manifest changed while staging ${entry.name}.`);
    }
    const license = await readStableRegularFile(
      join(input.repositoryRoot, "LICENSE"), { bytes: 0 }, "Repository license",
    );
    await writeFile(join(stagedRoot, "LICENSE"), license.bytes, { mode: license.mode });
  }
  for (const entry of input.stagePackages) {
    await wireStagedPackageDependencies({
      dependencyDeclarations,
      catalogVersions,
      internalPackageNames,
      manifest: manifestsByName.get(entry.name),
      packageName: entry.name,
      physicalInternalRoots,
      sourceRoot: entry.sourceRoot ?? join(input.repositoryRoot, entry.root),
      stagedPackagesByName,
      stagedRoot: stagedPackagesByName.get(entry.name),
    });
  }
  const packageRoot = stagedPackagesByName.get(input.packageName);
  if (packageRoot === undefined) {
    throw new Error(`Clean stage has no target package ${input.packageName}.`);
  }
  await writeFile(join(stageRoot, "pnpm-workspace.yaml"), workspace.bytes, { flag: "wx", mode: workspace.mode });
  for (const packageName of input.buildPackageNames ?? [input.packageName]) {
    const buildRoot = stagedPackagesByName.get(packageName);
    if (buildRoot === undefined) {
      throw new Error(`Clean stage build order names unstaged package ${packageName}.`);
    }
    await input.runBuild(buildRoot, Object.freeze({ packageName, stageRoot, stagedPackagesByName }));
  }
  const sourceManifest = manifestsByName.get(input.packageName);
  const packedManifest = await readBoundedStableJson(join(packageRoot, "package.json"), "Post-build package manifest");
  if (releaseManifestIdentity(packedManifest) !== releaseManifestIdentity(sourceManifest)) {
    throw new Error(`Package build changed release manifest identity for ${input.packageName}.`);
  }
  const publishManifest = canonicalPublishManifest(sourceManifest, {
    catalogVersions,
    internalPackageVersions: new Map([...manifestsByName].map(([name, manifest]) => [name, manifest.version])),
  });
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify(npmPackManifest(publishManifest), null, 2)}\n`);
  const expectedEntries = await expectedPackedEntries(packageRoot, sourceManifest, input.requiredArtifactPaths);
  return Object.freeze({ expectedEntries, packageRoot, publishManifest, sourceManifest, stageRoot });
}

async function createArtifact(input, stage) {
  const destination = join(stage.stageRoot, "pack");
  await mkdir(destination, { recursive: true });
  await input.runPnpm(["pack", "--pack-destination", destination], stage.packageRoot, {
    environment: {
      ...process.env,
      pnpm_config_ignore_pnpmfile: "true",
      pnpm_config_ignore_scripts: "true",
    },
  });
  const state = { entries: 0 };
  const archives = (await boundedDirectoryEntries(destination, "Pack destination", state))
    .map(({ name }) => name).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`pnpm pack produced ${archives.length} tarballs; expected exactly one.`);
  }
  return { archiveName: archives[0], archivePath: join(destination, archives[0]) };
}

function expectedArchiveName({ name, version }) {
  return `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
}

function parsedArchiveListings(inspection) {
  const listing = inspection.entries
    .filter(({ type }) => type !== "x" && type !== "g")
    .map(({ name, type }) => type === "5" && !name.endsWith("/") ? `${name}/` : name)
    .join("\n");
  const verboseListing = inspection.entries
    .filter(({ type }) => type !== "x" && type !== "g")
    .map(({ name, type }) => `${type === "5" ? "d" : type === "0" ? "-" : type}--------- ${name}`)
    .join("\n");
  return { listing, verboseListing };
}

function assertExactArchiveManifest(inspection, expectedManifest) {
  const manifests = inspection.entries.filter(({ name, type }) => name === "package/package.json" && type === "0");
  if (manifests.length !== 1) {
    throw new Error("Package tar must contain exactly one regular package/package.json.");
  }
  let manifest;
  try { manifest = JSON.parse(manifests[0].data.toString("utf8")); } catch (error) {
    throw new Error(`Packed package manifest is not valid JSON: ${error.message}`, { cause: error });
  }
  if (releaseManifestIdentity(manifest) !== releaseManifestIdentity(expectedManifest)) {
    throw new Error(
      `Packed package manifest identity does not match ${expectedManifest.name}@${expectedManifest.version}.`,
    );
  }
  const packedPublishManifest = canonicalPublishManifest(manifest, {
    catalogVersions: new Map(), internalPackageVersions: new Map(),
  });
  if (publishDependencyIdentity(packedPublishManifest) !== publishDependencyIdentity(expectedManifest)) {
    throw new Error("Packed package dependency manifest differs from the sealed publish authority.");
  }
}

function assertExactPackedEntries(inspection, listing, expected) {
  const actual = listing.split(/\r?\n/u).filter(Boolean).toSorted();
  if (actual.join("\0") !== expected.entries.join("\0")) {
    throw new Error("Packed archive payload differs from the post-build manifest-owned package tree.");
  }
  const files = new Map(inspection.entries.filter(({ type }) => type === "0").map(({ data, name }) => [name, data]));
  for (const [name, digest] of expected.fileDigests) {
    if (files.get(name) === undefined || sha256(files.get(name)) !== digest) {
      throw new Error(`Packed archive content differs from its proved post-build file: ${name}.`);
    }
  }
}

async function extractVerifiedArchive(inspection, extractedRoot) {
  await mkdir(extractedRoot, { recursive: false });
  for (const { data, name, type } of inspection.entries) {
    if (type === "x" || type === "g") {
      continue;
    }
    const destination = join(extractedRoot, ...name.split("/"));
    if (!containsPhysicalPath(extractedRoot, destination)) {
      throw new Error(`Unsafe extraction path: ${name}.`);
    }
    if (type === "5") {
      await mkdir(destination, { recursive: true });
    } else if (type === "0") {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, data, { flag: "wx" });
    } else {
      throw new Error(`Package contains a prohibited special tar entry type: ${type}.`);
    }
  }
}

export async function packAndInspectArtifact(input) {
  const firstStage = await createCleanBuildStage(input, "a");
  const secondStage = await createCleanBuildStage(input, "b");
  if (releaseManifestIdentity(firstStage.sourceManifest) !== releaseManifestIdentity(secondStage.sourceManifest)) {
    throw new Error("Authoritative package manifest changed between clean builds.");
  }
  const first = await createArtifact(input, firstStage);
  const second = await createArtifact(input, secondStage);
  const authoritativeArchiveName = expectedArchiveName(firstStage.sourceManifest);
  if (first.archiveName !== authoritativeArchiveName || second.archiveName !== authoritativeArchiveName) {
    throw new Error(`pnpm pack archive identity must be exactly ${authoritativeArchiveName}.`);
  }
  const [firstPhysicalPath, secondPhysicalPath] = await Promise.all([
    realpath(first.archivePath), realpath(second.archivePath),
  ]);
  const [firstStat, secondStat] = await Promise.all([lstat(first.archivePath), lstat(second.archivePath)]);
  if (firstPhysicalPath === secondPhysicalPath || sameAuthoritativeFileIdentity(firstStat, secondStat)) {
    throw new Error("Two clean package builds must produce distinct archive files.");
  }
  const [firstBytes, secondBytes] = await Promise.all([
    readRegularArchive(first.archivePath), readRegularArchive(second.archivePath),
  ]);
  if (sha256(firstBytes) !== sha256(secondBytes)) {
    throw new Error(
      `Two clean package builds did not produce byte-identical tarballs for ${input.packageName}: ` +
      `${sha256(firstBytes)} != ${sha256(secondBytes)}; ${describeArchiveDifference(firstBytes, secondBytes)}.`,
    );
  }
  const inspection = inspectCompressedTarArchive(firstBytes);
  assertExactArchiveManifest(inspection, firstStage.publishManifest);
  const { listing, verboseListing } = parsedArchiveListings(inspection);
  assertArchiveSafety({
    allowedArtifactPaths: input.allowedArtifactPaths,
    archiveBytes: firstBytes,
    listing,
    requiredArtifactPaths: input.requiredArtifactPaths,
    verboseListing,
  });
  assertExactPackedEntries(inspection, listing, firstStage.expectedEntries);
  const extractedRoot = await mkdtemp(join(input.temporaryRoot, `extracted-${input.artifactLabel ?? "package"}-`));
  const packageExtractionRoot = join(extractedRoot, "payload");
  await extractVerifiedArchive(inspection, packageExtractionRoot);
  await assertSecretCanaryAbsent(extractedRoot);
  const verifiedRoot = await mkdtemp(join(input.temporaryRoot, `verified-${input.artifactLabel ?? "package"}-`));
  const verifiedArchivePath = join(verifiedRoot, first.archiveName);
  await writeFile(verifiedArchivePath, firstBytes, { flag: "wx", mode: 0o444 });
  const artifact = Object.freeze({
    archiveFileSpecifier: `file:${verifiedArchivePath.replaceAll("\\", "/")}`,
    archiveName: first.archiveName,
    archivePath: verifiedArchivePath,
    sha256: sha256(firstBytes),
  });
  verifiedArchiveBytes.set(artifact, Buffer.from(firstBytes));
  return artifact;
}

export function snapshotVerifiedArtifact(artifact) {
  const bytes = verifiedArchiveBytes.get(artifact);
  if (bytes === undefined || sha256(bytes) !== artifact.sha256) {
    throw new Error("Artifact is not bound to an in-process verified archive snapshot.");
  }
  return Buffer.from(bytes);
}
