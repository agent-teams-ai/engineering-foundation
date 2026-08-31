import type { PackageExportEntry } from "../model/workspace-inventory.js";

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

export function exactAvailablePackageExport(
  entries: readonly PackageExportEntry[],
  subpath: string
): boolean {
  const selected = selectedPackageExport(entries, subpath);
  return selected?.subpath === subpath && selected.availability === "available";
}
