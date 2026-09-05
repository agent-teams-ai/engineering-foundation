import type { Dirent } from "node:fs";
import { opendir } from "node:fs/promises";
import { isAbsolute, join, posix, sep } from "node:path";

import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import { CapabilityInputError } from "../../../../features/validation-reporting/api.js";
import { assertNotCancelled } from "../../../../cancellation.js";
import { loadStrictYamlFile } from "../../../../features/configuration-input/node.js";
import type {
  CatalogEntry,
  WorkspaceInventory
} from "../../../application/model/workspace-inventory.js";
import type { WorkspaceInventoryReader } from "../../../application/ports/workspace-inventory-reader.js";
import { readPnpmPackageManifestSnapshots } from "./pnpm-package-manifest-snapshot-reader.js";

const MAX_WORKSPACE_PACKAGES = 5_000;
const MAX_WORKSPACE_DISCOVERY_ENTRIES = 500_000;
const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

function inputError(code: string, message: string, phase: string): never {
  throw new CapabilityInputError({ code, message, phase, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function validatedGlobManifestPath(candidate: string): string {
  const repositoryPath = toPosixPath(candidate);
  const segments = repositoryPath.split("/");
  if (
    isAbsolute(candidate) ||
    posix.isAbsolute(repositoryPath) ||
    /^[A-Za-z]:/u.test(repositoryPath) ||
    repositoryPath.startsWith("//") ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === ".."
    ) ||
    posix.normalize(repositoryPath) !== repositoryPath ||
    posix.basename(repositoryPath) !== "package.json"
  ) {
    inputError(
      "WORKSPACE_GLOB_CANDIDATE_INVALID",
      "Workspace discovery returned a non-contained package manifest candidate.",
      "workspace-discovery"
    );
  }
  return repositoryPath;
}

function portablePathIdentity(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function assertPatternDirectoryIdentity(
  patterns: readonly string[],
  directoriesByIdentity: ReadonlyMap<string, string>
): void {
  for (const pattern of patterns) {
    const segments = (pattern.startsWith("!") ? pattern.slice(1) : pattern).split("/");
    const literalSegments: string[] = [];
    for (const segment of segments) {
      if (/[*?[\]{}()]/u.test(segment)) {
        break;
      }
      literalSegments.push(segment);
      const literalPath = literalSegments.join("/");
      const discovered = directoriesByIdentity.get(portablePathIdentity(literalPath));
      if (discovered !== undefined && discovered !== literalPath) {
        inputError(
          "PACKAGE_PATH_CASE_COLLISION",
          `Workspace pattern and package directory paths differ only by portable identity: ${literalPath} and ${discovered}.`,
          "workspace-discovery"
        );
      }
    }
  }
}

function recordWorkspaceDirectory(
  directoriesByIdentity: Map<string, string>,
  repositoryPath: string
): void {
  const identity = portablePathIdentity(repositoryPath);
  const existing = directoriesByIdentity.get(identity);
  if (existing !== undefined && existing !== repositoryPath) {
    inputError(
      "PACKAGE_PATH_CASE_COLLISION",
      `Workspace package directories differ only by portable identity: ${existing} and ${repositoryPath}.`,
      "workspace-discovery"
    );
  }
  directoriesByIdentity.set(identity, repositoryPath);
}

function validateWorkspacePatterns(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (pattern) =>
        typeof pattern !== "string" ||
        pattern.length === 0 ||
        pattern.includes("\\") ||
        pattern.startsWith("/") ||
        pattern.split("/").includes("..")
    )
  ) {
    inputError(
      "PNPM_WORKSPACE_INVALID",
      "pnpm-workspace.yaml packages must contain repository-relative POSIX glob patterns.",
      "workspace-discovery"
    );
  }
  return value as readonly string[];
}

function stringRecord(
  value: unknown,
  field: string,
  phase: string
): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    inputError("GOVERNED_INPUT_INVALID", `${field} must be an object.`, phase);
  }
  for (const [name, specifier] of Object.entries(value)) {
    if (name.length === 0 || typeof specifier !== "string" || specifier.length === 0) {
      inputError(
        "GOVERNED_INPUT_INVALID",
        `${field} must contain non-empty string values.`,
        phase
      );
    }
  }
  return value as Readonly<Record<string, string>>;
}

