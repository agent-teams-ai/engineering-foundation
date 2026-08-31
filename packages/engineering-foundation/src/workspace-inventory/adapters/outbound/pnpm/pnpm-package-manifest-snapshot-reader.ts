import { realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import { CapabilityInputError } from "../../../../capability-runtime.js";
import {
  ContainedFileReadError,
  pathTraversesSymbolicLink,
  readContainedRegularFile
} from "../../../../filesystem-path-safety.js";
import { assertNotCancelled } from "../../../../strict-yaml.js";
import type {
  DependencyDeclaration,
  PackageExportEntry,
  PackageExportSurface,
  WorkspacePackage
} from "../../../application/model/workspace-inventory.js";
import { DEPENDENCY_SECTIONS } from "../../../application/model/workspace-inventory.js";

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const READ_CONCURRENCY = 32;

function inputError(code: string, message: string, phase: string): never {
  throw new CapabilityInputError({ code, message, phase, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function exportTargetPaths(value: unknown): readonly string[] {
  if (typeof value === "string") return value.startsWith("./") ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(exportTargetPaths);
  if (isRecord(value)) return Object.values(value).flatMap(exportTargetPaths);
  return [];
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
          availability: targetAvailability(value[subpath], `${manifestPath} exports.${subpath}`),
          targetPaths: Object.freeze(exportTargetPaths(value[subpath]).toSorted(compareBinaryStrings))
        });
      }
    } else {
      entries.push({
        subpath: ".",
        availability: targetAvailability(value, `${manifestPath} exports`),
        targetPaths: Object.freeze(exportTargetPaths(value).toSorted(compareBinaryStrings))
      });
    }
  } else {
    entries.push({
      subpath: ".",
      availability: targetAvailability(value, `${manifestPath} exports`),
      targetPaths: Object.freeze(exportTargetPaths(value).toSorted(compareBinaryStrings))
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
    inputError(
      "PACKAGE_MANIFEST_INVALID",
      `Workspace package manifest changed, escaped containment, or is not stable valid JSON: ${manifestPath}.`,
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

export async function readPnpmPackageManifestSnapshots(
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
