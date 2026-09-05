import type {
  CatalogEntry,
  DependencyDeclaration,
  DependencySection
} from "../model/workspace-inventory.js";

const NPM_PACKAGE_NAME =
  "(?:@[a-z0-9][a-z0-9._-]*\\/)?[a-z0-9][a-z0-9._-]*";
const NPM_ALIAS = new RegExp(`^npm:(${NPM_PACKAGE_NAME})@(.+)$`, "su");
// Registry syntax only: this does not resolve ranges or relax exact-pin policy.
const RANGE_VERSION = /^[v=\s]*(\d+|[xX*])(?:\.(\d+|[xX*])(?:\.(\d+|[xX*])(?:-?[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)?)?$/u;

function isRangeVersion(value: string): boolean {
  if (value.length > 256) {
    return false;
  }
  const match = RANGE_VERSION.exec(value);
  return match !== null &&
    [match[1], match[2], match[3]].every((part) =>
      part === undefined || /^[xX*]$/u.test(part) ||
      Number.isSafeInteger(Number(part))
    );
}

function isRangeSet(value: string): boolean {
  const hyphen = value.split(/\s+-\s+/u);
  if (hyphen.length === 2) {
    return hyphen.every(isRangeVersion);
  }
  const comparators = value.replace(/([<>=~^v])\s+/gu, "$1").split(/\s+/u);
  return comparators.every((part) =>
    part === "" || isRangeVersion(part.replace(/^(?:[<>]=?|~>?|\^|=)/u, ""))
  );
}

function isRegistrySpecifier(value: string): boolean {
  // Local paths/archives must not be mistaken for URI-safe registry tags.
  if (/^[.]|[.](?:tgz|tar[.]gz|tar)$/iu.test(value)) {
    return false;
  }
  const trimmed = value.trim();
  return /^[0-9A-Za-z_~!()*'.-]+$/u.test(trimmed) ||
    trimmed.split("||").every((part) => isRangeSet(part.trim()));
}

export function parseNpmAlias(specifier: string): {
  readonly targetPackageName: string;
  readonly versionSpecifier: string;
} | undefined {
  const match = NPM_ALIAS.exec(specifier);
  return match?.[1] !== undefined && match[2] !== undefined &&
    isRegistrySpecifier(match[2])
    ? { targetPackageName: match[1], versionSpecifier: match[2] }
    : undefined;
}

function referencedCatalogName(specifier: string): string | undefined {
  if (specifier === "catalog:") {
    return "default";
  }
  return specifier.startsWith("catalog:") && specifier.length > "catalog:".length
    ? specifier.slice("catalog:".length)
    : undefined;
}

function effectiveDeclaration(input: {
  readonly catalogs: readonly CatalogEntry[];
  readonly dependencyName: string;
  readonly specifier: string;
}): {
  readonly effectiveSpecifier: string;
  readonly provenance: DependencyDeclaration["provenance"];
} {
  const catalogName = referencedCatalogName(input.specifier);
  if (catalogName === undefined) {
    return {
      effectiveSpecifier: input.specifier,
      provenance: Object.freeze({ kind: "manifest" })
    };
  }
  const catalogs = input.catalogs.filter(
    (entry) =>
      entry.catalogName === catalogName &&
      entry.dependencyName === input.dependencyName
  );
  if (catalogs.length > 1) {
    throw new TypeError(`Catalog ${catalogName} declares ${input.dependencyName} more than once.`);
  }
  return {
    effectiveSpecifier: catalogs[0]?.version ?? input.specifier,
    provenance: Object.freeze({ kind: "catalog", catalogName })
  };
}

export function normalizeDependencyDeclaration(input: {
  readonly catalogs: readonly CatalogEntry[];
  readonly dependencyName: string;
  readonly manifestPath: string;
  readonly packageName: string;
  readonly section: DependencySection;
  readonly specifier: string;
}): DependencyDeclaration {
  const effective = effectiveDeclaration(input);
  const alias = parseNpmAlias(effective.effectiveSpecifier);
  return Object.freeze({
    packageName: input.packageName,
    manifestPath: input.manifestPath,
    section: input.section,
    dependencyName: input.dependencyName,
    specifier: input.specifier,
    targetPackageName: alias?.targetPackageName ?? input.dependencyName,
    effectiveVersionSpecifier: alias?.versionSpecifier ?? effective.effectiveSpecifier,
    effectiveSpecifier: effective.effectiveSpecifier,
    ...(effective.effectiveSpecifier.startsWith("npm:") && alias === undefined
      ? { normalizationProblem: "invalid-npm-alias" as const }
      : {}),
    provenance: effective.provenance
  });
}