function parseCatalog(
  workspace: Record<string, unknown>,
  field: "catalog" | "catalogs"
): readonly CatalogEntry[] {
  const value = workspace[field];
  if (value === undefined) {
    return [];
  }
  if (field === "catalog") {
    return Object.entries(stringRecord(value, "catalog", "workspace-manifest")).map(
      ([dependencyName, version]) => ({
        catalogName: "default",
        dependencyName,
        version
      })
    );
  }
  if (!isRecord(value)) {
    inputError(
      "PNPM_WORKSPACE_INVALID",
      "catalogs must be an object.",
      "workspace-manifest"
    );
  }
  const entries: CatalogEntry[] = [];
  for (const [catalogName, catalog] of Object.entries(value)) {
    for (const [dependencyName, version] of Object.entries(
      stringRecord(catalog, `catalogs.${catalogName}`, "workspace-manifest")
    )) {
      entries.push({ catalogName, dependencyName, version });
    }
  }
  return entries;
}

function selectedByPatterns(directory: string, patterns: readonly string[]): boolean {
  if (directory === ".") {
    return true;
  }
  const positive = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negative = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  return (
    positive.some((pattern) => posix.matchesGlob(directory, pattern)) &&
    !negative.some((pattern) => posix.matchesGlob(directory, pattern))
  );
}

function assertSafeDirectoryEntry(entry: Dirent): void {
  if (
    entry.name.length === 0 ||
    entry.name === "." ||
    entry.name === ".." ||
    entry.name.includes("/") ||
    entry.name.includes("\\")
  ) {
    inputError(
      "WORKSPACE_GLOB_CANDIDATE_INVALID",
      "Workspace discovery returned an unsafe directory entry.",
      "workspace-discovery"
    );
  }
}

async function readDirectoryEntries(
  absolutePath: string,
  repositoryPath: string,
  budget: { entries: number },
  signal?: AbortSignal
): Promise<readonly Dirent[]> {
  let handle: Awaited<ReturnType<typeof opendir>>;
  try {
    handle = await opendir(absolutePath);
  } catch {
    assertNotCancelled(signal);
    inputError(
      "WORKSPACE_DISCOVERY_UNAVAILABLE",
      `Workspace discovery could not inspect ${repositoryPath}.`,
      "workspace-discovery"
    );
  }
  assertNotCancelled(signal);
  const entries: Dirent[] = [];
  try {
    for await (const entry of handle) {
      assertNotCancelled(signal);
      budget.entries += 1;
      if (budget.entries > MAX_WORKSPACE_DISCOVERY_ENTRIES) {
        inputError(
          "WORKSPACE_DISCOVERY_LIMIT_EXCEEDED",
          `Workspace discovery exceeds ${MAX_WORKSPACE_DISCOVERY_ENTRIES} filesystem entries.`,
          "workspace-discovery"
        );
      }
      assertSafeDirectoryEntry(entry);
      entries.push(entry);
    }
  } finally {
    await handle.close().catch(() => {});
  }
  assertNotCancelled(signal);
  return entries.toSorted((left, right) =>
    compareBinaryStrings(left.name, right.name)
  );
}

function recordSelectedManifest(
  manifests: Set<string>,
  patterns: readonly string[],
  repositoryPath: string
): void {
  const manifestPath = validatedGlobManifestPath(repositoryPath);
  if (!selectedByPatterns(posix.dirname(manifestPath), patterns)) {
    return;
  }
  manifests.add(manifestPath);
  if (manifests.size > MAX_WORKSPACE_PACKAGES) {
    inputError(
      "WORKSPACE_LIMIT_EXCEEDED",
      `Workspace contains more than ${MAX_WORKSPACE_PACKAGES} package manifests.`,
      "workspace-discovery"
    );
  }
}

async function discoverManifestPaths(
  consumerRoot: string,
  patterns: readonly string[],
  signal?: AbortSignal
): Promise<readonly string[]> {
  const manifests = new Set<string>(["package.json"]);
  const directoriesByIdentity = new Map<string, string>();
  const directories: { readonly absolutePath: string; readonly repositoryPath: string }[] = [
    { absolutePath: consumerRoot, repositoryPath: "." }
  ];
  const budget = { entries: 0 };
  while (directories.length > 0) {
    assertNotCancelled(signal);
    const directory = directories.pop();
    if (directory === undefined) {
      break;
    }
    const entries = await readDirectoryEntries(
      directory.absolutePath,
      directory.repositoryPath,
      budget,
      signal
    );
    for (const entry of entries.toReversed()) {
      const repositoryPath = directory.repositoryPath === "."
        ? entry.name
        : posix.join(directory.repositoryPath, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORY_NAMES.has(entry.name)) {
          recordWorkspaceDirectory(directoriesByIdentity, repositoryPath);
          directories.push({
            absolutePath: join(directory.absolutePath, entry.name),
            repositoryPath
          });
        }
      } else if (entry.isFile() && entry.name === "package.json") {
        recordSelectedManifest(manifests, patterns, repositoryPath);
      }
    }
  }
  assertNotCancelled(signal);
  assertPatternDirectoryIdentity(patterns, directoriesByIdentity);
  const manifestPaths = [...manifests].toSorted();
  const caseFoldedPaths = new Map<string, string>();
  for (const manifestPath of manifestPaths) {
    const caseFolded = portablePathIdentity(manifestPath);
    const existing = caseFoldedPaths.get(caseFolded);
    if (existing !== undefined && existing !== manifestPath) {
      inputError(
        "PACKAGE_PATH_CASE_COLLISION",
        `Workspace package paths differ only by letter case: ${existing} and ${manifestPath}.`,
        "workspace-discovery"
      );
    }
    caseFoldedPaths.set(caseFolded, manifestPath);
  }
  return manifestPaths;
}

