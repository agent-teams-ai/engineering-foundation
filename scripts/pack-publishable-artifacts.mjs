import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { packAndInspectArtifact, snapshotVerifiedArtifact } from "./pack-artifact-e2e.mjs";
import {
  PUBLISHABLE_PACKAGES,
  PUBLISHABLE_PACKAGE_DEPENDENCY_DECLARATIONS,
} from "./publishable-packages.mjs";
import { createPnpmRunner } from "./pack-test-support.mjs";

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
const PORTABLE_ARTIFACT_PATH = /^(?!\/)(?!.*\\)(?!.*\/\/)(?!.*\/$)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@/-]+$/u;

function fail(message) {
  throw new Error(`Publishable artifact staging is invalid: ${message}`);
}

function portableSegmentIdentity(segment, source) {
  if (/[\0-\x1f\x7f<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment)) {
    fail(`${source} is not portable across supported filesystems`);
  }
  const identity = segment.normalize("NFKC").toUpperCase();
  const deviceStem = identity.split(".")[0].replace(/[. ]+$/u, "");
  if (identity === "" || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceStem)) {
    fail(`${source} is not portable across supported filesystems`);
  }
  return identity;
}

async function readBoundedManifest(path, label) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 1024 * 1024) fail(`${label} is not a bounded regular manifest`);
    const bytes = Buffer.alloc(before.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const overflow = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await handle.read(overflow, 0, 1, bytes.length);
    const after = await handle.stat();
    if (bytesRead !== bytes.length || overflowBytes !== 0 || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail(`${label} changed while being read`);
    }
    try { return JSON.parse(bytes.toString("utf8")); } catch (error) {
      fail(`${label} is not valid JSON: ${error.message}`);
    }
  } finally {
    await handle.close();
  }
}

function manifestReleaseTargets(manifest) {
  const targets = new Set();
  const visit = (value) => {
    if (typeof value === "string") {
      if (value.startsWith("./") && !value.includes("*") && value !== "./package.json") targets.add(value.slice(2));
      return;
    }
    if (value !== null && typeof value === "object") for (const child of Object.values(value)) visit(child);
  };
  visit(manifest.bin);
  visit(manifest.exports);
  return targets;
}

function pathIdentity(path) {
  return path.split(/[\\/]/u).filter(Boolean)
    .map((segment) => portableSegmentIdentity(segment, path)).join("/");
}

function containsPath(parent, candidate) {
  const remainder = relative(parent, candidate);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function validateRequiredArtifactPaths(requiredArtifactPaths, packageNames) {
  if (requiredArtifactPaths === null || typeof requiredArtifactPaths !== "object" || Array.isArray(requiredArtifactPaths)) {
    fail("requiredArtifactPaths must be a package-name keyed object");
  }
  const names = Object.keys(requiredArtifactPaths);
  for (const name of packageNames) {
    if (!Object.hasOwn(requiredArtifactPaths, name)) {
      fail(`required artifact policy is missing package ${name}`);
    }
  }
  for (const name of names) {
    if (!packageNames.has(name)) {
      fail(`required artifact policy names unknown package ${name}`);
    }
    const paths = requiredArtifactPaths[name];
    if (!Array.isArray(paths) || paths.length === 0) {
      fail(`required artifact policy for ${name} must be a non-empty array`);
    }
    const identities = new Set();
    for (const path of paths) {
      if (typeof path !== "string" || !PORTABLE_ARTIFACT_PATH.test(path)) {
        fail(`required artifact policy for ${name} contains an unsafe path`);
      }
      const identity = pathIdentity(path);
      if (identities.has(identity)) {
        fail(`required artifact policy for ${name} contains duplicate or colliding paths`);
      }
      identities.add(identity);
    }
  }
}

function validateProjectedPackages(repositoryRoot, packages) {
  if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot)) {
    fail("repositoryRoot must be an absolute path");
  }
  if (!Array.isArray(packages) || packages.length === 0) {
    fail("packages must be a non-empty manifest-derived projection");
  }
  const byName = new Map();
  const stageRoots = [];
  for (const entry of packages) {
    if (entry === null || typeof entry !== "object" || typeof entry.name !== "string" || !PACKAGE_NAME.test(entry.name)) {
      fail("each projected package must have an identity");
    }
    if (byName.has(entry.name)) {
      fail(`duplicate package identity ${entry.name}`);
    }
    if (typeof entry.root !== "string" || !PORTABLE_ARTIFACT_PATH.test(entry.root) || isAbsolute(entry.root)) {
      fail(`${entry.name} has an unsafe package root`);
    }
    const absoluteRoot = resolve(repositoryRoot, entry.root);
    if (!containsPath(repositoryRoot, absoluteRoot) || absoluteRoot === repositoryRoot) {
      fail(`${entry.name} package root escapes the repository`);
    }
    const identity = pathIdentity(absoluteRoot);
    for (const { identity: otherIdentity, name } of stageRoots) {
      const nested = identity === otherIdentity || identity.startsWith(`${otherIdentity}/`) ||
        otherIdentity.startsWith(`${identity}/`);
      if (nested) {
        fail(`${entry.name} and ${name} have colliding stage paths`);
      }
    }
    stageRoots.push({ identity, name: entry.name });
    byName.set(entry.name, entry);
  }
  return byName;
}

