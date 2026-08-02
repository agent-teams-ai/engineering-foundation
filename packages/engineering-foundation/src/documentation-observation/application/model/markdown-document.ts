export type MarkdownAnchorProfile = "github" | "none";

export type MarkdownReferenceKind = "definition" | "image" | "link";

export interface MarkdownPosition {
  readonly column: number;
  readonly line: number;
  readonly offset: number;
}

export interface MarkdownHeadingObservation {
  readonly depth: number;
  readonly location: MarkdownPosition;
  readonly text: string;
}

export interface MarkdownReferenceObservation {
  readonly kind: MarkdownReferenceKind;
  readonly location: MarkdownPosition;
  readonly rawTarget: string;
}

export type MarkdownFrontmatterObservation =
  | {
      readonly endOffset: 0;
      readonly kind: "absent";
    }
  | {
      readonly endOffset: number;
      readonly kind: "invalid";
      readonly message: string;
    }
  | {
      readonly endOffset: number;
      readonly kind: "valid";
      readonly value: unknown;
    };

export interface MarkdownDocumentObservation {
  readonly frontmatter: MarkdownFrontmatterObservation;
  readonly headings: readonly MarkdownHeadingObservation[];
  readonly references: readonly MarkdownReferenceObservation[];
  readonly repositoryPath: string;
  readonly source: string;
}

export type MarkdownObservationIssueKind =
  | "root-missing"
  | "root-not-directory"
  | "source-too-large"
  | "source-unreadable"
  | "symbolic-link";

export interface MarkdownObservationIssue {
  readonly kind: MarkdownObservationIssueKind;
  readonly message: string;
  readonly repositoryPath: string;
}

export interface MarkdownRepositoryObservation {
  readonly documents: readonly MarkdownDocumentObservation[];
  readonly issues: readonly MarkdownObservationIssue[];
}

export type MarkdownReferenceResolution =
  | {
      readonly kind: "external";
    }
  | {
      readonly kind: "file";
      readonly markdownDocument?: MarkdownDocumentObservation;
      readonly repositoryPath: string;
      readonly fragment: string;
    }
  | {
      readonly kind: "missing";
      readonly reason: "directory-readme-missing" | "target-missing";
      readonly repositoryPath: string;
    }
  | {
      readonly kind: "unsafe";
      readonly reason:
        | "absolute-path"
        | "invalid-encoding"
        | "repository-escape"
        | "symbolic-link";
    };

function removeMarkdownInlineSyntax(value: string): string {
  return value
    .replace(/!?(?:\[([^\]]*)\])(?:\([^)]*\)|\[[^\]]*\])?/gu, "$1")
    .replace(/<[^>]*>/gu, "")
    .replace(/[`*_~]/gu, "")
    .replace(/\\(.)/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function githubSlug(value: string): string {
  return removeMarkdownInlineSyntax(value)
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/gu, "-");
}

export function anchorsForMarkdownDocument(
  document: MarkdownDocumentObservation,
  profile: MarkdownAnchorProfile
): readonly string[] {
  if (profile === "none") {
    return [];
  }

  const counts = new Map<string, number>();
  return document.headings.map((heading) => {
    const base = githubSlug(heading.text);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  });
}

export function markdownSourceWithoutFrontmatter(
  document: MarkdownDocumentObservation
): string {
  return document.source.slice(document.frontmatter.endOffset);
}
