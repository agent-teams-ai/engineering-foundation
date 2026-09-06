import type { PublicApiArtifactSnapshot, PublicApiChangeSet } from "../model/public-api.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import { artifactApiProjection } from "./artifact-api-projection.js";
import { classifyPublicApiChange } from "./evaluate-public-api-compatibility.js";

export function comparePackageArtifactInventory(
  released: PublicApiArtifactSnapshot,
  current: PublicApiArtifactSnapshot,
  fingerprint: ChangeFingerprint
): PublicApiChangeSet {
  return classifyPublicApiChange(
    artifactApiProjection(released), artifactApiProjection(current), fingerprint
  );
}

function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Match the portable identities required by the release archive inspector. */
export function artifactPathIdentity(path: string): string {
  const segments = path.split("/");
  if (segments.some((part) => part === "" || part === "." || part === ".." ||
      /[\p{Cc}<>:"|?*\\%#\s]/u.test(part) || /[. ]$/u.test(part) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/u.test(part.normalize("NFKC").toUpperCase()) ||
      part.normalize("NFKC").toUpperCase() === "NODE_MODULES")) {
    throw new Error(`Artifact member is not a portable package path: ${path}.`);
  }
  return segments.map((part) => part.normalize("NFKC").toUpperCase()).join("/");
}

export function wildcardExpression(pattern: string): RegExp {
  const segments = pattern.split("/");
  if (pattern.split("*").length !== 2 || pattern.includes("\\") ||
      segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment === "node_modules") ||
      /[\p{Cc}\s%?#]/u.test(pattern)) {
    throw new Error(`Artifact wildcard target must be a normalized package path with one *: ${pattern}.`);
  }
  const [prefix, suffix] = pattern.split("*");
  artifactPathIdentity(pattern.replace("*", "artifact"));
  return new RegExp(`^${escapeExpression(prefix ?? "")}(.+)${escapeExpression(suffix ?? "")}$`, "u");
}

/** Archive paths are normalized package-relative regular-file names from the tar inspector. */
export function assertPackedWildcardMembers(input: {
  readonly actualArtifactPaths: readonly string[];
  readonly expected: Pick<PublicApiArtifactSnapshot, "wildcardExports">;
}): void {
  const actual = new Set(input.actualArtifactPaths);
  for (const wildcard of input.expected.wildcardExports) {
    const expression = wildcardExpression(wildcard.targetPattern);
    for (const member of wildcard.members) {
      if (!expression.test(member) || !actual.has(member)) {
        throw new Error(
          `Packed artifact is missing wildcard export member ${wildcard.exportPath} -> ${member}.`
        );
      }
    }
  }
}
