import type { PortableRepositoryPathProblem } from "@agent-teams/repository-mutation";

const WINDOWS_RESERVED_NAMES = new Set([
  "AUX",
  "CON",
  "NUL",
  "PRN",
  ...Array.from({ length: 9 }, (_unused, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `LPT${index + 1}`)
]);

function isPortableAbsolutePath(repositoryPath: string): boolean {
  return (
    repositoryPath.startsWith("/") ||
    repositoryPath.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/u.test(repositoryPath)
  );
}

/** Preserves the published scaffolding v1 path contract exactly. */
export function legacyScaffoldingRepositoryPathProblem(
  repositoryPath: string
): PortableRepositoryPathProblem | undefined {
  if (repositoryPath.length > 512) {
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
    if (segment.length > 255) {
      return "segment-too-long";
    }
    if (segment.endsWith(".")) {
      return "trailing-dot";
    }
    if (
      Array.from(segment).some(
        (character) => (character.codePointAt(0) ?? 0) < 32
      )
    ) {
      return "control-character";
    }
    if (
      WINDOWS_RESERVED_NAMES.has((segment.split(".")[0] ?? "").toUpperCase())
    ) {
      return "reserved-name";
    }
  }
  return undefined;
}
