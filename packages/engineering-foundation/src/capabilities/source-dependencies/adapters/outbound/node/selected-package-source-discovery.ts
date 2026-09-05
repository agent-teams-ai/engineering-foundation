import type { Dirent } from "node:fs";
import { join, posix } from "node:path";

import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import { CapabilityInputError } from "../../../../../capability-runtime.js";
import { assertNotCancelled } from "../../../../../strict-yaml.js";
import type { WorkspacePackage } from "../../../../../workspace-inventory/application/model/workspace-inventory.js";
import { portablePathIsInside, portableRepositoryPathIdentity } from "../../../application/model/repository-path.js";
import type { SourceWorkspacePackageTopology } from "../../../application/model/source-workspace-topology.js";
import {
  assertSafeRepositoryPath,
  captureStableRepositoryPath,
  createSourceWorkspaceFileSystem,
  revalidateStableRepositoryPath,
  type SourceWorkspaceFileSystem,
  type StableRepositoryPath
} from "./source-workspace-filesystem.js";

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx"
]);
const REPOSITORY_METADATA_DIRECTORY_NAMES = new Set([".git", "node_modules"]);
const PACKAGE_GENERATED_DIRECTORY_NAMES = new Set(["coverage", "dist"]);

export interface SourceWorkspaceDiscoveryLimits {
  readonly maxDirectoryEntries: number;
  readonly maxManifestFiles: number;
  readonly maxSourceFileBytes: number;
  readonly maxSourceFiles: number;
  readonly maxTotalSourceBytes: number;
}

const DEFAULT_SOURCE_WORKSPACE_DISCOVERY_LIMITS = Object.freeze({
  maxDirectoryEntries: 500_000,
  maxManifestFiles: 5_000,
  maxSourceFileBytes: 4 * 1024 * 1024,
  maxSourceFiles: 100_000,
  maxTotalSourceBytes: 512 * 1024 * 1024
}) satisfies SourceWorkspaceDiscoveryLimits;

export interface SourceWorkspaceDiscoveryHooks {
  readonly afterDirectoryRead?: (repositoryPath: string) => Promise<void> | void;
}

export interface DiscoveredSourceWorkspacePaths {
  readonly directorySnapshots: readonly StableRepositoryPath[];
  readonly manifestPaths: readonly string[];
  readonly sourcePaths: readonly string[];
  readonly symbolicLinkPaths: readonly string[];
}

interface DirectoryCursor {
  readonly absolutePath: string;
  readonly repositoryPath: string;
}

interface DiscoveryBudget {
  entries: number;
  manifests: number;
  sourceFiles: number;
}

interface StableDirectoryReadInput {
  readonly budget: DiscoveryBudget;
  readonly canonicalConsumerRoot: string;
  readonly cursor: DirectoryCursor;
  readonly hooks: SourceWorkspaceDiscoveryHooks;
  readonly limits: SourceWorkspaceDiscoveryLimits;
  readonly operations: SourceWorkspaceFileSystem;
  readonly signal?: AbortSignal;
}

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "source-workspace-topology",
    retryable: false
  });
}

export function sourceWorkspaceDiscoveryLimits(
  overrides: Partial<SourceWorkspaceDiscoveryLimits> | undefined = {}
): SourceWorkspaceDiscoveryLimits {
  const limits = {
    ...DEFAULT_SOURCE_WORKSPACE_DISCOVERY_LIMITS,
    ...overrides
  };
  if (
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value < 1
    )
  ) {
    throw new TypeError("Source workspace discovery limits must be positive safe integers.");
  }
  return Object.freeze(limits);
}

function assertSafeDirectoryEntryName(name: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    inputError(
      "SOURCE_DISCOVERY_PATH_INVALID",
      "Source workspace discovery produced an unsafe directory entry."
    );
  }
}

function recordEntry(
  budget: DiscoveryBudget,
  limits: SourceWorkspaceDiscoveryLimits
): void {
  if (budget.entries >= limits.maxDirectoryEntries) {
    inputError(
      "SOURCE_DISCOVERY_LIMIT_EXCEEDED",
      `Selected workspace package discovery exceeds ${limits.maxDirectoryEntries} filesystem entries.`
    );
  }
  budget.entries += 1;
}

