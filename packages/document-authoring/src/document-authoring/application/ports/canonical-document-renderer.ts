interface CanonicalFrontmatterArray
  extends ReadonlyArray<CanonicalFrontmatterValue> {}

interface CanonicalFrontmatterMap
  extends Readonly<Record<string, CanonicalFrontmatterValue>> {}

export type CanonicalFrontmatterValue =
  | null
  | boolean
  | number
  | string
  | CanonicalFrontmatterArray
  | CanonicalFrontmatterMap;

export interface CanonicalFrontmatter {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly owner: string;
  readonly summary: string;
  readonly related?: readonly string[];
  readonly additionalMetadata?: Readonly<Record<string, CanonicalFrontmatterValue>>;
}

export interface GovernedTemplateSkeleton {
  readonly placeholderHeading: string;
  readonly body: string;
}

export interface CanonicalDocumentInput {
  readonly frontmatter: CanonicalFrontmatter;
  readonly heading: string;
  readonly template: GovernedTemplateSkeleton;
}

export interface CanonicalDocumentRenderer {
  parseTemplate(source: string): GovernedTemplateSkeleton;
  render(input: CanonicalDocumentInput): string;
}
