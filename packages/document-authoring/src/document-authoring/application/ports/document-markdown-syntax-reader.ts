interface DocumentMarkdownSyntaxObservation {
  readonly depth?: number;
  readonly lang?: string | null;
  readonly meta?: string | null;
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
}

export type DocumentMarkdownSyntaxReader = (
  source: string,
  kind: "code" | "heading"
) => readonly DocumentMarkdownSyntaxObservation[];