export async function assertPhysicalPublishablePackageRoots(repositoryRoot, packages) {
  const physicalRepositoryRoot = await realpath(repositoryRoot);
  const roots = [];
  for (const entry of packages) {
    const physicalRoot = await realpath(resolve(repositoryRoot, entry.root));
    if (physicalRoot === physicalRepositoryRoot || !containsPath(physicalRepositoryRoot, physicalRoot)) {
      fail(`${entry.name} package root physically escapes the repository`);
    }
    const identity = pathIdentity(physicalRoot);
    for (const other of roots) {
      if (identity === other.identity || identity.startsWith(`${other.identity}/`) ||
        other.identity.startsWith(`${identity}/`)) {
        fail(`${entry.name} and ${other.name} have physically colliding package roots`);
      }
    }
    roots.push({ identity, name: entry.name });
  }
}

function deriveBuildClosures(packages, dependencyDeclarations, byName) {
  if (dependencyDeclarations === null || typeof dependencyDeclarations !== "object" || Array.isArray(dependencyDeclarations)) {
    fail("dependency declarations must be the manifest-derived projection");
  }
  for (const name of Object.keys(dependencyDeclarations)) {
    if (!byName.has(name)) fail(`dependency declarations name unknown package ${name}`);
  }
  const state = new Map();
  const closures = new Map();
  const visit = (name, trail) => {
    if (!byName.has(name)) fail(`unresolved internal support package ${name}`);
    if (state.get(name) === "visiting") fail(`internal dependency cycle includes ${[...trail, name].join(" -> ")}`);
    if (state.get(name) === "visited") return closures.get(name);
    const declarations = dependencyDeclarations[name];
    if (!Array.isArray(declarations)) fail(`dependency declarations are missing package ${name}`);
    state.set(name, "visiting");
    const closure = new Set([name]);
    for (const declaration of declarations) {
      if (declaration === null || typeof declaration !== "object" || typeof declaration.name !== "string" ||
          typeof declaration.section !== "string") {
        fail(`${name} has a malformed internal dependency declaration`);
      }
      for (const dependency of visit(declaration.name, [...trail, name])) closure.add(dependency);
    }
    state.set(name, "visited");
    closures.set(name, closure);
    return closure;
  };
  for (const { name } of packages) visit(name, []);
  const order = new Map(packages.map(({ name }, index) => [name, index]));
  for (const { name } of packages) {
    for (const { name: dependencyName } of dependencyDeclarations[name]) {
      if (order.get(dependencyName) >= order.get(name)) {
        fail(`manifest-derived package order places ${name} before support ${dependencyName}`);
      }
    }
  }
  return new Map(packages.map(({ name }) => [name,
    Object.freeze([...closures.get(name)].toSorted((left, right) => order.get(left) - order.get(right))),
  ]));
}

// Pure planning seam for synthetic manifest-projection tests. Production orchestration below
// deliberately supplies the authoritative projection and the real artifact packer itself.
export function derivePublishableArtifactPlan({
  dependencyDeclarations,
  packages,
  repositoryRoot,
  requiredArtifactPaths,
}) {
  const byName = validateProjectedPackages(repositoryRoot, packages);
  validateRequiredArtifactPaths(requiredArtifactPaths, new Set(byName.keys()));
  const closures = deriveBuildClosures(packages, dependencyDeclarations, byName);
  return Object.freeze(packages.map((entry) => Object.freeze({
    buildPackageNames: closures.get(entry.name),
    package: entry,
    requiredArtifactPaths: Object.freeze([...requiredArtifactPaths[entry.name]]),
    stagePackages: Object.freeze(closures.get(entry.name).map((name) => Object.freeze({ ...byName.get(name) }))),
  })));
}

