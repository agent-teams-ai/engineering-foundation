import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat, mkdir, mkdtemp, open, opendir, realpath, symlink, writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import { assertSecretCanaryAbsent } from "./pack-test-support.mjs";

const forbiddenEntries = [
  "/.git/", "/node_modules/", "/src/", "/tests/", ".env", "auth.json",
  "foundation-link.json", "/secret-fixtures/",
];
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_500;
const MAX_MEMBER_BYTES = 16 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_TAR_BYTES = MAX_UNCOMPRESSED_BYTES + (MAX_ARCHIVE_ENTRIES + 2) * 1024;
const MAX_STAGE_ENTRIES = 10_000;
const MAX_STAGE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const generatedPackageEntries = new Set(["dist", "node_modules", "tsconfig.tsbuildinfo"]);
const verifiedArchiveBytes = new WeakMap();

function portableSegmentIdentity(segment) {
  return segment.normalize("NFKC").toUpperCase();
}

function portableEntryIdentity(entry) {
  if (entry.includes("\\") || entry.startsWith("/") || /^[A-Za-z]:\//u.test(entry) || isAbsolute(entry)) {
    throw new Error(`Package contains an unsafe archive member: ${entry}`);
  }
  const rawSegments = entry.endsWith("/") ? entry.slice(0, -1).split("/") : entry.split("/");
  if (rawSegments.some((segment) => segment === "" || segment === "." || segment === ".." ||
      /[\0-\x1f\x7f<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment))) {
    throw new Error(`Package contains an unsafe archive member: ${entry}`);
  }
  const directory = entry.endsWith("/");
  const normalized = normalize(entry).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized === ".." || normalized.startsWith("../") || normalized === "." || normalized === "") {
    throw new Error(`Package contains an unsafe archive member: ${entry}`);
  }
  const identity = directory ? normalized.replace(/\/$/u, "") : normalized;
  const segments = identity.split("/");
  for (const segment of segments) {
    const portableSegment = portableSegmentIdentity(segment);
    const deviceStem = portableSegment.split(".")[0].replace(/[. ]+$/u, "");
    if (portableSegment === "" || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceStem)) {
      throw new Error(`Package contains a non-portable archive member: ${entry}`);
    }
  }
  return segments.map(portableSegmentIdentity).join("/");
}

function archiveEntries(listing) {
  const entries = listing.split(/\r?\n/u).filter(Boolean);
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`Package contains too many entries: ${entries.length}.`);
  }
  const identities = new Map();
  for (const entry of entries) {
    const identity = portableEntryIdentity(entry);
    const previous = identities.get(identity);
    if (previous !== undefined) {
      throw new Error(`Package contains duplicate or normalized-colliding archive members: ${previous}, ${entry}`);
    }
    identities.set(identity, entry);
  }
  return entries;
}

export function assertArchiveListing(listing, requiredArtifactPaths, allowedArtifactPaths = requiredArtifactPaths) {
  for (const forbidden of forbiddenEntries) {
    if (listing.includes(forbidden)) throw new Error(`Forbidden package entry detected: ${forbidden}`);
  }
  const entries = archiveEntries(listing);
  const entrySet = new Set(entries);
  const requiredEntries = [
    "package/package.json", "package/LICENSE", "package/README.md",
    ...requiredArtifactPaths.map((path) => `package/${path}`),
  ];
  for (const required of requiredEntries) {
    if (!entrySet.has(required)) throw new Error(`Required package entry missing: ${required}`);
  }
  const requiredDirectories = new Set(["package/"]);
  for (const required of requiredEntries) {
    let boundary = required.lastIndexOf("/");
    while (boundary >= "package".length) {
      requiredDirectories.add(`${required.slice(0, boundary)}/`);
      boundary = required.lastIndexOf("/", boundary - 1);
    }
  }
  for (const entry of entries) {
    const packagePath = entry.startsWith("package/") ? entry.slice("package/".length).replace(/\/$/u, "") : "";
    const manifestAllows = allowedArtifactPaths.some((allowed) =>
      packagePath === allowed || packagePath.startsWith(`${allowed.replace(/\/$/u, "")}/`));
    if (!requiredDirectories.has(entry) && !entry.startsWith("package/dist/") &&
        !requiredEntries.includes(entry) && !manifestAllows) {
      throw new Error(`Package entry is outside the release allowlist: ${entry}`);
    }
  }
}

