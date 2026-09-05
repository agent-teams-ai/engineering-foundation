/** Parser-independent positions and fields used by governed template inspection. */
export interface MarkdownSyntaxObservation {
  readonly depth?: number;
  readonly lang?: string | null;
  readonly meta?: string | null;
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
}
export type MarkdownSyntaxReader = (source: string, kind: "code" | "heading") => readonly MarkdownSyntaxObservation[];
