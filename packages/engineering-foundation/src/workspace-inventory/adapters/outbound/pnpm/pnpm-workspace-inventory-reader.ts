import { glob, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import { CapabilityInputError } from "../../../../capability-runtime.js";
import { pathTraversesSymbolicLink } from "../../../../filesystem-path-safety.js";
import {
  assertNotCancelled,
  loadStrictYamlFile
} from "../../../../strict-yaml.js";
import type {
  CatalogEntry,
  DependencyDeclaration,
  PackageExportEntry,
  PackageExportSurface,
  WorkspaceInventory,
  WorkspacePackage
} from "../../../application/model/workspace-inventory.js";
import { DEPENDENCY_SECTIONS } from "../../../application/model/workspace-inventory.js";
import type { WorkspaceInventoryReader } from "../../../application/ports/workspace-inventory-reader.js";

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

function portablePathIdentity(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
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

function targetAvailability(value: unknown, field: string): "available" | "blocked" {
  if (value === null) {
    return "blocked";
  }
  if (typeof value === "string") {
    return "available";
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      inputError(
        "PACKAGE_EXPORTS_INVALID",
        `${field} export target array cannot be empty.`,
        "package-manifest"
      );
    }
    return value.some((entry) => targetAvailability(entry, field) === "available")
      ? "available"
      : "blocked";
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0 || entries.some(([condition]) => condition.length === 0)) {
      inputError(
        "PACKAGE_EXPORTS_INVALID",
        `${field} conditional export target is invalid.`,
        "package-manifest"
      );
    }
    return entries.some(
      ([condition, target]) =>
        condition !== "" && targetAvailability(target, `${field}.${condition}`) === "available"
    )
      ? "available"
      : "blocked";
  }
  inputError(
    "PACKAGE_EXPORTS_INVALID",
    `${field} export target must be a string, null, array, or condition object.`,
    "package-manifest"
  );
}

function normalizeExportSurface(value: unknown, manifestPath: string): PackageExportSurface {
  if (value === undefined) {
    return { explicit: false, entries: [] };
  }
  const entries: PackageExportEntry[] = [];
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return { explicit: true, entries: [] };
    }
    const subpathKeys = keys.filter((key) => key.startsWith("."));
    if (subpathKeys.length > 0 && subpathKeys.length !== keys.length) {
      inputError(
        "PACKAGE_EXPORTS_INVALID",
        `${manifestPath} exports cannot mix subpaths and conditions at the same level.`,
        "package-manifest"
      );
    }
    if (subpathKeys.length > 0) {
      for (const subpath of subpathKeys) {
        const segments = subpath.split("/");
        if (
          (subpath !== "." && !subpath.startsWith("./")) ||
          subpath.includes("\\") ||
          (subpath.match(/\*/gu)?.length ?? 0) > 1 ||
          segments.some(
            (segment, index) =>
              index > 0 &&
              (segment === "" || segment === "." || segment === ".." || segment === "node_modules")
          )
        ) {
          inputError(
            "PACKAGE_EXPORTS_INVALID",
            `${manifestPath} contains an invalid export subpath: ${subpath}.`,
            "package-manifest"
          );
        }
        entries.push({
          subpath,
          availability: targetAvailability(value[subpath], `${manifestPath} exports.${subpath}`)
        });
      }
    } else {
      entries.push({
        subpath: ".",
        availability: targetAvailability(value, `${manifestPath} exports`)
      });
    }
  } else {
    entries.push({
      subpath: ".",
      availability: targetAvailability(value, `${manifestPath} exports`)
    });
  }
  return {
    explicit: true,
    entries: entries.toSorted((left, right) =>
      compareBinaryStrings(left.subpath, right.subpath)
    )
  };
}

async function readJsonManifest(
  consumerRoot: string,
  manifestPath: string,
  signal?: AbortSignal
): Promise<WorkspacePackage> {
  assertNotCancelled(signal);
  const canonicalRoot = await realpath(consumerRoot);
  const absolutePath = resolve(canonicalRoot, manifestPath);
  if (await pathTraversesSymbolicLink(canonicalRoot, absolutePath)) {
    inputError(
      "PACKAGE_MANIFEST_SYMLINK_PROHIBITED",
      `Workspace package manifests cannot be symbolic links: ${manifestPath}.`,
      "package-manifest"
    );
  }
  const canonicalPath = await realpath(absolutePath).catch(() =>
    inputError(
      "PACKAGE_MANIFEST_UNAVAILABLE",
      `Workspace package manifest is unavailable: ${manifestPath}.`,
      "package-manifest"
    )
  );
  const relation = relative(canonicalRoot, canonicalPath);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
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
    typeof input["name"] === "string" && input["name"].length > 0
      ? input["name"]
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
  return {
    name: packageName,
    rootPath: posix.dirname(manifestPath),
    manifestPath,
    ...(typeof input["packageManager"] === "string"
      ? { packageManager: input["packageManager"] }
      : {}),
    dependencies: dependencies.toSorted(
      (left, right) =>
        compareBinaryStrings(left.dependencyName, right.dependencyName) ||
        compareBinaryStrings(left.section, right.section)
    ),
    bundledDependencies: [
      ...optionalStringArray(
        input["bundleDependencies"],
        `${manifestPath} bundleDependencies`
      ),
      ...optionalStringArray(
        input["bundledDependencies"],
        `${manifestPath} bundledDependencies`
      )
    ].toSorted(),
    exportSurface: normalizeExportSurface(input["exports"], manifestPath)
  };
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
    if (selectedByPatterns(posix.dirname(manifestPath), patterns)) {
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

async function readManifestBatch(
  consumerRoot: string,
  paths: readonly string[],
  signal?: AbortSignal
): Promise<readonly WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];
  for (let index = 0; index < paths.length; index += READ_CONCURRENCY) {
    packages.push(
      ...(await Promise.all(
        paths
          .slice(index, index + READ_CONCURRENCY)
          .map((path) => readJsonManifest(consumerRoot, path, signal))
      ))
    );
  }
  return packages.toSorted((left, right) =>
    compareBinaryStrings(left.manifestPath, right.manifestPath)
  );
}

export class PnpmWorkspaceInventoryReader implements WorkspaceInventoryReader {
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
    return discoverManifestPaths(
      consumerRoot,
      validateWorkspacePatterns(input["packages"]),
      signal
    );
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
    const patterns = validateWorkspacePatterns(input["packages"]);
    const manifestPaths = await discoverManifestPaths(consumerRoot, patterns, signal);
    return {
      ...(typeof input["catalogMode"] === "string"
        ? { catalogMode: input["catalogMode"] }
        : {}),
      catalogs: [
        ...parseCatalog(input, "catalog"),
        ...parseCatalog(input, "catalogs")
      ].toSorted(
        (left, right) =>
          compareBinaryStrings(left.catalogName, right.catalogName) ||
          compareBinaryStrings(left.dependencyName, right.dependencyName)
      ),
      packages: await readManifestBatch(consumerRoot, manifestPaths, signal)
    };
  }
}
