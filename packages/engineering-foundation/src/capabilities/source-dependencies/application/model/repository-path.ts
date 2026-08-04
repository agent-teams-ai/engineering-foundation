export function normalizeRepositoryPath(path: string): string {
  const portable = path.replaceAll("\\", "/");
  const absolute = portable.startsWith("/");
  const segments: string[] = [];
  for (const segment of portable.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === ".." && segments.at(-1) !== "..") {
      if (segments.length > 0) {
        segments.pop();
      } else if (!absolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }
  const normalized = segments.join("/");
  if (absolute) {
    return `/${normalized}`;
  }
  return normalized.length === 0 ? "." : normalized;
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
