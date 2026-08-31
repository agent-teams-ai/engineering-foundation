import type {
  PackageExportEntry,
  PackageExportTarget
} from "../model/workspace-inventory.js";

export type PackageExportCondition = "import" | "require";

export interface ResolvedPackageExport {
  readonly available: boolean;
  readonly targetPath?: string;
}

const INVALID_SEGMENT = /(^|[\\/])((?:[.]|%2e){1,2}|node_modules)(?:[\\/]|$)/iu;
const ENCODED_SEPARATOR = /%2f|%5c/iu;
const MAX_EXPORT_TARGET_DEPTH = 64;
const MAX_EXPORT_TARGET_NODES = 10_000;

function patternKeyCompare(left: string, right: string): number {
  const leftStar = left.indexOf("*");
  const rightStar = right.indexOf("*");
  return rightStar - leftStar || right.length - left.length;
}

export function packageExportMatches(
  entry: PackageExportEntry,
  subpath: string
): boolean {
  if (!entry.subpath.includes("*")) {
    return entry.subpath === subpath;
  }
  const [prefix, suffix] = entry.subpath.split("*");
  return prefix !== undefined && suffix !== undefined &&
    subpath.startsWith(prefix) && subpath.endsWith(suffix) &&
    subpath.length > prefix.length + suffix.length;
}

export function selectedPackageExport(
  entries: readonly PackageExportEntry[],
  subpath: string
): PackageExportEntry | undefined {
  const exact = entries.find(
    (entry) => !entry.subpath.includes("*") && entry.subpath === subpath
  );
  if (exact !== undefined) {
    return exact;
  }
  return entries
    .filter((entry) => entry.subpath.includes("*") && packageExportMatches(entry, subpath))
    .toSorted((left, right) => patternKeyCompare(left.subpath, right.subpath))[0];
}

function targetCapture(entry: PackageExportEntry, subpath: string): string {
  const star = entry.subpath.indexOf("*");
  if (star === -1) {
    return "";
  }
  return subpath.slice(star, subpath.length - (entry.subpath.length - star - 1));
}

type TargetResolution =
  | { readonly kind: "available"; readonly path: string }
  | { readonly kind: "blocked" }
  | { readonly kind: "invalid" }
  | { readonly kind: "undefined" };

function isTargetArray(
  target: PackageExportTarget
): target is readonly PackageExportTarget[] {
  return Array.isArray(target);
}

function resolveStringTarget(target: string, capture: string): TargetResolution {
  if (!target.startsWith("./") || target.includes("\\")) {
    return { kind: "invalid" };
  }
  const substituted = target.replaceAll("*", capture);
  let decodedSubstituted: string;
  let decodedCapture: string;
  try {
    decodedSubstituted = decodeURIComponent(substituted);
    decodedCapture = decodeURIComponent(capture);
  } catch {
    return { kind: "invalid" };
  }
  if (
    INVALID_SEGMENT.test(substituted.slice(2)) ||
    INVALID_SEGMENT.test(capture) ||
    INVALID_SEGMENT.test(decodedSubstituted.slice(2)) ||
    INVALID_SEGMENT.test(decodedCapture) ||
    ENCODED_SEPARATOR.test(substituted)
  ) {
    return { kind: "invalid" };
  }
  let resolved: URL;
  try {
    resolved = new URL(substituted, "file:///package/");
  } catch {
    return { kind: "invalid" };
  }
  if (!resolved.href.startsWith("file:///package/")) {
    return { kind: "invalid" };
  }
  try {
    return {
      kind: "available",
      path: `./${decodeURIComponent(resolved.pathname.slice("/package/".length))}`
    };
  } catch {
    return { kind: "invalid" };
  }
}

function resolveTarget(
  target: PackageExportTarget,
  capture: string,
  conditions: ReadonlySet<string>,
  budget: { nodes: number },
  depth: number
): TargetResolution {
  budget.nodes += 1;
  if (depth > MAX_EXPORT_TARGET_DEPTH || budget.nodes > MAX_EXPORT_TARGET_NODES) {
    return { kind: "invalid" };
  }
  if (typeof target === "string") {
    return resolveStringTarget(target, capture);
  }
  if (target === null) {
    return { kind: "blocked" };
  }
  if (isTargetArray(target)) {
    let last: TargetResolution = { kind: "blocked" };
    for (const candidate of target) {
      const resolved = resolveTarget(candidate, capture, conditions, budget, depth + 1);
      if (resolved.kind === "available") {
        return resolved;
      }
      if (resolved.kind === "undefined") {
        continue;
      }
      last = resolved.kind === "invalid" ? resolved : { kind: "blocked" };
    }
    return last;
  }
  for (const [condition, candidate] of Object.entries(target)) {
    if (condition === "default" || conditions.has(condition)) {
      const resolved = resolveTarget(candidate, capture, conditions, budget, depth + 1);
      if (resolved.kind !== "undefined") {
        return resolved;
      }
    }
  }
  return { kind: "undefined" };
}

export function resolvePackageExport(
  entries: readonly PackageExportEntry[],
  subpath: string,
  condition: PackageExportCondition,
  typeOnly = false
): ResolvedPackageExport {
  const selected = selectedPackageExport(entries, subpath);
  if (selected === undefined) {
    return { available: false };
  }
  if (selected.target === undefined) {
    return { available: selected.availability === "available" };
  }
  const resolved = resolveTarget(
    selected.target,
    targetCapture(selected, subpath),
    typeOnly
      ? new Set([condition, "types", "node"])
      : new Set(["node", "node-addons", "module-sync", condition]),
    { nodes: 0 },
    0
  );
  return resolved.kind === "available"
    ? { available: true, targetPath: resolved.path }
    : { available: false };
}

export function exactAvailablePackageExport(
  entries: readonly PackageExportEntry[],
  subpath: string
): boolean {
  const selected = selectedPackageExport(entries, subpath);
  return selected?.subpath === subpath &&
    (resolvePackageExport(entries, subpath, "import").available ||
      resolvePackageExport(entries, subpath, "require").available);
}

export function exactPackageExportTargetPaths(
  entries: readonly PackageExportEntry[],
  subpath: string
): readonly string[] {
  const selected = selectedPackageExport(entries, subpath);
  if (selected?.subpath !== subpath) {
    return [];
  }
  if (selected.target === undefined) {
    return selected.targetPaths ?? [];
  }
  return [...new Set(
    ([
      ["import", false],
      ["require", false],
      ["import", true],
      ["require", true]
    ] as const)
      .map(([condition, typeOnly]) =>
        resolvePackageExport(entries, subpath, condition, typeOnly).targetPath
      )
      .filter((target): target is string => target !== undefined)
  )];
}
