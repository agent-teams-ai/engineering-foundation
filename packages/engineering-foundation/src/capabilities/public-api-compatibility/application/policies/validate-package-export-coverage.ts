import {
  compareCanonicalReferences,
  type PublicApiNonTypeExportKind,
  type PublicApiPackagePolicy
} from "../model/public-api.js";

interface ObservedPackageExport {
  readonly exportPath: string;
  readonly kind: "typed" | PublicApiNonTypeExportKind;
  readonly declarationEntryPoint?: string;
}

const DATA_FILE = /\.(?:json|jsonc|toml|ya?ml|txt)$/u;
const DECLARATION_FILE = /\.d\.(?:ts|mts|cts)$/u;

export class PackageExportCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageExportCoverageError";
  }
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PackageExportCoverageError(`${field} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function normalizedExportPath(value: string, field: string): string {
  if (value === ".") {
    return value;
  }
  const segments = value.startsWith("./") ? value.slice(2).split("/") : [];
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === ".." || segment.includes("\\")
    )
  ) {
    throw new PackageExportCoverageError(
      `${field} must be . or a normalized package export subpath.`
    );
  }
  return value;
}

function stringTargets(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const candidate of value) {
      stringTargets(candidate, output);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const candidate of Object.values(value as Readonly<Record<string, unknown>>)) {
      stringTargets(candidate, output);
    }
  }
}

function typeTargets(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const candidate of value) {
      typeTargets(candidate, output);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [condition, candidate] of Object.entries(
    value as Readonly<Record<string, unknown>>
  )) {
    if (condition === "types" || condition.startsWith("types@")) {
      stringTargets(candidate, output);
    } else {
      typeTargets(candidate, output);
    }
  }
}

function declaredTypeTarget(input: {
  readonly exportPath: string;
  readonly packageTypesFallback: boolean;
  readonly packageRoot: string;
  readonly target: string;
}): string {
  const target =
    input.packageTypesFallback && !input.target.startsWith("./")
      ? `./${input.target}`
      : input.target;
  const segments = target.startsWith("./") ? target.slice(2).split("/") : [];
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    target.includes("\\") ||
    target.includes("*") ||
    !DECLARATION_FILE.test(target)
  ) {
    throw new PackageExportCoverageError(
      `Typed export ${input.exportPath} has an unsupported declaration target: ${target}.`
    );
  }
  return `${input.packageRoot}/${target.slice(2)}`;
}

function resolveExportTargets(input: {
  readonly exportPath: string;
  readonly packageRoot: string;
  readonly packageTypes?: unknown;
  readonly target: unknown;
}): ObservedPackageExport {
  const exportPath = normalizedExportPath(input.exportPath, "package.json exports key");
  const strings: string[] = [];
  const typed: string[] = [];
  stringTargets(input.target, strings);
  typeTargets(input.target, typed);
  const packageTypesFallback =
    exportPath === "." && typed.length === 0 && typeof input.packageTypes === "string";
  if (packageTypesFallback) {
    typed.push(input.packageTypes);
  }
  const typeCandidates = [...new Set(typed)].toSorted(compareCanonicalReferences);
  if (exportPath.includes("*")) {
    if (typeCandidates.length > 0) {
      throw new PackageExportCoverageError(
        `Typed wildcard export ${exportPath} is unsupported; enumerate its concrete subpaths.`
      );
    }
    if (!strings.some((target) => target.includes("*"))) {
      throw new PackageExportCoverageError(
        `Wildcard export ${exportPath} must resolve to a wildcard target.`
      );
    }
    return Object.freeze({ exportPath, kind: "wildcard" });
  }
  if (typeCandidates.length > 1) {
    throw new PackageExportCoverageError(
      `Typed export ${exportPath} has multiple declaration targets.`
    );
  }
  const typeTarget = typeCandidates[0];
  if (typeTarget !== undefined) {
    return Object.freeze({
      exportPath,
      kind: "typed",
      declarationEntryPoint: declaredTypeTarget({
        exportPath,
        packageTypesFallback,
        packageRoot: input.packageRoot,
        target: typeTarget
      })
    });
  }
  const targets = [...new Set(strings)].toSorted(compareCanonicalReferences);
  if (targets.length === 0) {
    throw new PackageExportCoverageError(
      `Export ${exportPath} does not resolve to a supported target.`
    );
  }
  return Object.freeze({
    exportPath,
    kind: targets.every((target) => DATA_FILE.test(target)) ? "data" : "runtime"
  });
}

function packageExportEntries(value: unknown): readonly (readonly [string, unknown])[] {
  if (typeof value === "string" || Array.isArray(value)) {
    return Object.freeze([[".", value]]);
  }
  const exports = record(value, "package.json exports");
  const keys = Object.keys(exports);
  if (keys.length === 0) {
    throw new PackageExportCoverageError("package.json exports must not be empty.");
  }
  const subpathKeys = keys.filter((key) => key.startsWith("."));
  if (subpathKeys.length === 0) {
    return Object.freeze([[".", exports]]);
  }
  if (subpathKeys.length !== keys.length) {
    throw new PackageExportCoverageError(
      "package.json exports cannot mix subpath keys with conditional keys."
    );
  }
  return Object.freeze(
    subpathKeys
      .toSorted(compareCanonicalReferences)
      .map((key) => [key, exports[key]] as const)
  );
}

function observedExports(input: {
  readonly manifest: unknown;
  readonly policy: PublicApiPackagePolicy;
}): readonly ObservedPackageExport[] {
  const manifest = record(input.manifest, "package manifest");
  if (!("exports" in manifest)) {
    throw new PackageExportCoverageError(
      `Package ${input.policy.packageName} must declare package.json exports.`
    );
  }
  const packageTypes = manifest["types"] ?? manifest["typings"];
  const exports = packageExportEntries(manifest["exports"])
    .map(([exportPath, target]) =>
      resolveExportTargets({
        exportPath,
        packageRoot: input.policy.packageRoot,
        packageTypes,
        target
      })
    )
    .toSorted((left, right) =>
      compareCanonicalReferences(left.exportPath, right.exportPath)
    );
  if (
    exports.some(
      (entrypoint, index) =>
        index > 0 && exports[index - 1]?.exportPath === entrypoint.exportPath
    )
  ) {
    throw new PackageExportCoverageError("package.json exports contains duplicate export paths.");
  }
  return Object.freeze(exports);
}

function mapByPath<T extends { readonly exportPath: string }>(
  entries: readonly T[],
  kind: string
): ReadonlyMap<string, T> {
  const output = new Map<string, T>();
  for (const entry of entries) {
    if (output.has(entry.exportPath)) {
      throw new PackageExportCoverageError(`${kind} contains duplicate export path ${entry.exportPath}.`);
    }
    output.set(entry.exportPath, entry);
  }
  return output;
}

function mismatch(
  kind: string,
  expected: ReadonlySet<string>,
  actual: ReadonlySet<string>
): void {
  const missing = [...expected].filter((value) => !actual.has(value)).toSorted(compareCanonicalReferences);
  const unexpected = [...actual]
    .filter((value) => !expected.has(value))
    .toSorted(compareCanonicalReferences);
  if (missing.length > 0 || unexpected.length > 0) {
    throw new PackageExportCoverageError(
      `${kind} does not exactly cover package.json exports. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`
    );
  }
}

/**
 * The policy is a closed-world declaration of the package export map. Every
 * typed subpath gets an independently baselined declaration entry point; all
 * other public paths need an explicit, narrow classification.
 */
export function assertPackageExportCoverage(input: {
  readonly manifest: unknown;
  readonly policy: PublicApiPackagePolicy;
}): void {
  if (!("entrypoints" in input.policy)) {
    return;
  }
  const observed = observedExports(input);
  const observedTyped = mapByPath(
    observed.filter((entry) => entry.kind === "typed"),
    "package.json typed exports"
  );
  const observedNonType = mapByPath(
    observed.filter((entry) => entry.kind !== "typed"),
    "package.json non-type exports"
  );
  const configuredTyped = mapByPath(input.policy.entrypoints, "configured typed exports");
  const configuredNonType = mapByPath(
    input.policy.nonTypeExports,
    "configured non-type exports"
  );
  mismatch(
    "Typed export configuration",
    new Set(observedTyped.keys()),
    new Set(configuredTyped.keys())
  );
  mismatch(
    "Non-type export configuration",
    new Set(observedNonType.keys()),
    new Set(configuredNonType.keys())
  );
  for (const [exportPath, observedEntrypoint] of observedTyped) {
    const configured = configuredTyped.get(exportPath);
    if (
      configured === undefined ||
      configured.declarationEntryPoint !== observedEntrypoint.declarationEntryPoint
    ) {
      throw new PackageExportCoverageError(
        `Typed export ${exportPath} must use declaration entry point ${observedEntrypoint.declarationEntryPoint}.`
      );
    }
  }
  for (const [exportPath, observedExport] of observedNonType) {
    const configured = configuredNonType.get(exportPath);
    if (configured === undefined || configured.kind !== observedExport.kind) {
      throw new PackageExportCoverageError(
        `Non-type export ${exportPath} must be classified as ${observedExport.kind}.`
      );
    }
  }
}
