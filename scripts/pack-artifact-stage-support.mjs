import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

// A clean stage includes the full isolated dependency closure needed to build
// each package. Keep traversal bounded while allowing the current workspace
// toolchain and foundation runtime closure to coexist in one stage.
const MAX_STAGE_ENTRIES = 50_000;
// Toolchain dependencies are part of the disposable build stage, not the
// published archive. Keep this aggregate bound separate from archive limits.
const MAX_STAGE_BYTES = 256 * 1024 * 1024;
// Clean build stages may materialize compiler toolchains such as TypeScript's
// native binary, which is larger than the final package-member limit. Keep the
// stage bounded while allowing that supported build-time dependency.
const MAX_MEMBER_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const dependencySections = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
export const generatedPackageEntries = new Set(["dist", "node_modules", "tsconfig.tsbuildinfo"]);

function compareCodePoints([left], [right]) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactPublishSpecifier(packageName, specifier, context) {
  if (specifier === "workspace:*") {
    const version = context.internalPackageVersions.get(packageName);
    if (typeof version !== "string" || parseVersion(version) === undefined) {
      throw new Error(`Staged publish manifest cannot resolve exact workspace version for ${packageName}.`);
    }
    return version;
  }
  if (specifier.startsWith("workspace:")) {
    throw new Error(`Staged publish manifest requires workspace:* for ${packageName}.`);
  }
  if (specifier === "catalog:") {
    const version = context.catalogVersions.get(packageName);
    if (typeof version !== "string" || parseVersion(version) === undefined) {
      throw new Error(`Staged publish manifest cannot resolve exact catalog version for ${packageName}.`);
    }
    return version;
  }
  if (specifier.startsWith("catalog:")) {
    throw new Error(`Staged publish manifest only supports the default catalog for ${packageName}.`);
  }
  return specifier;
}

export function canonicalPublishManifest(manifest, context) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Staged publish manifest must be a JSON object.");
  }
  if (!(context?.catalogVersions instanceof Map) || !(context?.internalPackageVersions instanceof Map)) {
    throw new Error("Staged publish manifest requires exact catalog and workspace version maps.");
  }
  if (manifest.publishConfig !== undefined && (manifest.publishConfig === null ||
      typeof manifest.publishConfig !== "object" || Array.isArray(manifest.publishConfig))) {
    throw new Error("Package manifest has malformed publishConfig.");
  }
  if (manifest.publishConfig?.directory !== undefined) {
    throw new Error("Staged publish manifest cannot use publishConfig.directory.");
  }
  const canonical = { ...manifest };
  for (const section of dependencySections) {
    if (!Object.hasOwn(manifest, section)) {
      continue;
    }
    const declarations = manifest[section];
    if (declarations === null || typeof declarations !== "object" || Array.isArray(declarations)) {
      throw new Error(`Package manifest has malformed ${section}.`);
    }
    canonical[section] = Object.fromEntries(Object.entries(declarations)
      .map(([name, specifier]) => {
        if (typeof specifier !== "string" || specifier === "") {
          throw new Error(`Package manifest has malformed ${section} request for ${name}.`);
        }
        return [name, exactPublishSpecifier(name, specifier, context)];
      })
      .toSorted(compareCodePoints));
  }
  return canonical;
}

export function publishDependencyIdentity(manifest) {
  return JSON.stringify(Object.fromEntries(dependencySections
    .filter((section) => Object.hasOwn(manifest, section))
    .map((section) => [section, manifest[section]])));
}

