import type {
  DocumentArtifactType,
  DocumentReachabilityStrategy
} from "../model/document-planning.js";
import { isDocumentRepositoryPath } from "./document-repository-path.js";
import { isRepositoryPathAllowedByPlacement } from "./authoring-profile-semantics.js";
import { DocumentPlanningPolicyError } from "./document-planning-policy-error.js";

export type DocumentReachabilityProjection =
  | {
      readonly state: "manual-required";
      readonly indexPath: string;
      readonly markdownLink: string;
    }
  | { readonly state: "not-required" };

function markdownLinkLabel(heading: string): string {
  return heading.replace(/\\/gu, "\\\\").replace(/\[/gu, "\\[").replace(/\]/gu, "\\]");
}

function relativeRepositoryPath(fromFile: string, toFile: string): string {
  const from = fromFile.split("/").slice(0, -1);
  const to = toFile.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) {
    shared += 1;
  }
  return [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/");
}

function colocatedIndexPath(
  artifact: DocumentArtifactType,
  destination: string,
  strategy: Extract<DocumentReachabilityStrategy, { readonly kind: "manual-colocated-index" }>
): string {
  if (artifact.placement.kind !== "explicit") {
    throw new DocumentPlanningPolicyError(
      "invalid-destination",
      "Colocated reachability requires explicit placement authority."
    );
  }
  if (!isRepositoryPathAllowedByPlacement(destination, artifact.placement)) {
    throw new DocumentPlanningPolicyError(
      "invalid-destination",
      "Colocated reachability destination is outside explicit placement authority."
    );
  }
  const destinationSegments = destination.split("/");
  const directorySegments = destinationSegments.slice(0, -1);
  const required = artifact.placement.requiredSegmentsInOrder;
  const starts = directorySegments.flatMap((_segment, start) =>
    required.every((segment, offset) => directorySegments[start + offset] === segment)
      ? [start]
      : []
  );
  if (starts.length !== 1 || starts[0] === 0) {
    throw new DocumentPlanningPolicyError(
      "invalid-destination",
      "Colocated reachability cannot project a unique index prefix."
    );
  }
  return `${directorySegments.slice(0, starts[0]).join("/")}/${strategy.indexBasename}`;
}

export function projectDocumentReachability(input: {
  readonly artifact: DocumentArtifactType;
  readonly destination: string;
  readonly heading: string;
}): DocumentReachabilityProjection {
  const strategy = input.artifact.reachability;
  if (strategy.kind === "not-required") {
    return Object.freeze({ state: "not-required" });
  }
  const indexPath = strategy.kind === "manual-fixed-index"
    ? strategy.indexPath
    : colocatedIndexPath(input.artifact, input.destination, strategy);
  if (
    !isDocumentRepositoryPath(indexPath) ||
    !isDocumentRepositoryPath(input.destination) ||
    indexPath === input.destination ||
    input.heading.length === 0 ||
    /[\r\n\0]/u.test(input.heading) ||
    input.heading.normalize("NFC") !== input.heading
  ) {
    throw new DocumentPlanningPolicyError(
      "invalid-destination",
      "Document reachability projection is invalid."
    );
  }
  const relative = relativeRepositoryPath(indexPath, input.destination);
  return Object.freeze({
    state: "manual-required",
    indexPath,
    markdownLink: `[${markdownLinkLabel(input.heading)}](${relative})`
  });
}
