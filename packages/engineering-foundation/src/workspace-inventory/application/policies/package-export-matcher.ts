import type { PackageExportEntry } from "../model/workspace-inventory.js";

export function packageExportMatches(
  entry: PackageExportEntry,
  subpath: string
): boolean {
  if (!entry.subpath.includes("*")) return entry.subpath === subpath;
  const [prefix, suffix] = entry.subpath.split("*");
  return prefix !== undefined && suffix !== undefined &&
    subpath.startsWith(prefix) && subpath.endsWith(suffix) &&
    subpath.length >= prefix.length + suffix.length;
}

export function exactAvailablePackageExport(
  entries: readonly PackageExportEntry[],
  subpath: string
): boolean {
  return entries.some(
    (entry) => entry.subpath === subpath && entry.availability === "available"
  );
}
