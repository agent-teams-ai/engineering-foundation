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

/**
 * Identity used by opt-in portable v2 checks. Callers on the v1 execution path
 * deliberately retain the original case-sensitive path semantics.
 */
export function portableRepositoryPathIdentity(path: string): string {
  return normalizeRepositoryPath(path)
    .normalize("NFC")
    .toLocaleLowerCase("en-US");
}

const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function isRejectedControlCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x00 && codePoint <= 0x1f) || codePoint === 0x7f;
}

function containsRejectedControlCodePoint(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isRejectedControlCodePoint(codePoint)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns why a repository-relative path cannot have one stable identity on
 * every supported host. This is deliberately independent of the host running
 * the check: Linux must reject names that Windows would alias or reinterpret.
 */
export function portableRepositoryPathProblem(path: string): string | undefined {
  if (path === ".") {
    return undefined;
  }
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("//") ||
    path.startsWith("\\\\") ||
    /^[A-Za-z]:/u.test(path) ||
    path.includes("\\") ||
    path.includes(":") ||
    containsRejectedControlCodePoint(path) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        /[<>"|?*]/u.test(segment) ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        WINDOWS_RESERVED_SEGMENT.test(segment)
    ) ||
    normalizeRepositoryPath(path) !== path
  ) {
    return "path is not a normalized portable repository-relative path";
  }
  return undefined;
}

export function portablePathIsInside(path: string, root: string): boolean {
  const pathIdentity = portableRepositoryPathIdentity(path);
  const rootIdentity = portableRepositoryPathIdentity(root);
  return (
    rootIdentity === "." ||
    pathIdentity === rootIdentity ||
    pathIdentity.startsWith(`${rootIdentity}/`)
  );
}
