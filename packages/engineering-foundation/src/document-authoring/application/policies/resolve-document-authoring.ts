import type {
  DocumentArtifactType,
  DocumentIntent,
  DocumentPlanningProfileSnapshot
} from "../model/document-planning.js";
import { isDocumentRepositoryPath } from "./document-repository-path.js";
import { DocumentPlanningPolicyError } from "./document-planning-policy-error.js";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const QUALIFIED_SEGMENT = /^[a-z][a-z0-9-]*$/u;

export interface ResolvedDocumentAuthoring {
  readonly artifact: DocumentArtifactType;
  readonly destination: string;
  readonly heading: string;
  readonly slug?: string;
}

export function selectDocumentArtifact(
  profile: DocumentPlanningProfileSnapshot,
  type: string
): DocumentArtifactType {
  const matches = profile.artifactTypes.filter((artifact) => artifact.type === type);
  if (matches.length !== 1) {
    throw new DocumentPlanningPolicyError(
      "invalid-artifact-type",
      `Document type must select exactly one artifact: ${type}.`
    );
  }
  return matches[0]!;
}

function derivedSlug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function resolveSlug(intent: DocumentIntent): string {
  const slug = intent.slug ?? derivedSlug(intent.title);
  if (!SLUG.test(slug)) {
    throw new DocumentPlanningPolicyError(
      intent.slug === undefined ? "missing-slug" : "invalid-slug",
      "Document collection placement requires a valid non-empty filename slug."
    );
  }
  return slug;
}

function assertIdentity(artifact: DocumentArtifactType, id: string): readonly string[] {
  const identity = artifact.identity;
  if (identity.format === "adr-four-digits") {
    if (!/^ADR-[0-9]{4}$/u.test(id)) {
      throw new DocumentPlanningPolicyError("invalid-identity", "Document ID is not ADR-NNNN.");
    }
    return [];
  }
  if (identity.format === "open-decision-three-digits") {
    if (!/^OD-[0-9]{3}$/u.test(id)) {
      throw new DocumentPlanningPolicyError("invalid-identity", "Document ID is not OD-NNN.");
    }
    return [];
  }
  if (!("grammar" in identity)) {
    throw new DocumentPlanningPolicyError("invalid-identity", "Document identity format is unsupported.");
  }
  const segments = id.split(".");
  const grammar = identity.grammar;
  const prefix = grammar.prefixSegments;
  const suffix = segments.slice(prefix.length);
  if (
    prefix.length === 0 ||
    prefix.some((segment) => !QUALIFIED_SEGMENT.test(segment)) ||
    grammar.minSuffixSegments < 1 ||
    grammar.minSuffixSegments > grammar.maxSuffixSegments ||
    segments.some((segment) => !QUALIFIED_SEGMENT.test(segment)) ||
    prefix.some((segment, index) => segments[index] !== segment) ||
    suffix.length < grammar.minSuffixSegments ||
    suffix.length > grammar.maxSuffixSegments
  ) {
    throw new DocumentPlanningPolicyError(
      "invalid-identity",
      "Document ID does not match its qualified identity grammar."
    );
  }
  return suffix;
}

function assertNoDestination(intent: DocumentIntent): void {
  if (intent.destination !== undefined) {
    throw new DocumentPlanningPolicyError(
      "invalid-destination",
      "Selected placement forbids an explicit destination."
    );
  }
}

function collectionDestination(
  artifact: DocumentArtifactType,
  intent: DocumentIntent
): { readonly destination: string; readonly slug?: string } {
  const placement = artifact.placement;
  if (placement.kind !== "collection") {
    throw new DocumentPlanningPolicyError("invalid-destination", "Invalid collection placement.");
  }
  assertNoDestination(intent);
  if (placement.filename === "README.md") {
    if (intent.slug !== undefined) {
      throw new DocumentPlanningPolicyError("invalid-slug", "README placement forbids a slug.");
    }
    return { destination: `${placement.directory}/README.md` };
  }
  const slug = resolveSlug(intent);
  const basename = placement.filename === "numeric-id-slug"
    ? `${intent.id.slice(4)}-${slug}.md`
    : placement.filename === "id-slug"
      ? `${intent.id}-${slug}.md`
      : `${slug}.md`;
  return { destination: `${placement.directory}/${basename}`, slug };
}

