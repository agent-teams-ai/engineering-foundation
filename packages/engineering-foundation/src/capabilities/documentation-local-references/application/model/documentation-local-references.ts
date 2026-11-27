import type {
  MarkdownAnchorProfile,
  MarkdownReferenceObservation,
  MarkdownReferenceResolution,
  MarkdownRepositoryObservation,
} from "@agent-teams/document-authoring/observation";

export interface HistoricalMarkdownReference {
  readonly kind: MarkdownReferenceObservation["kind"];
  readonly line: number;
  readonly column: number;
  readonly rawTarget: string;
}

export interface HistoricalMarkdownArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly references: readonly HistoricalMarkdownReference[];
}

export interface DocumentationLocalReferencesPolicy {
  readonly anchorProfile: MarkdownAnchorProfile;
  readonly markdownRoots: readonly string[];
  readonly historicalArtifacts?: readonly HistoricalMarkdownArtifact[];
}

export interface ResolvedMarkdownReferenceObservation {
  readonly reference: MarkdownReferenceObservation;
  readonly resolution: MarkdownReferenceResolution;
  readonly sourcePath: string;
}

export interface DocumentationLocalReferencesObservation {
  readonly repository: MarkdownRepositoryObservation;
  readonly resolvedReferences: readonly ResolvedMarkdownReferenceObservation[];
  readonly sourceDigests: ReadonlyMap<string, string>;
}
