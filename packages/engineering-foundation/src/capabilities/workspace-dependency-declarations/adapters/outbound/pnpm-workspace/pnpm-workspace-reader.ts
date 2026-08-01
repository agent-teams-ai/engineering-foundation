import { glob, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

import { CapabilityInputError } from "../../../../../capability-runtime.js";
import {
  assertNotCancelled,
  loadStrictYamlFile
} from "../../../../../strict-yaml.js";
import type {
  CatalogEntry,
  DependencyDeclaration,
  WorkspacePackage,
  WorkspaceSnapshot
} from "../../../application/model/workspace-snapshot.js";
import { DEPENDENCY_SECTIONS } from "../../../application/model/workspace-snapshot.js";
import type { WorkspaceReader } from "../../../application/ports/workspace-reader.js";

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_PACKAGES = 5_000;
const READ_CONCURRENCY = 32;
const IGNORED_GLOBS = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/coverage/**"
];

function inputError(code: string, message: string, phase: string): never {
  throw new CapabilityInputError({ code, message, phase, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
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

function optionalStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    inputError(
      "PACKAGE_MANIFEST_INVALID",
      `${field} must be an array of package names.`,
      "package-manifest"
    );
  }
  return value as readonly string[];
}

async function readJsonManifest(
  consumerRoot: string,
  manifestPath: string,
  signal?: AbortSignal
): Promise<WorkspacePackage> {
  assertNotCancelled(signal);
  const canonicalRoot = await realpath(consumerRoot);
  const absolutePath = resolve(canonicalRoot, manifestPath);
  const canonicalPath = await realpath(absolutePath).catch(() =>
    inputError(
      "PACKAGE_MANIFEST_UNAVAILABLE",
      `Workspace package manifest is unavailable: ${manifestPath}.`,
      "package-manifest"
    )
  );
  const relation = relative(canonicalRoot, canonicalPath);
  if (
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    inputError(
      "PACKAGE_MANIFEST_ESCAPE",
      `Workspace package manifest escapes the consumer repository: ${manifestPath}.`,
      "package-manifest"
    );
  }
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) {
    inputError(
      "PACKAGE_MANIFEST_INVALID",
      `Workspace package manifest must be a regular file no larger than ${MAX_MANIFEST_BYTES} bytes: ${manifestPath}.`,
      "package-manifest"
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(await readFile(canonicalPath, "utf8")) as unknown;
  } catch {
    inputError(
      "PACKAGE_MANIFEST_INVALID",
      `Workspace package manifest is not valid JSON: ${manifestPath}.`,
      "package-manifest"
    );
  }
  if (!isRecord(input)) {
    inputError(
      "PACKAGE_MANIFEST_INVALID",
      `Workspace package manifest must contain an object: ${manifestPath}.`,
      "package-manifest"
    );
  }

  const packageName =
    typeof input.name === "string" && input.name.length > 0
      ? input.name
      : `<unnamed:${manifestPath}>`;
  const dependencies: DependencyDeclaration[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    if (input[section] === undefined) {
      continue;
    }
    const declarations = stringRecord(
      input[section],
      `${manifestPath} ${section}`,
      "package-manifest"
    );
    for (const [dependencyName, specifier] of Object.entries(declarations)) {
      dependencies.push({
        packageName,
        manifestPath,
        section,
        dependencyName,
        specifier
      });
    }
  }
  const bundledDependencies = [
    ...optionalStringArray(input.bundleDependencies, `${manifestPath} bundleDependencies`),
    ...optionalStringArray(input.bundledDependencies, `${manifestPath} bundledDependencies`)
  ].toSorted();
  return {
    name: packageName,
    manifestPath,
    ...(typeof input.packageManager === "string"
      ? { packageManager: input.packageManager }
      : {}),
    dependencies: dependencies.toSorted(compareDeclarations),
    bundledDependencies
  };
}

function compareDeclarations(
  left: DependencyDeclaration,
  right: DependencyDeclaration
): number {
  return (
    left.dependencyName.localeCompare(right.dependencyName) ||
    left.section.localeCompare(right.section)
  );
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
    inputError("PNPM_WORKSPACE_INVALID", "catalogs must be an object.", "workspace-manifest");
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

async function discoverManifestPaths(
  consumerRoot: string,
  patterns: readonly string[],
  signal?: AbortSignal
): Promise<readonly string[]> {
  const manifests = new Set<string>(["package.json"]);
  for await (const candidate of glob("**/package.json", {
    cwd: consumerRoot,
    exclude: IGNORED_GLOBS
  })) {
    assertNotCancelled(signal);
    const manifestPath = toPosixPath(candidate);
    const directory = posix.dirname(manifestPath);
    if (selectedByPatterns(directory, patterns)) {
      manifests.add(manifestPath);
      if (manifests.size > MAX_WORKSPACE_PACKAGES) {
        inputError(
          "WORKSPACE_LIMIT_EXCEEDED",
          `Workspace contains more than ${MAX_WORKSPACE_PACKAGES} package manifests.`,
          "workspace-discovery"
        );
      }
    }
  }
  return [...manifests].toSorted();
}

async function readManifestBatch(
  consumerRoot: string,
  paths: readonly string[],
  signal?: AbortSignal
): Promise<readonly WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];
  for (let index = 0; index < paths.length; index += READ_CONCURRENCY) {
    const batch = paths.slice(index, index + READ_CONCURRENCY);
    packages.push(
      ...(await Promise.all(
        batch.map((path) => readJsonManifest(consumerRoot, path, signal))
      ))
    );
  }
  return packages.toSorted((left, right) =>
    left.manifestPath.localeCompare(right.manifestPath)
  );
}

export class PnpmWorkspaceReader implements WorkspaceReader {
  async read(
    consumerRoot: string,
    workspaceManifestPath: string,
    signal?: AbortSignal
  ): Promise<WorkspaceSnapshot> {
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
    const patterns = validateWorkspacePatterns(input.packages);
    const manifestPaths = await discoverManifestPaths(consumerRoot, patterns, signal);
    return {
      ...(typeof input.catalogMode === "string" ? { catalogMode: input.catalogMode } : {}),
      catalogs: [
        ...parseCatalog(input, "catalog"),
        ...parseCatalog(input, "catalogs")
      ].toSorted((left, right) =>
        left.catalogName.localeCompare(right.catalogName) ||
        left.dependencyName.localeCompare(right.dependencyName)
      ),
      packages: await readManifestBatch(consumerRoot, manifestPaths, signal)
    };
  }
}