function isPrefix(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function explicitDestination(
  artifact: DocumentArtifactType,
  intent: DocumentIntent
): string {
  const placement = artifact.placement;
  if (placement.kind !== "explicit") {
    throw new DocumentPlanningPolicyError("invalid-destination", "Invalid explicit placement.");
  }
  if (intent.slug !== undefined) {
    throw new DocumentPlanningPolicyError("invalid-slug", "Explicit placement forbids a slug.");
  }
  const destination = intent.destination;
  if (destination === undefined) {
    throw new DocumentPlanningPolicyError(
      "missing-destination",
      "Explicit placement requires a destination."
    );
  }
  const matchedRoots = placement.allowedRoots.filter((root) => isPrefix(root, destination));
  const segments = destination.split("/");
  if (
    !isDocumentRepositoryPath(destination) ||
    matchedRoots.length !== 1 ||
    segments.at(-1) !== placement.requiredBasename
  ) {
    throw new DocumentPlanningPolicyError("invalid-destination", "Destination is outside explicit placement authority.");
  }
  const root = matchedRoots[0]!;
  const directories = segments.slice(root.split("/").length, -1);
  const required = placement.requiredSegmentsInOrder;
  const validSequence = directories.some((_segment, start) =>
    start >= placement.minimumSegmentsBeforeRequired &&
    directories.length - start - required.length >= placement.minimumSegmentsAfterRequired &&
    required.every((segment, offset) => directories[start + offset] === segment)
  );
  if (!validSequence) {
    throw new DocumentPlanningPolicyError("invalid-destination", "Destination does not satisfy the explicit placement shape.");
  }
  return destination;
}

export function resolveDocumentAuthoring(input: {
  readonly artifact: DocumentArtifactType;
  readonly intent: DocumentIntent;
}): ResolvedDocumentAuthoring {
  const { artifact, intent } = input;
  const suffix = assertIdentity(artifact, intent.id);
  let resolution: { readonly destination: string; readonly slug?: string };
  if (artifact.placement.kind === "collection") {
    if (
      artifact.placement.filename === "numeric-id-slug" &&
      artifact.identity.format !== "adr-four-digits"
    ) {
      throw new DocumentPlanningPolicyError("invalid-identity", "Numeric filename placement requires ADR identity.");
    }
    resolution = collectionDestination(artifact, intent);
  } else if (artifact.placement.kind === "qualified-leaf-index") {
    if (artifact.identity.format !== "qualified") {
      throw new DocumentPlanningPolicyError("invalid-identity", "Qualified leaf placement requires qualified identity.");
    }
    assertNoDestination(intent);
    if (intent.slug !== undefined) {
      throw new DocumentPlanningPolicyError("invalid-slug", "Qualified leaf placement forbids a slug.");
    }
    resolution = {
      destination: `${artifact.placement.root}/${suffix.join("/")}/${artifact.placement.requiredBasename}`
    };
  } else {
    resolution = { destination: explicitDestination(artifact, intent) };
  }
  if (!isDocumentRepositoryPath(resolution.destination)) {
    throw new DocumentPlanningPolicyError("invalid-destination", "Resolved destination is not a portable repository path.");
  }
  return Object.freeze({
    artifact,
    destination: resolution.destination,
    heading: artifact.heading.kind === "title" ? intent.title : `${intent.id}: ${intent.title}`,
    ...(resolution.slug === undefined ? {} : { slug: resolution.slug })
  });
}