export async function pathExists(path) {
  try { await lstat(path); return true; } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function sameFileState(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export async function readStableRegularFile(path, state, label, expected, maximumBytes = MAX_MEMBER_BYTES) {
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
    if (!sameFileState(before, opened)) {
      throw new Error(`${label} changed before staging: ${path}.`);
    }
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
    if (state.bytes > MAX_STAGE_BYTES) {
      throw new Error(`${label} exceeds its bounded byte limit.`);
    }
    return { bytes, mode: opened.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

export async function readBoundedStableJson(path, label) {
  const state = { bytes: 0 };
  const result = await readStableRegularFile(path, state, label, undefined, MAX_MANIFEST_BYTES);
  try { return JSON.parse(result.bytes.toString("utf8")); } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
}

export async function boundedDirectoryEntries(path, label, state) {
  const entries = [];
  const directory = await opendir(path);
  try {
    for await (const entry of directory) {
      state.entries += 1;
      if (state.entries > MAX_STAGE_ENTRIES) {
        throw new Error(`${label} exceeds its bounded entry limit.`);
      }
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => {});
  }
  return entries;
}

export async function materializeStableTree(sourceRoot, stagedRoot, { allowLinks, excludedEntries, label, state, validatePhysical }) {
  async function visit(source, destination, depth, countSelf = true) {
    if (depth > 64) {
      throw new Error(`${label} exceeds its bounded traversal depth.`);
    }
    const pathnameBefore = await lstat(source);
    if (pathnameBefore.isSymbolicLink() && !allowLinks) {
      throw new Error(`${label} contains a symlink: ${source}.`);
    }
    const physical = await realpath(source);
    const metadataBefore = await lstat(physical);
    await validatePhysical?.(physical, source, metadataBefore);
    if (countSelf) {
      state.entries += 1;
    }
    if (state.entries > MAX_STAGE_ENTRIES) {
      throw new Error(`${label} exceeds its bounded entry limit.`);
    }
    if (metadataBefore.isFile()) {
      const { bytes, mode } = await readStableRegularFile(source, state, label, {
        metadata: metadataBefore, pathname: pathnameBefore, physical,
      });
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: "wx", mode });
      return;
    }
    if (!metadataBefore.isDirectory()) {
      throw new Error(`${label} contains a special file: ${source}.`);
    }
    await mkdir(destination, { mode: metadataBefore.mode & 0o777, recursive: false });
    const entries = await boundedDirectoryEntries(physical, label, state);
    for (const entry of entries) {
      if (excludedEntries.has(entry.name)) {
        continue;
      }
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

export function containsPhysicalPath(parent, candidate) {
  const remainder = relative(parent, candidate);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function isInternalSourcePath(internalRoot, candidate) {
  if (!containsPhysicalPath(internalRoot, candidate)) {
    return false;
  }
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
    if (installationBoundarySeen) {
      break;
    }
    if (current.endsWith(`${sep}node_modules`)) {
      installationBoundarySeen = true;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
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
      if (!requests.has(name)) {
        requests.set(name, specifier);
      }
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
    if (await pathExists(candidate)) {
      return candidate;
    }
    if (installationBoundarySeen) {
      return;
    }
    if (current.endsWith(`${sep}node_modules`)) {
      installationBoundarySeen = true;
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""];
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  if (left[3] === right[3]) {
    return 0;
  }
  if (left[3] === "") {
    return 1;
  }
  if (right[3] === "") {
    return -1;
  }
  return left[3] < right[3] ? -1 : 1;
}

function acceptsVersion(version, requested) {
  const actual = parseVersion(version);
  if (actual === undefined) {
    return false;
  }
  const alternatives = requested.split("||").map((part) => part.trim());
  return alternatives.some((alternative) => {
    if (alternative === "*" || alternative === "latest") {
      return true;
    }
    const exact = parseVersion(alternative);
    if (exact !== undefined) {
      return compareVersion(actual, exact) === 0;
    }
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
      if (match === null) {
        return false;
      }
      const difference = compareVersion(actual, parseVersion(match[2]));
      return match[1] === ">=" ? difference >= 0 : match[1] === "<=" ? difference <= 0 :
        match[1] === ">" ? difference > 0 : match[1] === "<" ? difference < 0 : difference === 0;
    });
  });
}

function requestedVersion(specifier, packageName, catalogVersions) {
  if (specifier === "catalog:") {
    const version = catalogVersions.get(packageName);
    if (version === undefined) {
      throw new Error(`Workspace catalog has no exact version for ${packageName}.`);
    }
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
      if (metadata.isDirectory()) {
        await assertNoInternalResolutionFromAncestors(candidate, context.internalPackageNames);
      }
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
  if (context.ancestors.has(identity)) {
    throw new Error(`External dependency cycle includes ${sourceManifest.name}.`);
  }
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

async function materializeDeclaredExternalNodeModules({
  catalogVersions, internalPackageNames, manifest, physicalInternalRoots, sourceRoot, stagedRoot,
}) {
  const sourceNodeModules = join(sourceRoot, "node_modules");
  const stagedNodeModules = join(stagedRoot, "node_modules");
  await mkdir(stagedNodeModules, { recursive: true });
  if (!(await pathExists(sourceNodeModules))) {
    return;
  }
  const state = { bytes: 0, entries: 0 };
  for (const [packageName, specifier] of [...buildDependencyRequests(manifest)].toSorted()) {
    if (internalPackageNames.has(packageName)) {
      continue;
    }
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

export async function wireStagedPackageDependencies(input) {
  await materializeDeclaredExternalNodeModules(input);
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
