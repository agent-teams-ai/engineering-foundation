const WINDOWS_RESERVED_NAMES = new Set([
  "AUX",
  "CON",
  "NUL",
  "PRN",
  ...Array.from({ length: 9 }, (_unused, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `LPT${index + 1}`)
]);

export type PortableRepositoryPathProblem =
  | "absolute"
  | "backslash"
  | "control-character"
  | "empty-segment"
  | "invalid-character"
  | "invalid-segment"
  | "path-too-long"
  | "reserved-name"
  | "segment-too-long"
  | "trailing-dot"
  | "trailing-space";

const PORTABLE_SEGMENT = /^[A-Za-z0-9._@+-]+$/u;

function isPortableAbsolutePath(repositoryPath: string): boolean {
  return (
    repositoryPath.startsWith("/") ||
    repositoryPath.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/u.test(repositoryPath)
  );
}

export function portableRepositoryPathProblem(
  repositoryPath: string
): PortableRepositoryPathProblem | undefined {
  if (
    repositoryPath.length > 512 ||
    new TextEncoder().encode(repositoryPath).byteLength > 512
  ) {
    return "path-too-long";
  }
  if (isPortableAbsolutePath(repositoryPath)) {
    return "absolute";
  }
  if (repositoryPath.includes("\\")) {
    return "backslash";
  }
  const segments = repositoryPath.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      return "empty-segment";
    }
    if (segment === "." || segment === "..") {
      return "invalid-segment";
    }
    if (
      segment.length > 255 ||
      new TextEncoder().encode(segment).byteLength > 255
    ) {
      return "segment-too-long";
    }
    if (segment.endsWith(".")) {
      return "trailing-dot";
    }
    if (segment.endsWith(" ")) {
      return "trailing-space";
    }
    if (
      Array.from(segment).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 32 || codePoint === 127;
      })
    ) {
      return "control-character";
    }
    if (WINDOWS_RESERVED_NAMES.has((segment.split(".")[0] ?? "").toUpperCase())) {
      return "reserved-name";
    }
    if (!PORTABLE_SEGMENT.test(segment)) {
      return "invalid-character";
    }
  }
  return undefined;
}

export function portableRepositoryPathIdentity(repositoryPath: string): string {
  return repositoryPath.normalize("NFC").toLowerCase();
}

export function findPortableRepositoryPathCollision(
  repositoryPaths: readonly string[]
): { readonly first: string; readonly second: string } | undefined {
  const observed = new Map<string, string>();
  for (const repositoryPath of repositoryPaths) {
    const identity = portableRepositoryPathIdentity(repositoryPath);
    const first = observed.get(identity);
    if (first !== undefined) {
      return { first, second: repositoryPath };
    }
    observed.set(identity, repositoryPath);
  }
  return undefined;
}