function recordPath(
  path: string,
  paths: Set<string>,
  kind: "manifest" | "source",
  budget: DiscoveryBudget,
  limits: SourceWorkspaceDiscoveryLimits
): void {
  if (paths.has(path)) {
    return;
  }
  const current = kind === "manifest" ? budget.manifests : budget.sourceFiles;
  const maximum =
    kind === "manifest" ? limits.maxManifestFiles : limits.maxSourceFiles;
  if (current >= maximum) {
    inputError(
      kind === "manifest"
        ? "WORKSPACE_LIMIT_EXCEEDED"
        : "SOURCE_FILE_LIMIT_EXCEEDED",
      kind === "manifest"
        ? `Workspace contains more than ${maximum} package manifests.`
        : `Selected workspace packages contain more than ${maximum} source files.`
    );
  }
  paths.add(path);
  if (kind === "manifest") {
    budget.manifests += 1;
  } else {
    budget.sourceFiles += 1;
  }
}

async function readStableDirectoryEntries(
  input: StableDirectoryReadInput
): Promise<{
  readonly captured: StableRepositoryPath;
  readonly entries: readonly Dirent[];
}> {
  const captured = await captureStableRepositoryPath(
    input.canonicalConsumerRoot,
    input.cursor.repositoryPath,
    "directory",
    input.operations,
    input.signal
  );
  if (captured.traversesSymbolicLink) {
    inputError(
      "SOURCE_SYMLINK_PROHIBITED",
      `Selected workspace source cannot traverse symbolic links: ${input.cursor.repositoryPath}.`
    );
  }
  assertNotCancelled(input.signal);
  let directory: Awaited<ReturnType<SourceWorkspaceFileSystem["opendir"]>>;
  try {
    directory = await input.operations.opendir(captured.absolutePath, input.signal);
  } catch {
    assertNotCancelled(input.signal);
    inputError(
      "SOURCE_DIRECTORY_UNAVAILABLE",
      `Selected workspace source directory is unavailable: ${input.cursor.repositoryPath}.`
    );
  }
  const iterator = directory[Symbol.asyncIterator]();
  const entries: Dirent[] = [];
  let completed = false;
  try {
    for (;;) {
      assertNotCancelled(input.signal);
      let result: IteratorResult<Dirent>;
      try {
        result = await iterator.next();
      } catch {
        assertNotCancelled(input.signal);
        inputError(
          "SOURCE_DIRECTORY_UNAVAILABLE",
          `Selected workspace source directory is unavailable: ${input.cursor.repositoryPath}.`
        );
      }
      assertNotCancelled(input.signal);
      if (result.done === true) {
        completed = true;
        break;
      }
      recordEntry(input.budget, input.limits);
      assertSafeDirectoryEntryName(result.value.name);
      entries.push(result.value);
    }
  } finally {
    if (!completed && typeof iterator.return === "function") {
      try {
        await iterator.return();
      } catch {
        // Preserve the cancellation, limit, or filesystem failure that stopped
        // traversal rather than replacing it with iterator cleanup noise.
      }
    }
  }
  await input.hooks.afterDirectoryRead?.(input.cursor.repositoryPath);
  await revalidateStableRepositoryPath(
    input.canonicalConsumerRoot,
    captured,
    input.operations,
    input.signal
  );
  return {
    captured,
    entries: entries.toSorted((left, right) =>
      compareBinaryStrings(left.name, right.name)
    )
  };
}

function childRepositoryPath(parent: string, name: string): string {
  return parent === "." ? name : posix.join(parent, name);
}

function isExcludedDirectory(
  name: string,
  parentIsPackageRoot: boolean
): boolean {
  if (REPOSITORY_METADATA_DIRECTORY_NAMES.has(name)) {
    return true;
  }
  return parentIsPackageRoot && PACKAGE_GENERATED_DIRECTORY_NAMES.has(name);
}

function isRootOrAncestor(
  repositoryPath: string,
  rootIdentities: ReadonlySet<string>
): boolean {
  const identity = portableRepositoryPathIdentity(repositoryPath);
  for (const root of rootIdentities) {
    if (root === identity || root.startsWith(`${identity}/`)) {
      return true;
    }
  }
  return false;
}

function isPackageRootLocation(
  repositoryPath: string,
  repositoryRootIdentities: ReadonlySet<string>
): boolean {
  const identity = portableRepositoryPathIdentity(repositoryPath);
  return (
    repositoryRootIdentities.has(identity) ||
    repositoryRootIdentities.has(posix.dirname(identity))
  );
}

function explicitSourceRootIdentities(
  governedRoots: readonly string[] = [],
  boundaryRoots: readonly string[] = []
): ReadonlySet<string> {
  // Boundary roots can identify source beneath a broad governed package root.
  // They only reopen routes within that scope, never add traversal starting points.
  return new Set(
    [...governedRoots, ...boundaryRoots.filter((root) =>
      governedRoots.some((governedRoot) => portablePathIsInside(root, governedRoot))
    )].map(portableRepositoryPathIdentity)
  );
}

