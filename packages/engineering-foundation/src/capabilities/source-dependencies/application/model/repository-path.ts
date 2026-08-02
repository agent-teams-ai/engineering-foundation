import { posix } from "node:path";

/**
 * Source inventory emits POSIX paths even on Windows. This defensive
 * normalization keeps adapter and test evidence portable before graph keys are
 * formed.
 */
export function normalizeRepositoryPath(path: string): string {
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

export function pathIsInside(path: string, root: string): boolean {
  const normalizedPath = normalizeRepositoryPath(path);
  const normalizedRoot = normalizeRepositoryPath(root);
  return (
    normalizedRoot === "." ||
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  );
}
