import { isDocumentRepositoryPath } from "./document-repository-path.js";

interface PlacementSemantics {
  readonly allowedRoots?: readonly string[];
  readonly kind: string;
  readonly filename?: string;
  readonly minimumSegmentsAfterRequired?: number;
  readonly minimumSegmentsBeforeRequired?: number;
  readonly requiredBasename?: string;
  readonly requiredSegmentsInOrder?: readonly string[];
  readonly root?: string;
}

interface ArtifactTypeSemantics {
  readonly identity?: {
    readonly format?: string;
    readonly grammar?: {
      readonly maxSuffixSegments: number;
      readonly minSuffixSegments: number;
      readonly prefixSegments: readonly string[];
    };
  };
  readonly placement: PlacementSemantics;
  readonly type: string;
}

export interface AuthoringProfileSemantics {
  readonly authoring: {
    readonly artifactTypes: readonly ArtifactTypeSemantics[];
  };
}

export type AuthoringProfileSemanticProblem =
  | "duplicate-artifact-type"
  | "incompatible-identity-placement"
  | "invalid-qualified-grammar-range"
  | "overlapping-placement-roots"
  | "portable-root-collision";

export class AuthoringProfileSemanticError extends Error {
  readonly problem: AuthoringProfileSemanticProblem;

  constructor(problem: AuthoringProfileSemanticProblem) {
    super(`Document authoring profile has invalid semantics: ${problem}.`);
    this.name = "AuthoringProfileSemanticError";
    this.problem = problem;
  }
}

function portableAsciiIdentity(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function isSegmentBoundaryPrefix(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function hasCompatibleIdentityPlacement(artifactType: ArtifactTypeSemantics): boolean {
  const placement = artifactType.placement;
  if (placement.kind === "qualified-leaf-index") {
    return artifactType.identity?.format === "qualified";
  }
  if (placement.kind === "collection" && placement.filename === "numeric-id-slug") {
    return artifactType.identity?.format === "adr-four-digits";
  }
  return true;
}

export function assertAuthoringProfileSemantics(profile: AuthoringProfileSemantics): void {
  const types = new Set<string>();
  for (const artifactType of profile.authoring.artifactTypes) {
    const typeIdentity = portableAsciiIdentity(artifactType.type);
    if (types.has(typeIdentity)) {
      throw new AuthoringProfileSemanticError("duplicate-artifact-type");
    }
    types.add(typeIdentity);

    const grammar = artifactType.identity?.grammar;
    if (
      grammar !== undefined &&
      grammar.minSuffixSegments > grammar.maxSuffixSegments
    ) {
      throw new AuthoringProfileSemanticError("invalid-qualified-grammar-range");
    }

    const placement = artifactType.placement;
    if (!hasCompatibleIdentityPlacement(artifactType)) {
      throw new AuthoringProfileSemanticError("incompatible-identity-placement");
    }
    const roots = placement.kind === "qualified-leaf-index"
      ? (placement.root === undefined ? [] : [placement.root])
      : [...(placement.allowedRoots ?? [])];
    const identities = roots.map(portableAsciiIdentity);
    for (const [index, root] of roots.entries()) {
      if (!isDocumentRepositoryPath(root)) {
        throw new AuthoringProfileSemanticError("portable-root-collision");
      }
      for (let other = 0; other < index; other += 1) {
        const previous = identities[other];
        const current = identities[index];
        if (previous === undefined || current === undefined) {
          continue;
        }
        if (previous === current) {
          throw new AuthoringProfileSemanticError("portable-root-collision");
        }
        if (
          isSegmentBoundaryPrefix(previous, current) ||
          isSegmentBoundaryPrefix(current, previous)
        ) {
          throw new AuthoringProfileSemanticError("overlapping-placement-roots");
        }
      }
    }
  }
}

export function matchingPlacementRoot(
  repositoryPath: string,
  allowedRoots: readonly string[]
): string | undefined {
  const matches = allowedRoots.filter((root) =>
    isSegmentBoundaryPrefix(root, repositoryPath)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function hasContiguousRequiredSegments(
  repositoryPath: string,
  requiredSegments: readonly string[],
  matchedRoot?: string
): boolean {
  if (requiredSegments.length === 0) {
    return true;
  }
  const rootIdentity = matchedRoot;
  if (
    rootIdentity !== undefined &&
    !isSegmentBoundaryPrefix(rootIdentity, repositoryPath)
  ) {
    return false;
  }
  const suffix = rootIdentity === undefined
    ? repositoryPath
    : repositoryPath.slice(rootIdentity.length).replace(/^\//u, "");
  const segments = suffix.split("/");
  return segments.some((_segment, start) =>
    requiredSegments.every((segment, offset) => segments[start + offset] === segment)
  );
}

export function isRepositoryPathAllowedByPlacement(
  repositoryPath: string,
  placement: PlacementSemantics
): boolean {
  if (!isDocumentRepositoryPath(repositoryPath)) {
    return false;
  }
  const segments = repositoryPath.split("/");
  const basename = segments.at(-1);
  if (basename !== placement.requiredBasename) {
    return false;
  }
  if (placement.kind === "qualified-leaf-index") {
    if (placement.root === undefined) {
      return false;
    }
    const rootSegments = placement.root.split("/");
    return isSegmentBoundaryPrefix(placement.root, repositoryPath) &&
      segments.length > rootSegments.length + 1;
  }
  if (placement.kind !== "explicit") {
    return false;
  }
  const root = matchingPlacementRoot(repositoryPath, placement.allowedRoots ?? []);
  const required = placement.requiredSegmentsInOrder ?? [];
  if (
    root === undefined ||
    required.length === 0 ||
    placement.minimumSegmentsBeforeRequired === undefined ||
    placement.minimumSegmentsAfterRequired === undefined
  ) {
    return false;
  }
  const suffix = repositoryPath.slice(root.length + 1).split("/");
  const directories = suffix.slice(0, -1);
  return directories.some((_segment, start) =>
    start >= placement.minimumSegmentsBeforeRequired! &&
    directories.length - start - required.length >=
      placement.minimumSegmentsAfterRequired! &&
    required.every((segment, offset) => directories[start + offset] === segment)
  );
}
