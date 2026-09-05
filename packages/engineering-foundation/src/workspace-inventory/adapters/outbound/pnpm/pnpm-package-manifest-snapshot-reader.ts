import { realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import {
  assertWorkspaceReadActive,
  workspaceStringRecordRequired,
  workspaceStringValuesRequired,
  packageNamesArrayRequired,
  exportBudgetExceeded,
  invalidExportCondition,
  invalidExportTarget,
  mixedExportSubpaths,
  invalidExportSubpath,
  manifestSymlink,
  manifestUnavailable,
  manifestEscape,
  manifestUnstable,
  manifestObjectRequired
} from "../../../application/policies/workspace-input-failures.js";
import { ContainedFileReadError } from "../../../../source-inventory/api.js";
import { pathTraversesSymbolicLink, readContainedRegularFile } from "../../../../source-inventory/node.js";
import {
  DEPENDENCY_SECTIONS,
  type CatalogEntry,
  type DependencyDeclaration,
  type PackageExportEntry,
  type PackageExportSurface,
  type PackageExportTarget,
  type WorkspacePackage
} from "../../../application/model/workspace-inventory.js";
import { resolvePackageExport } from "../../../application/policies/package-export-matcher.js";
import { normalizeDependencyDeclaration } from "../../../application/policies/normalize-dependency-declaration.js";

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const READ_CONCURRENCY = 32;
const MAX_EXPORT_TARGET_DEPTH = 64;
const MAX_EXPORT_TARGET_NODES = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(
  value: unknown,
  field: string,
  phase: string
): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    workspaceStringRecordRequired(field, phase);
  }
  for (const [name, specifier] of Object.entries(value)) {
    if (name.length === 0 || typeof specifier !== "string" || specifier.length === 0) {
      workspaceStringValuesRequired(field, phase);
    }
  }
  return value as Readonly<Record<string, string>>;
}

function optionalStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    packageNamesArrayRequired(field);
  }
  return value as readonly string[];
}

function normalizedExportTarget(
  value: unknown,
  field: string,
  budget: { nodes: number },
  depth: number
): PackageExportTarget {
  budget.nodes += 1;
  if (depth > MAX_EXPORT_TARGET_DEPTH || budget.nodes > MAX_EXPORT_TARGET_NODES) {
    exportBudgetExceeded(field);
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) =>
      normalizedExportTarget(entry, `${field}[${index}]`, budget, depth + 1)
    ));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (
      entries.some(([condition]) => condition.length === 0 || /^(?:0|[1-9][0-9]*)$/u.test(condition))
    ) {
      invalidExportCondition(field);
    }
    return Object.freeze(Object.fromEntries(entries.map(([condition, target]) => [
      condition,
      normalizedExportTarget(target, `${field}.${condition}`, budget, depth + 1)
    ])));
  }
  invalidExportTarget(field);
}

function retainedTarget(value: unknown, field: string): PackageExportTarget {
  return normalizedExportTarget(value, field, { nodes: 0 }, 0);
}

function packageExportEntry(
  subpath: string,
  value: unknown,
  field: string
): PackageExportEntry {
  const target = retainedTarget(value, field);
  const provisional: PackageExportEntry = {
    subpath,
    availability: "blocked",
    target
  };
  const resolutions = (["import", "require"] as const).map((condition) =>
    resolvePackageExport([provisional], subpath, condition)
  );
  return {
    ...provisional,
    availability: resolutions.some(({ available }) => available)
      ? "available"
      : "blocked",
    targetPaths: Object.freeze(
      [...new Set(
        resolutions
          .map(({ targetPath }) => targetPath)
          .filter((path): path is string => path !== undefined)
      )].toSorted(compareBinaryStrings)
    )
  };
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
      mixedExportSubpaths(manifestPath);
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
          invalidExportSubpath(manifestPath, subpath);
        }
        entries.push(packageExportEntry(
          subpath,
          value[subpath],
          `${manifestPath} exports.${subpath}`
        ));
      }
    } else {
      entries.push(packageExportEntry(".", value, `${manifestPath} exports`));
    }
  } else {
    entries.push(packageExportEntry(".", value, `${manifestPath} exports`));
  }
  return {
    explicit: true,
    ...(value === null ? { selfReferenceDisabled: true as const } : {}),
    entries: entries.toSorted((left, right) =>
      compareBinaryStrings(left.subpath, right.subpath)
    )
  };
}

async function readJsonManifest(
  consumerRoot: string,
  manifestPath: string,
  catalogs: readonly CatalogEntry[],
  signal?: AbortSignal
): Promise<WorkspacePackage> {
  assertWorkspaceReadActive(signal);
  const canonicalRoot = await realpath(consumerRoot);
  const absolutePath = resolve(canonicalRoot, manifestPath);
  if (await pathTraversesSymbolicLink(canonicalRoot, absolutePath)) {
    manifestSymlink(manifestPath);
  }
  const canonicalPath = await realpath(absolutePath).catch(() =>
    manifestUnavailable(manifestPath)
  );
  const relation = relative(canonicalRoot, canonicalPath);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    manifestEscape(manifestPath);
  }
  let input: unknown;
  try {
    const bytes = await readContainedRegularFile({
      candidate: canonicalPath,
      maxBytes: MAX_MANIFEST_BYTES,
      root: canonicalRoot
    });
    input = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof ContainedFileReadError)) {
      throw error;
    }
    manifestUnstable(manifestPath);
  }
  if (!isRecord(input)) {
    manifestObjectRequired(manifestPath);
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
      dependencies.push(normalizeDependencyDeclaration({
        catalogs,
        packageName,
        manifestPath,
        section,
        dependencyName,
        specifier
      }));
    }
  }
  return {
    name: packageName,
    rootPath: posix.dirname(manifestPath),
    manifestPath,
    moduleType: input["type"] === "module" ? "module" : "commonjs",
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

export async function readPnpmPackageManifestSnapshots(
  consumerRoot: string,
  paths: readonly string[],
  catalogs: readonly CatalogEntry[],
  signal?: AbortSignal
): Promise<readonly WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];
  for (let index = 0; index < paths.length; index += READ_CONCURRENCY) {
    packages.push(
      ...(await Promise.all(
        paths
          .slice(index, index + READ_CONCURRENCY)
          .map((path) => readJsonManifest(consumerRoot, path, catalogs, signal))
      ))
    );
  }
  return packages.toSorted((left, right) =>
    compareBinaryStrings(left.manifestPath, right.manifestPath)
  );
}