function parseTarNumber(field, label) {
  if ((field[0] & 0x80) !== 0) throw new Error(`Package tar uses unsupported base-256 ${label}.`);
  const text = field.toString("ascii").replace(/\0.*$/u, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/u.test(text)) throw new Error(`Package tar has malformed ${label}.`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`Package tar ${label} is not safely bounded.`);
  return value;
}

function verifyTarChecksum(header) {
  const expected = parseTarNumber(header.subarray(148, 156), "header checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) throw new Error("Package tar has an invalid header checksum.");
}

export function inspectCompressedTarArchive(archiveBytes) {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Package archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`);
  }
  let tar;
  try {
    tar = gunzipSync(archiveBytes, { maxOutputLength: MAX_TAR_BYTES });
  } catch (error) {
    throw new Error(`Package archive cannot be decompressed within its safety bound: ${error.message}`, { cause: error });
  }
  let aggregateBytes = 0;
  let entryCount = 0;
  let offset = 0;
  const entries = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > tar.length || !tar.subarray(offset, offset + 1024).every((byte) => byte === 0) ||
          !tar.subarray(offset + 1024).every((byte) => byte === 0)) {
        throw new Error("Package tar lacks a valid two-zero-block terminator or has hidden trailing data.");
      }
      offset = tar.length;
      break;
    }
    verifyTarChecksum(header);
    const size = parseTarNumber(header.subarray(124, 136), "member size");
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    let name;
    try {
      const field = (bytes) => decoder.decode(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)));
      const leaf = field(header.subarray(0, 100));
      const prefix = field(header.subarray(345, 500));
      name = prefix === "" ? leaf : `${prefix}/${leaf}`;
    } catch (error) {
      throw new Error(`Package tar has a malformed UTF-8 member name: ${error.message}`, { cause: error });
    }
    portableEntryIdentity(name);
    if (type === "S") throw new Error("Package tar contains a prohibited GNU sparse logical file.");
    if (size > MAX_MEMBER_BYTES) {
      throw new Error(`Package tar member exceeds ${MAX_MEMBER_BYTES} bytes.`);
    }
    aggregateBytes += size;
    if (aggregateBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`Package tar members exceed ${MAX_UNCOMPRESSED_BYTES} aggregate bytes.`);
    }
    entryCount += 1;
    if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error(`Package contains too many entries: ${entryCount}.`);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > tar.length) throw new Error("Package tar member extends beyond the archive.");
    const data = tar.subarray(offset + 512, offset + 512 + size);
    if ((type === "x" || type === "g") && /(?:GNU\.sparse\.|SCHILY\.realsize)/u.test(data.toString("utf8"))) {
      throw new Error("Package tar contains prohibited PAX sparse logical-file metadata.");
    }
    if (type === "x" || type === "g") {
      throw new Error("Package tar contains unsupported PAX extended metadata.");
    }
    entries.push(Object.freeze({ data, name, size, type }));
    offset = next;
  }
  if (offset !== tar.length) throw new Error("Package tar is truncated or lacks a two-zero-block terminator.");
  const result = { aggregateBytes, entryCount, uncompressedBytes: tar.length };
  Object.defineProperty(result, "entries", { value: Object.freeze(entries) });
  return Object.freeze(result);
}

async function readRegularArchive(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`Package archive is not a bounded regular file: ${path}.`);
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`Package archive changed before verification: ${path}.`);
    }
    const bytes = Buffer.alloc(opened.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const overflow = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await handle.read(overflow, 0, 1, bytes.length);
    const after = await handle.stat();
    if (bytesRead !== bytes.length || overflowBytes !== 0 || !sameFileState(opened, after)) {
      throw new Error(`Package archive changed during verification: ${path}.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export async function readVerifiedArchive(path, expectedSha256) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error(`Verified package archive was replaced by a symlink: ${path}.`);
  const bytes = await readRegularArchive(path);
  if (sha256(bytes) !== expectedSha256) throw new Error(`Verified package archive digest changed: ${path}.`);
  return bytes;
}

export function assertNoSpecialTarEntries(verboseListing) {
  for (const line of verboseListing.split(/\r?\n/u).filter(Boolean)) {
    const type = line[0];
    if (type !== "-" && type !== "d") {
      throw new Error(`Package contains a prohibited special tar entry: ${line}`);
    }
  }
}

export function assertArchiveSafety({ allowedArtifactPaths, archiveBytes, listing, requiredArtifactPaths, verboseListing }) {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Package archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`);
  }
  assertArchiveListing(listing, requiredArtifactPaths, allowedArtifactPaths);
  assertNoSpecialTarEntries(verboseListing);
}

async function pathExists(path) {
  try { await lstat(path); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sameFileState(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readStableRegularFile(path, state, label, expected, maximumBytes = MAX_MEMBER_BYTES) {
  const pathnameBefore = await lstat(path);
  const physical = await realpath(path);
  const before = await lstat(physical);
  if (expected !== undefined && (expected.physical !== physical ||
      !sameFileState(expected.pathname, pathnameBefore) || !sameFileState(expected.metadata, before))) {
    throw new Error(`${label} changed before its proved identity was read: ${path}.`);
  }
  if (!before.isFile() || before.size > maximumBytes || state.bytes + before.size > MAX_STAGE_BYTES) {
    throw new Error(`${label} contains a non-regular or oversized file: ${path}.`);
  }
  const handle = await open(physical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!sameFileState(before, opened)) throw new Error(`${label} changed before staging: ${path}.`);
    const bytes = Buffer.alloc(opened.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const overflow = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await handle.read(overflow, 0, 1, bytes.length);
    const after = await handle.stat();
    const pathnameAfter = await lstat(path);
    if (bytesRead !== bytes.length || overflowBytes !== 0 || !sameFileState(opened, after) ||
        !sameFileState(pathnameBefore, pathnameAfter) || await realpath(path) !== physical) {
      throw new Error(`${label} changed during staging: ${path}.`);
    }
    state.bytes += bytes.length;
    if (state.bytes > MAX_STAGE_BYTES) throw new Error(`${label} exceeds its bounded byte limit.`);
    return { bytes, mode: opened.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function readBoundedStableJson(path, label) {
  const state = { bytes: 0 };
  const result = await readStableRegularFile(path, state, label, undefined, MAX_MANIFEST_BYTES);
  try { return JSON.parse(result.bytes.toString("utf8")); } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
}

async function boundedDirectoryEntries(path, label, state) {
  const entries = [];
  const directory = await opendir(path);
  try {
    for await (const entry of directory) {
      state.entries += 1;
      if (state.entries > MAX_STAGE_ENTRIES) throw new Error(`${label} exceeds its bounded entry limit.`);
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => {});
  }
  return entries;
}

async function materializeStableTree(sourceRoot, stagedRoot, { allowLinks, excludedEntries, label, state, validatePhysical }) {
  async function visit(source, destination, depth, countSelf = true) {
    if (depth > 64) throw new Error(`${label} exceeds its bounded traversal depth.`);
    const pathnameBefore = await lstat(source);
    if (pathnameBefore.isSymbolicLink() && !allowLinks) {
      throw new Error(`${label} contains a symlink: ${source}.`);
    }
    const physical = await realpath(source);
    const metadataBefore = await lstat(physical);
    await validatePhysical?.(physical, source, metadataBefore);
    if (countSelf) state.entries += 1;
    if (state.entries > MAX_STAGE_ENTRIES) throw new Error(`${label} exceeds its bounded entry limit.`);
    if (metadataBefore.isFile()) {
      const { bytes, mode } = await readStableRegularFile(source, state, label, {
        metadata: metadataBefore, pathname: pathnameBefore, physical,
      });
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: "wx", mode });
      return;
    }
    if (!metadataBefore.isDirectory()) throw new Error(`${label} contains a special file: ${source}.`);
    await mkdir(destination, { mode: metadataBefore.mode & 0o777, recursive: false });
    const entries = await boundedDirectoryEntries(physical, label, state);
    for (const entry of entries) {
      if (excludedEntries.has(entry.name)) continue;
      await visit(join(source, entry.name), join(destination, entry.name), depth + 1, false);
    }
    const [pathnameAfter, metadataAfter, physicalAfter] = await Promise.all([
      lstat(source), lstat(physical), realpath(source),
    ]);
    if (!sameFileState(pathnameBefore, pathnameAfter) || !sameFileState(metadataBefore, metadataAfter) ||
        physicalAfter !== physical) {
      throw new Error(`${label} changed during staging: ${source}.`);
    }
  }
  await visit(sourceRoot, stagedRoot, 0);
}

function containsPhysicalPath(parent, candidate) {
  const remainder = relative(parent, candidate);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function isInternalSourcePath(internalRoot, candidate) {
  if (!containsPhysicalPath(internalRoot, candidate)) return false;
  const remainder = relative(internalRoot, candidate);
  return remainder === "" || remainder.split(sep)[0] !== "node_modules";
}

async function assertNoInternalResolutionFromAncestors(physicalRoot, internalPackageNames) {
  let current = physicalRoot;
  let installationBoundarySeen = false;
  while (true) {
    const candidateNodeModules = join(current, "node_modules");
    for (const packageName of internalPackageNames) {
      const candidate = join(candidateNodeModules, ...packageName.split("/"));
      if (await pathExists(candidate)) {
        throw new Error(
          `External dependency tree can resolve internal source-workspace package ${packageName} through ${candidate}.`,
        );
      }
    }
    if (installationBoundarySeen) break;
    if (current.endsWith(`${sep}node_modules`)) installationBoundarySeen = true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function dependencyRequests(manifest, sections) {
  const requests = new Map();
  for (const section of sections) {
    const declarations = manifest[section];
    if (declarations !== undefined && (declarations === null || typeof declarations !== "object" || Array.isArray(declarations))) {
      throw new Error(`Package manifest has malformed ${section}.`);
    }
    for (const [name, specifier] of Object.entries(declarations ?? {})) {
      if (typeof specifier !== "string" || specifier === "") {
        throw new Error(`Package manifest has malformed ${section} request for ${name}.`);
      }
      if (!requests.has(name)) requests.set(name, specifier);
    }
  }
  return requests;
}

function runtimeDependencyRequests(manifest) {
  return dependencyRequests(manifest, ["dependencies", "optionalDependencies"]);
}

function buildDependencyRequests(manifest) {
  return dependencyRequests(manifest, ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]);
}

async function resolveInstalledPackage(sourceRoot, packageName) {
  let current = sourceRoot;
  let installationBoundarySeen = false;
  while (true) {
    const candidate = join(current, "node_modules", ...packageName.split("/"));
    if (await pathExists(candidate)) return candidate;
    if (installationBoundarySeen) return undefined;
    if (current.endsWith(`${sep}node_modules`)) installationBoundarySeen = true;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""];
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  if (left[3] === right[3]) return 0;
  if (left[3] === "") return 1;
  if (right[3] === "") return -1;
  return left[3] < right[3] ? -1 : 1;
}

function acceptsVersion(version, requested) {
  const actual = parseVersion(version);
  if (actual === undefined) return false;
  const alternatives = requested.split("||").map((part) => part.trim());
  return alternatives.some((alternative) => {
    if (alternative === "*" || alternative === "latest") return true;
    const exact = parseVersion(alternative);
    if (exact !== undefined) return compareVersion(actual, exact) === 0;
    const shorthand = /^(\^|~)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(alternative);
    if (shorthand !== null) {
      const lower = parseVersion(shorthand[2]);
      const upper = shorthand[1] === "~" ? [lower[0], lower[1] + 1, 0, ""] :
        lower[0] > 0 ? [lower[0] + 1, 0, 0, ""] :
          lower[1] > 0 ? [0, lower[1] + 1, 0, ""] : [0, 0, lower[2] + 1, ""];
      return compareVersion(actual, lower) >= 0 && compareVersion(actual, upper) < 0;
    }
    const comparators = alternative.split(/\s+/u).filter(Boolean);
    return comparators.length > 0 && comparators.every((comparator) => {
      const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(comparator);
      if (match === null) return false;
      const difference = compareVersion(actual, parseVersion(match[2]));
      return match[1] === ">=" ? difference >= 0 : match[1] === "<=" ? difference <= 0 :
        match[1] === ">" ? difference > 0 : match[1] === "<" ? difference < 0 : difference === 0;
    });
  });
}

function requestedVersion(specifier, packageName, catalogVersions) {
  if (specifier === "catalog:") {
    const version = catalogVersions.get(packageName);
    if (version === undefined) throw new Error(`Workspace catalog has no exact version for ${packageName}.`);
    return version;
  }
  return specifier;
}

async function materializeExternalPackage(source, destination, context) {
  const physical = await realpath(source);
  if (context.physicalInternalRoots.some((internalRoot) => isInternalSourcePath(internalRoot, physical))) {
    throw new Error(`External dependency tree reaches an internal source-workspace package: ${source}.`);
  }
  await assertNoInternalResolutionFromAncestors(physical, context.internalPackageNames);
  await materializeStableTree(source, destination, {
    allowLinks: true,
    excludedEntries: new Set(["node_modules"]),
    label: "External dependency tree",
    state: context.state,
    validatePhysical: async (candidate, sourcePath, metadata) => {
      if (context.physicalInternalRoots.some((internalRoot) => isInternalSourcePath(internalRoot, candidate))) {
        throw new Error(`External dependency tree reaches an internal source-workspace package: ${sourcePath}.`);
      }
      if (metadata.isDirectory()) await assertNoInternalResolutionFromAncestors(candidate, context.internalPackageNames);
    },
  });
  const sourceManifest = await readBoundedStableJson(join(destination, "package.json"), "External dependency manifest");
  if (sourceManifest.name !== context.requestedName ||
      typeof sourceManifest.version !== "string" || !acceptsVersion(sourceManifest.version, context.requestedVersion)) {
    throw new Error(
      `External dependency ${context.requestedName}@${sourceManifest.version ?? "unknown"} does not satisfy exact request ${context.requestedVersion}.`,
    );
  }
  if (context.internalPackageNames.has(sourceManifest.name)) {
    throw new Error(`External dependency tree carries internal package ${sourceManifest.name}.`);
  }
  const identity = process.platform === "win32" ? physical.toLowerCase() : physical;
  if (context.ancestors.has(identity)) throw new Error(`External dependency cycle includes ${sourceManifest.name}.`);
  const ancestors = new Set(context.ancestors).add(identity);
  for (const [dependencyName, dependencySpecifier] of [...runtimeDependencyRequests(sourceManifest)].toSorted()) {
    if (context.internalPackageNames.has(dependencyName)) {
      throw new Error(`External dependency tree carries internal package ${dependencyName}.`);
    }
    const dependencySource = await resolveInstalledPackage(physical, dependencyName);
    if (dependencySource === undefined) {
      // Optional and peer dependencies may legitimately be absent from the cache.
      if (Object.hasOwn(sourceManifest.dependencies ?? {}, dependencyName)) {
        throw new Error(`External dependency ${sourceManifest.name} cannot resolve declared package ${dependencyName}.`);
      }
      continue;
    }
    const dependencyDestination = join(destination, "node_modules", ...dependencyName.split("/"));
    await mkdir(dirname(dependencyDestination), { recursive: true });
    await materializeExternalPackage(dependencySource, dependencyDestination, {
      ...context,
      ancestors,
      requestedName: dependencyName,
      requestedVersion: requestedVersion(dependencySpecifier, dependencyName, context.catalogVersions),
    });
  }
}

async function materializeDeclaredExternalNodeModules(
  sourceRoot, stagedRoot, manifest, internalPackageNames, physicalInternalRoots, catalogVersions,
) {
  const sourceNodeModules = join(sourceRoot, "node_modules");
  const stagedNodeModules = join(stagedRoot, "node_modules");
  await mkdir(stagedNodeModules, { recursive: true });
  if (!(await pathExists(sourceNodeModules))) return;
  const state = { bytes: 0, entries: 0 };
  for (const [packageName, specifier] of [...buildDependencyRequests(manifest)].toSorted()) {
    if (internalPackageNames.has(packageName)) continue;
    const source = join(sourceNodeModules, ...packageName.split("/"));
    if (!(await pathExists(source))) {
      if (Object.hasOwn(manifest.dependencies ?? {}, packageName) ||
          Object.hasOwn(manifest.devDependencies ?? {}, packageName)) {
        throw new Error(`Clean stage cannot resolve declared external package ${packageName}.`);
      }
      continue;
    }
    const destination = join(stagedNodeModules, ...packageName.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await materializeExternalPackage(source, destination, {
      ancestors: new Set(), catalogVersions, internalPackageNames, physicalInternalRoots,
      requestedName: packageName,
      requestedVersion: requestedVersion(specifier, packageName, catalogVersions),
      state,
    });
  }
}

async function wireStagedPackageDependencies(input) {
  await materializeDeclaredExternalNodeModules(
    input.sourceRoot, input.stagedRoot, input.manifest, input.internalPackageNames, input.physicalInternalRoots,
    input.catalogVersions,
  );
  for (const { name } of input.dependencyDeclarations[input.packageName] ?? []) {
    const dependencyRoot = input.stagedPackagesByName.get(name);
    if (dependencyRoot === undefined) {
      throw new Error(`Clean stage is missing internal support package ${name} for ${input.packageName}.`);
    }
    const [scope, leaf] = name.startsWith("@") ? name.split("/") : [undefined, name];
    const linkRoot = scope === undefined ? join(input.stagedRoot, "node_modules") : join(input.stagedRoot, "node_modules", scope);
    await mkdir(linkRoot, { recursive: true });
    await symlink(dependencyRoot, join(linkRoot, leaf), process.platform === "win32" ? "junction" : "dir");
  }
}

function workspaceCatalogVersions(bytes) {
  const versions = new Map();
  let inCatalog = false;
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    if (/^catalog:\s*$/u.test(line)) { inCatalog = true; continue; }
    if (inCatalog && /^\S/u.test(line)) break;
    if (!inCatalog) continue;
    const match = /^  (["']?)([^"':]+|@[^"']+)\1:\s*([0-9][0-9A-Za-z.-]*)\s*$/u.exec(line);
    if (match !== null) versions.set(match[2], match[3]);
  }
  return versions;
}

function releaseManifestIdentity(manifest) {
  const identity = {};
  for (const key of ["name", "version", "type", "bin", "exports", "files", "scripts"]) {
    if (Object.hasOwn(manifest, key)) identity[key] = manifest[key];
  }
  return JSON.stringify(identity);
}

async function expectedPackedEntries(packageRoot, manifest, requiredArtifactPaths) {
  const entries = new Set(["package/", "package/package.json", "package/LICENSE", "package/README.md"]);
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
      if (relativePath !== "package.json") fileDigests.set(`package/${relativePath}`, sha256(bytes));
      return;
    }
    entries.add(`package/${relativePath}/`);
    for (const entry of await boundedDirectoryEntries(absolute, "Packed payload authority", state)) {
      await visit(join(absolute, entry.name), `${relativePath}/${entry.name}`);
    }
  }
  if (Array.isArray(manifest.files)) {
    for (const path of manifest.files) await visit(join(packageRoot, path), path);
  } else {
    for (const path of requiredArtifactPaths ?? []) {
      entries.add(`package/${path}`);
      let boundary = path.lastIndexOf("/");
      while (boundary >= 0) {
        entries.add(`package/${path.slice(0, boundary)}/`);
        boundary = path.lastIndexOf("/", boundary - 1);
      }
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
    if (typeof root === "string") physicalInternalRoots.push(await realpath(root));
  }
  const manifestsByName = new Map();
  const workspace = await readStableRegularFile(
    join(input.repositoryRoot, "pnpm-workspace.yaml"), { bytes: 0 }, "Workspace manifest",
  );
  const catalogVersions = workspaceCatalogVersions(workspace.bytes);
  for (const entry of input.stagePackages) {
    const sourceRoot = entry.sourceRoot ?? join(input.repositoryRoot, entry.root);
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
  if (packageRoot === undefined) throw new Error(`Clean stage has no target package ${input.packageName}.`);
  await writeFile(join(stageRoot, "pnpm-workspace.yaml"), workspace.bytes, { flag: "wx", mode: workspace.mode });
  for (const packageName of input.buildPackageNames ?? [input.packageName]) {
    const buildRoot = stagedPackagesByName.get(packageName);
    if (buildRoot === undefined) throw new Error(`Clean stage build order names unstaged package ${packageName}.`);
    await input.runBuild(buildRoot, Object.freeze({ packageName, stageRoot, stagedPackagesByName }));
  }
  const sourceManifest = manifestsByName.get(input.packageName);
  const packedManifest = await readBoundedStableJson(join(packageRoot, "package.json"), "Post-build package manifest");
  if (releaseManifestIdentity(packedManifest) !== releaseManifestIdentity(sourceManifest)) {
    throw new Error(`Package build changed release manifest identity for ${input.packageName}.`);
  }
  const expectedEntries = await expectedPackedEntries(packageRoot, sourceManifest, input.requiredArtifactPaths);
  return Object.freeze({ expectedEntries, packageRoot, sourceManifest, stageRoot });
}

async function createArtifact(input, stage) {
  const destination = join(stage.stageRoot, "pack");
  await mkdir(destination, { recursive: true });
  await input.runPnpm(["pack", "--pack-destination", destination], stage.packageRoot);
  const state = { entries: 0 };
  const archives = (await boundedDirectoryEntries(destination, "Pack destination", state))
    .map(({ name }) => name).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error(`pnpm pack produced ${archives.length} tarballs; expected exactly one.`);
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
  if (manifests.length !== 1) throw new Error("Package tar must contain exactly one regular package/package.json.");
  let manifest;
  try { manifest = JSON.parse(manifests[0].data.toString("utf8")); } catch (error) {
    throw new Error(`Packed package manifest is not valid JSON: ${error.message}`, { cause: error });
  }
  if (releaseManifestIdentity(manifest) !== releaseManifestIdentity(expectedManifest)) {
    throw new Error(
      `Packed package manifest identity does not match ${expectedManifest.name}@${expectedManifest.version}.`,
    );
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
    if (type === "x" || type === "g") continue;
    const destination = join(extractedRoot, ...name.split("/"));
    if (!containsPhysicalPath(extractedRoot, destination)) throw new Error(`Unsafe extraction path: ${name}.`);
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
  if (firstPhysicalPath === secondPhysicalPath || (firstStat.dev === secondStat.dev && firstStat.ino === secondStat.ino)) {
    throw new Error("Two clean package builds must produce distinct archive files.");
  }
  const [firstBytes, secondBytes] = await Promise.all([
    readRegularArchive(first.archivePath), readRegularArchive(second.archivePath),
  ]);
  if (sha256(firstBytes) !== sha256(secondBytes)) {
    throw new Error("Two clean package builds did not produce byte-identical tarballs.");
  }
  const inspection = inspectCompressedTarArchive(firstBytes);
  assertExactArchiveManifest(inspection, firstStage.sourceManifest);
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