export async function packPublishableArtifacts(input) {
  if (input === null || typeof input !== "object") fail("input must be an object");
  const inputKeys = Object.keys(input);
  const acceptedKeys = new Set(["temporaryRoot"]);
  if (inputKeys.some((key) => !acceptedKeys.has(key))) {
    fail(`production orchestration does not accept ${inputKeys.find((key) => !acceptedKeys.has(key))} overrides`);
  }
  if (typeof input.temporaryRoot !== "string" || !isAbsolute(input.temporaryRoot)) {
    fail("temporaryRoot must be an absolute path");
  }
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const manifests = new Map();
  const requiredArtifactPaths = {};
  const allowedArtifactPaths = {};
  const manifestFilePolicies = {};
  for (const entry of PUBLISHABLE_PACKAGES) {
    const manifestPath = resolve(repositoryRoot, entry.manifestPath);
    const manifest = await readBoundedManifest(manifestPath, entry.manifestPath);
    if (manifest.name !== entry.name || typeof manifest.version !== "string" ||
        !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
      fail(`${entry.manifestPath} has an unexpected package identity or version`);
    }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      fail(`${entry.manifestPath} must own a non-empty package files allowlist`);
    }
    if (typeof manifest.scripts?.build !== "string" || manifest.scripts.build.trim() === "") {
      fail(`${entry.manifestPath} must own a package build contract`);
    }
    const allowed = [];
    const required = manifestReleaseTargets(manifest);
    for (const path of manifest.files) {
      if (typeof path !== "string" || !PORTABLE_ARTIFACT_PATH.test(path)) {
        fail(`${entry.manifestPath} contains an unsafe package files path`);
      }
      const sourcePath = resolve(repositoryRoot, entry.root, path);
      if (path === "dist") {
        allowed.push(path);
      } else {
        try {
          const metadata = await lstat(sourcePath);
          if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
            fail(`${entry.manifestPath} package files path must be a regular file or directory`);
          }
          allowed.push(path);
          if (metadata.isFile() && !["README.md", "CHANGELOG.md", "LICENSE"].includes(path)) required.add(path);
        } catch (error) {
          if (error?.code !== "ENOENT" || path !== "LICENSE") throw error;
          allowed.push(path);
        }
      }
    }
    manifests.set(entry.name, Object.freeze(structuredClone(manifest)));
    allowedArtifactPaths[entry.name] = [...new Set(allowed)].toSorted();
    requiredArtifactPaths[entry.name] = [...required].toSorted();
    manifestFilePolicies[entry.name] = [...new Set(manifest.files)].toSorted();
  }
  const plan = derivePublishableArtifactPlan({
    dependencyDeclarations: PUBLISHABLE_PACKAGE_DEPENDENCY_DECLARATIONS,
    packages: PUBLISHABLE_PACKAGES,
    repositoryRoot,
    requiredArtifactPaths,
  });
  for (const item of plan) {
    for (const requiredPath of item.requiredArtifactPaths) {
      if (!manifestFilePolicies[item.package.name].some((allowed) =>
        requiredPath === allowed || requiredPath.startsWith(`${allowed}/`))) {
        fail(`required artifact ${requiredPath} for ${item.package.name} is outside its manifest files allowlist`);
      }
    }
  }
  await assertPhysicalPublishablePackageRoots(repositoryRoot, PUBLISHABLE_PACKAGES);
  const authoritativePackageRoots = PUBLISHABLE_PACKAGES.map((entry) => resolve(repositoryRoot, entry.root));
  const runPnpm = createPnpmRunner();
  const runBuild = async (stagedPackageRoot) => runPnpm(["run", "build"], stagedPackageRoot);
  const pending = [];
  for (const item of plan) {
    const entry = item.package;
    const artifact = await packAndInspectArtifact({
      artifactLabel: `package-${Buffer.from(entry.name, "utf8").toString("hex")}`,
      allowedArtifactPaths: allowedArtifactPaths[entry.name],
      authoritativePackageRoots,
      buildPackageNames: item.buildPackageNames,
      dependencyDeclarations: PUBLISHABLE_PACKAGE_DEPENDENCY_DECLARATIONS,
      packageName: entry.name,
      packageRoot: resolve(repositoryRoot, entry.root),
      repositoryRoot,
      requiredArtifactPaths: item.requiredArtifactPaths,
      runBuild,
      runPnpm,
      stagePackages: item.stagePackages.map((support) => Object.freeze({
        ...support,
        ...manifests.get(support.name),
        sourceRoot: resolve(repositoryRoot, support.root),
      })),
      temporaryRoot: input.temporaryRoot,
    });
    pending.push({ artifact, entry, item });
  }
  // No package-controlled process runs after this point. Re-open every earlier
  // archive with O_NOFOLLOW and verify its digest before creating the immutable
  // downstream snapshots, so a later package build cannot replace an earlier
  // qualified path between verification and use.
  const finalRoot = await mkdtemp(join(input.temporaryRoot, "qualified-package-artifacts-"));
  const records = {};
  for (const { artifact, entry, item } of pending) {
    const bytes = snapshotVerifiedArtifact(artifact);
    const packageRoot = join(finalRoot, Buffer.from(entry.name, "utf8").toString("hex"));
    await mkdir(packageRoot, { recursive: false });
    const archivePath = join(packageRoot, artifact.archiveName);
    await writeFile(archivePath, bytes, { flag: "wx", mode: 0o444 });
    records[entry.name] = Object.freeze({
      archiveFileSpecifier: `file:${archivePath.replaceAll("\\", "/")}`,
      archiveName: artifact.archiveName,
      archivePath,
      buildSupportPackageNames: item.buildPackageNames,
      packageName: entry.name,
      packageVersion: manifests.get(entry.name).version,
      requiredArtifactPaths: item.requiredArtifactPaths,
      sha256: artifact.sha256,
    });
  }
  return Object.freeze(records);
}
