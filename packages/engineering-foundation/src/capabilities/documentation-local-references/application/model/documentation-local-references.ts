import type {
  MarkdownAnchorProfile,
  MarkdownReferenceObservation,
  MarkdownReferenceResolution,
  MarkdownRepositoryObservation
} from "@agent-teams/document-authoring/observation";

export interface DocumentationLocalReferencesPolicy {
  readonly anchorProfile: MarkdownAnchorProfile;
  readonly markdownRoots: readonly string[];
}

export interface ResolvedMarkdownReferenceObservation {
  readonly reference: MarkdownReferenceObservation;
  readonly resolution: MarkdownReferenceResolution;
  readonly sourcePath: string;
}

export interface DocumentationLocalReferencesObservation {
  readonly repository: MarkdownRepositoryObservation;
  readonly resolvedReferences: readonly ResolvedMarkdownReferenceObservation[];
}
