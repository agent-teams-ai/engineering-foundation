const DOCUMENT_REPOSITORY_SEGMENT = /^[A-Za-z0-9._@-]+$/u;
const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const utf8 = new TextEncoder();

export function isDocumentRepositoryPath(path: string): boolean {
  if (
    utf8.encode(path).byteLength > 512 ||
    path.startsWith("/") ||
    path.includes("\\")
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) =>
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    utf8.encode(segment).byteLength <= 255 &&
    !segment.endsWith(".") &&
    !segment.endsWith(" ") &&
    !WINDOWS_RESERVED_NAMES.test(segment) &&
    DOCUMENT_REPOSITORY_SEGMENT.test(segment)
  );
}

export function documentRepositoryParentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "." : path.slice(0, separator);
}