async function readPnpmWorkspaceInventoryFromManifestPaths(
  consumerRoot: string,
  workspaceManifest: unknown,
  manifestPaths: readonly string[],
  signal?: AbortSignal
): Promise<WorkspaceInventory> {
  if (!isRecord(workspaceManifest)) {
    inputError(
      "PNPM_WORKSPACE_INVALID",
      "pnpm-workspace.yaml must contain an object.",
      "workspace-manifest"
    );
  }
  const containedManifestPaths = manifestPaths.map(validatedGlobManifestPath);
  return {
    ...(typeof workspaceManifest["catalogMode"] === "string"
      ? { catalogMode: workspaceManifest["catalogMode"] }
      : {}),
    catalogs: [
      ...parseCatalog(workspaceManifest, "catalog"),
      ...parseCatalog(workspaceManifest, "catalogs")
    ].toSorted(
      (left, right) =>
        compareBinaryStrings(left.catalogName, right.catalogName) ||
        compareBinaryStrings(left.dependencyName, right.dependencyName)
    ),
    packages: await readPnpmPackageManifestSnapshots(
      consumerRoot,
      containedManifestPaths,
      signal
    )
  };
}

export class PnpmWorkspaceInventoryReader implements WorkspaceInventoryReader {
  discoverManifestPathsFromManifest(
    consumerRoot: string,
    workspaceManifest: unknown,
    signal?: AbortSignal
  ): Promise<readonly string[]> {
    if (!isRecord(workspaceManifest)) {
      inputError(
        "PNPM_WORKSPACE_INVALID",
        "pnpm-workspace.yaml must contain an object.",
        "workspace-manifest"
      );
    }
    return discoverManifestPaths(
      consumerRoot,
      validateWorkspacePatterns(workspaceManifest["packages"]),
      signal
    );
  }

  readFromManifestPaths(
    consumerRoot: string,
    workspaceManifest: unknown,
    manifestPaths: readonly string[],
    signal?: AbortSignal
  ): Promise<WorkspaceInventory> {
    return readPnpmWorkspaceInventoryFromManifestPaths(
      consumerRoot,
      workspaceManifest,
      manifestPaths,
      signal
    );
  }

  async discoverManifestPaths(
    consumerRoot: string,
    workspaceManifestPath: string,
    signal?: AbortSignal
  ): Promise<readonly string[]> {
    const input = await loadStrictYamlFile(
      consumerRoot,
      workspaceManifestPath,
      "workspace-manifest",
      signal
    );
    if (!isRecord(input)) {
      inputError(
        "PNPM_WORKSPACE_INVALID",
        "pnpm-workspace.yaml must contain an object.",
        "workspace-manifest"
      );
    }
    return this.discoverManifestPathsFromManifest(consumerRoot, input, signal);
  }

  async read(
    consumerRoot: string,
    workspaceManifestPath: string,
    signal?: AbortSignal
  ): Promise<WorkspaceInventory> {
    const input = await loadStrictYamlFile(
      consumerRoot,
      workspaceManifestPath,
      "workspace-manifest",
      signal
    );
    if (!isRecord(input)) {
      inputError(
        "PNPM_WORKSPACE_INVALID",
        "pnpm-workspace.yaml must contain an object.",
        "workspace-manifest"
      );
    }
    const manifestPaths = await this.discoverManifestPathsFromManifest(
      consumerRoot,
      input,
      signal
    );
    return readPnpmWorkspaceInventoryFromManifestPaths(
      consumerRoot,
      input,
      manifestPaths,
      signal
    );
  }
}