function assertPortablePaths(paths: readonly string[], kind: string): void {
  const identities = new Map<string, string>();
  for (const path of paths) {
    const identity = portableRepositoryPathIdentity(path);
    const existing = identities.get(identity);
    if (existing !== undefined && existing !== path) {
      inputError(
        kind.startsWith("source")
          ? "SOURCE_PATH_CASE_COLLISION"
          : "PACKAGE_PATH_CASE_COLLISION",
        `${kind} paths differ only by portable identity: ${existing} and ${path}.`
      );
    }
    identities.set(identity, path);
  }
}

export async function discoverSourceWorkspacePaths(
  canonicalConsumerRoot: string,
  options: {
    readonly repositoryRoots: readonly string[];
    readonly selectedPackageRoots?: readonly string[];
    readonly governedRoots?: readonly string[];
    readonly boundaryRoots?: readonly string[];
    readonly fileSystem?: Partial<SourceWorkspaceFileSystem>;
    readonly hooks?: SourceWorkspaceDiscoveryHooks;
    readonly limits?: Partial<SourceWorkspaceDiscoveryLimits>;
    readonly signal?: AbortSignal;
  }
): Promise<DiscoveredSourceWorkspacePaths> {
  const operations = createSourceWorkspaceFileSystem(options.fileSystem);
  const limits = sourceWorkspaceDiscoveryLimits(options.limits);
  const hooks = options.hooks ?? {};
  const budget: DiscoveryBudget = { entries: 0, manifests: 0, sourceFiles: 0 };
  const manifestPaths = new Set<string>();
  const sourcePaths = new Set<string>();
  const symbolicLinkPaths = new Set<string>();
  const directorySnapshots: StableRepositoryPath[] = [];
  const selectedPackageRootIdentities = new Set(
    (options.selectedPackageRoots ?? []).map(portableRepositoryPathIdentity)
  );
  const repositoryRootIdentities = new Set(
    options.repositoryRoots.map(portableRepositoryPathIdentity)
  );
  const sourceRootIdentities = explicitSourceRootIdentities(options.governedRoots, options.boundaryRoots);
  const directories: DirectoryCursor[] = options.repositoryRoots
    .toSorted(compareBinaryStrings)
    .toReversed()
    .map((repositoryPath) => {
      assertSafeRepositoryPath(repositoryPath);
      return {
        absolutePath:
          repositoryPath === "."
            ? canonicalConsumerRoot
            : join(canonicalConsumerRoot, repositoryPath),
        repositoryPath
      };
    });
  while (directories.length > 0) {
    assertNotCancelled(options.signal);
    const cursor = directories.pop();
    if (cursor === undefined) {
      break;
    }
    const { captured, entries } = await readStableDirectoryEntries({
      budget,
      canonicalConsumerRoot,
      cursor,
      hooks,
      limits,
      operations,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    directorySnapshots.push(captured);
    // A package root is the configured path or a manifest-bearing direct child.
    // Nested source/type scopes cannot turn their coverage/dist into build output.
    const cursorIsPackageRoot =
      isPackageRootLocation(cursor.repositoryPath, repositoryRootIdentities) &&
      entries.some((entry) => entry.name === "package.json" && entry.isFile());
    const childDirectories: DirectoryCursor[] = [];
    for (const entry of entries) {
      assertNotCancelled(options.signal);
      const repositoryPath = childRepositoryPath(cursor.repositoryPath, entry.name);
      if (
        isExcludedDirectory(entry.name, cursorIsPackageRoot) &&
        !isRootOrAncestor(repositoryPath, selectedPackageRootIdentities) &&
        !(PACKAGE_GENERATED_DIRECTORY_NAMES.has(entry.name) &&
          isRootOrAncestor(repositoryPath, sourceRootIdentities))
      ) {
        if (entry.name === "dist" && entry.isSymbolicLink()) {
          symbolicLinkPaths.add(repositoryPath);
        }
        continue;
      }
      assertSafeRepositoryPath(repositoryPath);
      const absolutePath = join(cursor.absolutePath, entry.name);
      if (entry.isSymbolicLink()) {
        symbolicLinkPaths.add(repositoryPath);
      } else if (entry.isDirectory()) {
        childDirectories.push({ absolutePath, repositoryPath });
      } else if (entry.isFile()) {
        if (entry.name === "package.json") {
          recordPath(
            repositoryPath,
            manifestPaths,
            "manifest",
            budget,
            limits
          );
        }
        if (SOURCE_EXTENSIONS.has(posix.extname(entry.name))) {
          recordPath(
            repositoryPath,
            sourcePaths,
            "source",
            budget,
            limits
          );
        }
      }
    }
    directories.push(...childDirectories.toReversed());
  }
  const manifests = [...manifestPaths].toSorted(compareBinaryStrings);
  const sources = [...sourcePaths].toSorted(compareBinaryStrings);
  const symbolicLinks = [...symbolicLinkPaths].toSorted(compareBinaryStrings);
  const directoryPaths = directorySnapshots.map(({ repositoryPath }) => repositoryPath);
  assertPortablePaths(directoryPaths, "source directory");
  assertPortablePaths(manifests, "Workspace package manifest");
  assertPortablePaths(sources, "source");
  assertPortablePaths(symbolicLinks, "source");
  return Object.freeze({
    directorySnapshots: Object.freeze(directorySnapshots),
    manifestPaths: Object.freeze(manifests),
    sourcePaths: Object.freeze(sources),
    symbolicLinkPaths: Object.freeze(symbolicLinks)
  });
}

function packageByPortableRoot(
  packages: readonly WorkspacePackage[]
): ReadonlyMap<string, WorkspacePackage> {
  const byRoot = new Map<string, WorkspacePackage>();
  for (const workspacePackage of packages) {
    const identity = portableRepositoryPathIdentity(workspacePackage.rootPath);
    const existing = byRoot.get(identity);
    if (existing !== undefined) {
      inputError(
        "WORKSPACE_PACKAGE_ROOT_DUPLICATE",
        `Workspace package roots share a portable identity: ${existing.rootPath} and ${workspacePackage.rootPath}.`
      );
    }
    byRoot.set(identity, workspacePackage);
  }
  return byRoot;
}

function packageRootIdentities(
  manifestPaths: readonly string[]
): ReadonlySet<string> {
  return new Set(
    manifestPaths.map((manifestPath) =>
      portableRepositoryPathIdentity(
        manifestPath === "package.json" ? "." : posix.dirname(manifestPath)
      )
    )
  );
}

function owningPackage(
  path: string,
  packagesByRoot: ReadonlyMap<string, WorkspacePackage>,
  ownershipRoots: ReadonlySet<string>
): WorkspacePackage | undefined {
  let candidate = portableRepositoryPathIdentity(path);
  for (;;) {
    if (ownershipRoots.has(candidate)) {
      return packagesByRoot.get(candidate);
    }
    if (candidate === ".") {
      return undefined;
    }
    const separator = candidate.lastIndexOf("/");
    candidate = separator === -1 ? "." : candidate.slice(0, separator);
  }
}

export function buildSelectedPackageSourceTopology(
  packages: readonly WorkspacePackage[],
  sourcePaths: readonly string[],
  allManifestPaths: readonly string[]
): readonly Omit<SourceWorkspacePackageTopology, "filesystemIdentity">[] {
  const packagesByRoot = packageByPortableRoot(packages);
  const ownershipRoots = packageRootIdentities(allManifestPaths);
  const pathsByRoot = new Map<string, string[]>();
  for (const workspacePackage of packages) {
    pathsByRoot.set(portableRepositoryPathIdentity(workspacePackage.rootPath), []);
  }
  for (const path of sourcePaths) {
    const workspacePackage = owningPackage(path, packagesByRoot, ownershipRoots);
    if (workspacePackage !== undefined) {
      pathsByRoot
        .get(portableRepositoryPathIdentity(workspacePackage.rootPath))
        ?.push(path);
    }
  }
  return Object.freeze(
    packages
      .toSorted((left, right) => compareBinaryStrings(left.rootPath, right.rootPath))
      .map((workspacePackage) =>
        Object.freeze({
          manifestPath: workspacePackage.manifestPath,
          name: workspacePackage.name,
          rootPath: workspacePackage.rootPath,
          sourcePaths: Object.freeze(
            (pathsByRoot.get(
              portableRepositoryPathIdentity(workspacePackage.rootPath)
            ) ?? []).toSorted(compareBinaryStrings)
          )
        })
      )
  );
}

export function rootOutsideSelectedPackages(
  repositoryPath: string,
  packages: readonly WorkspacePackage[],
  allManifestPaths: readonly string[]
): boolean {
  return (
    owningPackage(
      repositoryPath,
      packageByPortableRoot(packages),
      packageRootIdentities(allManifestPaths)
    ) === undefined
  );
}
